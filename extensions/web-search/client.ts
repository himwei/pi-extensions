/**
 * DeepSeek Search/Fetch API client for the web-search extension.
 *
 * Billing: 5 CNY per 1000 successful calls (0.005/call); failed and empty
 * results are not billed. Retries follow the documented policy: 408/429/5xx
 * are retried with backoff, other 4xx are not.
 *
 * Credentials resolution (first hit wins):
 *   1. .env in this extension's folder (base_url=..., api_key=...)
 *   2. pi's auth.json `deepseek` entry (readStoredCredential)
 * The API key is never included in errors, logs, or tool details.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";

export const PRICE_PER_CALL_CNY = 0.005;
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DAILY_LIMIT = 300;
const AUTH_PROVIDER_ID = "deepseek";
const REQUEST_TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [500, 1000];
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 50;

export interface SearchResult {
  rerank_score: number;
  authority: number;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  site_name: string | null;
  date: string | null;
}

export interface FetchResult {
  title: string;
  content: string;
}

export interface SearchDetails {
  query: string;
  count: number;
  results: SearchResult[];
  /** mirrors[i] = 1-based index of the first result with the same page identity, 0 if not a duplicate. */
  mirrors: number[];
  ms: number;
  cached: boolean;
  costCny: number;
}

export interface ClientStats {
  billed: number;
  cacheHits: number;
  retries: number;
  lastError: string | null;
  dailyLimit: number;
}

/** Error with the HTTP status so callers can branch on billing-relevant codes. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Daily call limit reached; the message is model- and user-facing. */
export class LimitError extends Error {
  constructor(limit: number) {
    super(`web-search daily limit reached (${limit} billed calls). Raise PI_WEBSEARCH_DAILY_LIMIT or retry tomorrow.`);
    this.name = "LimitError";
  }
}

/** Parse KEY=VALUE lines; `#` starts a comment (also after an unquoted value), blank lines are skipped. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

/** Read the extension folder's own .env (web-search/.env); missing file is empty. */
export function readExtEnvFile(): Record<string, string> {
  try {
    return parseEnvText(readFileSync(fileURLToPath(new URL(".env", import.meta.url)), "utf-8"));
  } catch {
    return {};
  }
}

export function validateUrl(raw: string): URL {
  if (raw.length > 8192) throw new ApiError(400, "URL exceeds 8192 characters");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, `Invalid URL: ${raw.slice(0, 100)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(400, `Only http/https URLs are supported: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new ApiError(400, "URLs with embedded credentials are not allowed");
  }
  return url;
}

/** TTL cache for exact query+count repeats; hits cost nothing. */
export class SearchCache {
  private map = new Map<string, { at: number; value: SearchDetails }>();
  constructor(
    private ttlMs = CACHE_TTL_MS,
    private maxEntries = CACHE_MAX_ENTRIES,
    private now: () => number = Date.now,
  ) {}

  get(key: string): SearchDetails | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: SearchDetails): void {
    this.map.set(key, { at: this.now(), value });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value as string);
    }
  }
}

const statusMessage: Record<number, string> = {
  402: "DeepSeek account balance insufficient (402): top up at the DeepSeek platform, then retry.",
  429: "Rate limited (429): retrying with backoff.",
};

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });

export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  dailyLimit?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Credential reader override; defaults to pi's readStoredCredential. */
  readCredential?: (providerId: string) => { type: string; key?: string } | undefined;
  /** Extension .env reader override; defaults to reading web-search/.env. */
  readEnvFile?: () => Record<string, string>;
}

export class SearchClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Where the active key came from: "file" | "auth.json". */
  readonly credentialSource: "file" | "auth.json" | undefined;
  private cache: SearchCache;
  private billed = 0;
  private cacheHits = 0;
  private retries = 0;
  private lastError: string | null = null;

  constructor(opts: ClientOptions = {}) {
    const env = resolveCredentials(opts.readCredential, opts.readEnvFile);
    this.baseUrl = (opts.baseUrl ?? env.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? env.apiKey ?? "";
    this.credentialSource = env.source === "file" || env.source === "auth.json" ? env.source : undefined;
    this.dailyLimit = opts.dailyLimit ?? resolveDailyLimit();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.cache = new SearchCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES, this.now);
    if (!this.apiKey) {
      this.lastError = "no API key: web-search/.env or a deepseek api_key credential in auth.json";
    }
  }

  readonly dailyLimit: number;

  stats(): ClientStats {
    return { billed: this.billed, cacheHits: this.cacheHits, retries: this.retries, lastError: this.lastError, dailyLimit: this.dailyLimit };
  }

  private assertReady(): void {
    if (!this.apiKey) throw new ApiError(401, `web-search is not configured: ${this.lastError}`);
    if (this.dailyLimit > 0 && this.billed >= this.dailyLimit) throw new LimitError(this.dailyLimit);
  }
  private async request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    let timeout: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    if (signal) timeout = AbortSignal.any([timeout, signal]);
    let lastErr: ApiError = new ApiError(500, "unreachable");
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1], signal);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: timeout,
        });
      } catch (e) {
        lastErr = new ApiError(504, `network error: ${(e as Error).message}`);
        this.retries++;
        continue;
      }
      if (res.ok) {
        this.lastError = null;
        return (await res.json()) as T;
      }
      const text = await res.text();
      let message = text;
      let requestId: string | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; type?: string }; request_id?: string };
        message = parsed.error?.message ?? message;
        requestId = parsed.request_id;
      } catch {
        /* keep raw text */
      }
      lastErr = new ApiError(res.status, statusMessage[res.status] ?? `${message} (HTTP ${res.status})`, requestId);
      if (!isRetryable(res.status)) break;
      this.retries++;
    }
    this.lastError = lastErr.message;
    throw lastErr;
  }

  async search(query: string, count = 5, signal?: AbortSignal): Promise<SearchDetails> {
    this.assertReady();
    const key = `${count}\u0000${query}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cacheHits++;
      return { ...hit, cached: true, ms: 0 };
    }
    const t0 = this.now();
    const body = await this.request<{ results?: SearchResult[] }>("/v1/tools/search", { query, count, need_content: false }, signal);
    const results = body.results ?? [];
    const details: SearchDetails = {
      query,
      count,
      results,
      mirrors: mirrorOf(results),
      ms: this.now() - t0,
      cached: false,
      costCny: PRICE_PER_CALL_CNY,
    };
    if (results.length > 0) {
      this.billed++;
      this.cache.set(key, details);
    }
    return details;
  }

  async fetchPage(url: string, signal?: AbortSignal): Promise<FetchResult & { costCny: number }> {
    this.assertReady();
    validateUrl(url);
    const body = await this.request<FetchResult>("/v1/tools/fetch", { url }, signal);
    this.billed++;
    return { ...body, costCny: PRICE_PER_CALL_CNY };
  }
}

/**
 * Page identity for mirror detection: `exec(3)`, `exec.3`, and `.../man3/exec.3`
 * all reduce to `exec#3`; different hosts without an identity pattern are never
 * merged.
 */
export function pageIdentity(r: { title: string; url: string }): string {
  const t = `${r.title} ${r.url}`;
  const m = t.match(/([a-z0-9_+-]{2,})\((\d[a-z]?)\)/i) ?? t.match(/\/?([a-z0-9_+-]{2,})\.(\d[a-z]?)(?:[.\s/#]|$)/i);
  if (m) return `${m[1].toLowerCase()}#${m[2]}`;
  return `host:${new URL(r.url).hostname}`;
}

/** mirrors[i] = 1-based first-seen index of the same identity, 0 when unique. */
export function mirrorOf(results: { title: string; url: string }[]): number[] {
  const first = new Map<string, number>();
  return results.map((r, i) => {
    const id = pageIdentity(r);
    const seen = first.get(id);
    if (seen !== undefined) return seen + 1;
    first.set(id, i);
    return 0;
  });
}


/** Resolve credentials: extension-folder .env overrides pi auth.json `deepseek` entry. */
export function resolveCredentials(
  readCred: (providerId: string) => { type: string; key?: string } | undefined = (id) => {
    try {
      return readStoredCredential(id);
    } catch {
      return undefined;
    }
  },
  readEnvFile: () => Record<string, string> = readExtEnvFile,
): { apiKey?: string; baseUrl?: string; source: "file" | "auth.json" | "none" } {
  let stored: { type: string; key?: string } | undefined;
  try {
    stored = readCred(AUTH_PROVIDER_ID);
  } catch {
    stored = undefined; // a corrupt or unreadable store must not break the extension
  }
  const storedKey = stored?.type === "api_key" ? stored.key : undefined;
  let file: Record<string, string>;
  try {
    file = readEnvFile();
  } catch {
    file = {};
  }
  const fileKey = file.api_key ?? file.apikey;
  const apiKey = fileKey ?? storedKey;
  const baseUrl = file.base_url ?? file.baseUrl;
  return { apiKey, baseUrl, source: fileKey ? "file" : storedKey ? "auth.json" : "none" };
}

function resolveDailyLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_WEBSEARCH_DAILY_LIMIT;
  const parsed = raw !== undefined && raw !== "" ? Number.parseInt(raw, 10) : DEFAULT_DAILY_LIMIT;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DAILY_LIMIT;
}
