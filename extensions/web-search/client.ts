/**
 * DeepSeek Search/Fetch API client for the web-search extension.
 *
 * Billing: 5 CNY per 1000 successful calls (0.005/call); failed and empty
 * results are not billed. Retries follow the documented policy: 408/429/5xx
 * are retried with backoff, other 4xx are not.
 *
 * Credentials resolution (first hit wins):
 *   1. config/pi-extensions/.env.web-search under Pi's agent directory
 *   2. Legacy .env in this extension's folder (base_url=..., api_key=...)
 *   3. pi's auth.json `deepseek` entry (readStoredCredential)
 * The API key is never included in errors, logs, or tool details.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ApiError, validateUrl, responseText, searchResults, fetchResult } from "./response.js";
export { ApiError, validateUrl } from "./response.js";

export const PRICE_PER_CALL_CNY = 0.005;
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DAILY_LIMIT = 300;
const AUTH_PROVIDER_ID = "deepseek";
const REQUEST_TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [500, 1000];
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 50;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;

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
  dailyBilled: number;
  dailyPending: number;
  day: string;
}
export interface ServiceCharge { id: string; kind: "search" | "fetch"; amountCny: number }

/** Daily call limit reached; the message is model- and user-facing. */
export class LimitError extends Error {
  constructor(limit: number) {
    super(`web-search daily limit reached (${limit} billed or pending calls in this Pi process). Raise PI_WEBSEARCH_DAILY_LIMIT or retry tomorrow.`);
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

function readEnvPath(path: string): Record<string, string> {
  try {
    return parseEnvText(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/** Legacy configuration for manual installs. */
export function readExtEnvFile(): Record<string, string> {
  return readEnvPath(fileURLToPath(new URL(".env", import.meta.url)));
}

/** Personal configuration stays outside the checkout managed by Pi updates. */
export function readConfigEnvFile(
  userPath = join(getAgentDir(), "config", "pi-extensions", ".env.web-search"),
  legacyPath = fileURLToPath(new URL(".env", import.meta.url)),
): Record<string, string> {
  const legacy = readEnvPath(legacyPath);
  const user = readEnvPath(userPath);
  const key = user.api_key ?? user.apikey;
  const baseUrl = user.base_url ?? user.baseUrl;
  return {
    ...legacy,
    ...user,
    ...(key !== undefined ? { api_key: key } : {}),
    ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
  };
}

/** Session cache with TTL, entry count and an approximate UTF-16 byte budget. */
class TtlCache<T> {
  private map = new Map<string, { at: number; value: T; bytes: number }>();
  private bytes = 0;
  constructor(
    private ttlMs = CACHE_TTL_MS,
    private maxEntries = CACHE_MAX_ENTRIES,
    private now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.bytes -= hit.bytes;
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    const bytes = JSON.stringify(value).length * 2 + key.length * 2;
    if (bytes > CACHE_MAX_BYTES) return;
    this.bytes -= this.map.get(key)?.bytes ?? 0;
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value, bytes });
    this.bytes += bytes;
    while (this.map.size > this.maxEntries || this.bytes > CACHE_MAX_BYTES) {
      const oldest = this.map.keys().next().value as string;
      this.bytes -= this.map.get(oldest)!.bytes;
      this.map.delete(oldest);
    }
  }
}

/** TTL cache for exact query+count repeats; hits cost nothing. */
export class SearchCache extends TtlCache<SearchDetails> {}

const statusMessage: Record<number, string> = {
  402: "DeepSeek account balance insufficient (402): top up at the DeepSeek platform, then retry.",
  429: "Rate limited (429): retrying with backoff.",
};

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  dailyLimit?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Credential reader override; defaults to pi's readStoredCredential. */
  readCredential?: (providerId: string) => { type: string; key?: string } | undefined;
  /** File configuration override; defaults to personal config over legacy extension .env. */
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
  private pages: TtlCache<FetchResult>;
  private daily?: { day: string; billed: number; pending: number };
  private billed = 0;
  private cacheHits = 0;
  private retries = 0;
  private lastError: string | null = null;
  private chargeListeners = new Set<(charge: ServiceCharge) => void>();

  constructor(opts: ClientOptions = {}) {
    const env = resolveCredentials(opts.readCredential, opts.readEnvFile);
    this.baseUrl = (opts.baseUrl ?? env.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? env.apiKey ?? "";
    this.credentialSource = env.source === "file" || env.source === "auth.json" ? env.source : undefined;
    this.dailyLimit = opts.dailyLimit ?? resolveDailyLimit();
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.cache = new SearchCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES, this.now);
    this.pages = new TtlCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES, this.now);
    if (!this.apiKey) {
      this.lastError = "no API key: config/pi-extensions/.env.web-search, legacy web-search/.env or a deepseek api_key credential in auth.json";
    }
  }

  readonly dailyLimit: number;

  stats(): ClientStats {
    const today = this.today();
    return { billed: this.billed, cacheHits: this.cacheHits, retries: this.retries, lastError: this.lastError,
      dailyLimit: this.dailyLimit, dailyBilled: today.billed, dailyPending: today.pending, day: today.day };
  }

  clearCache(): void {
    this.cache = new SearchCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES, this.now);
    this.pages = new TtlCache(CACHE_TTL_MS, CACHE_MAX_ENTRIES, this.now);
  }

  onCharge(listener: (charge: ServiceCharge) => void): () => void {
    this.chargeListeners.add(listener);
    return () => { this.chargeListeners.delete(listener); };
  }

  private charge(kind: ServiceCharge["kind"]): void {
    this.billed++;
    const charge = { id: randomUUID(), kind, amountCny: PRICE_PER_CALL_CNY };
    for (const listener of this.chargeListeners) listener(charge);
  }

  private today() {
    const date = new Date(this.now());
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (this.daily?.day !== day) this.daily = { day, billed: 0, pending: 0 };
    return this.daily;
  }

  /** Reserve before dispatch so parallel misses cannot all pass the final slot. */
  private reserve(): (charged: boolean) => void {
    if (!this.apiKey) throw new ApiError(401, `web-search is not configured: ${this.lastError}`);
    const bucket = this.today();
    if (this.dailyLimit > 0 && bucket.billed + bucket.pending >= this.dailyLimit) throw new LimitError(this.dailyLimit);
    bucket.pending++;
    let settled = false;
    return charged => {
      if (settled) return;
      settled = true;
      bucket.pending--;
      if (charged) bucket.billed++;
    };
  }
  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
    let lastErr: ApiError = new ApiError(500, "unreachable");
    try {
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        requestSignal.throwIfAborted();
        if (attempt > 0) {
          await delay(RETRY_DELAYS_MS[attempt - 1], undefined, { signal: requestSignal });
          requestSignal.throwIfAborted();
          this.retries++;
        }
        let res: Response;
        try {
          res = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body),
            signal: requestSignal,
          });
        } catch (e) {
          requestSignal.throwIfAborted();
          lastErr = new ApiError(504, `network error: ${(e as Error).message}`);
          continue;
        }
        requestSignal.throwIfAborted();
        const text = await responseText(res, requestSignal);
        if (res.ok) {
          let value: unknown;
          try { value = JSON.parse(text); }
          catch { throw new ApiError(502, "web-search response is not valid JSON"); }
          requestSignal.throwIfAborted();
          this.lastError = null;
          return value;
        }
        requestSignal.throwIfAborted();
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
      }
      this.lastError = lastErr.message;
      throw lastErr;
    } catch (error) {
      // User/session cancellation is terminal, including while reading a body or backing off.
      signal?.throwIfAborted();
      if (deadline.aborted) {
        const expired = new ApiError(504, "web-search request timed out");
        this.lastError = expired.message;
        throw expired;
      }
      throw error;
    }
  }

  async search(query: string, count = 5, signal?: AbortSignal): Promise<SearchDetails> {
    signal?.throwIfAborted();
    const key = `${count}\u0000${query}`;
    const cache = this.cache;
    const hit = cache.get(key);
    if (hit) {
      this.cacheHits++;
      return { ...hit, cached: true, ms: 0, costCny: 0 };
    }
    const settle = this.reserve();
    try {
      const t0 = this.now();
      const body = await this.request("/v1/tools/search", { query, count, need_content: false }, signal);
      signal?.throwIfAborted();
      const results = searchResults(body);
      const details: SearchDetails = {
        query,
        count,
        results,
        mirrors: mirrorOf(results),
        ms: this.now() - t0,
        cached: false,
        costCny: results.length ? PRICE_PER_CALL_CNY : 0,
      };
      if (results.length > 0) {
        settle(true);
        this.charge("search");
        cache.set(key, details);
      }
      return details;
    } finally { settle(false); }
  }

  async fetchPage(url: string, signal?: AbortSignal): Promise<FetchResult & { costCny: number }> {
    signal?.throwIfAborted();
    validateUrl(url);
    const cache = this.pages;
    const hit = cache.get(url);
    if (hit) { this.cacheHits++; return { ...hit, costCny: 0 }; }
    const settle = this.reserve();
    try {
      const body = fetchResult(await this.request("/v1/tools/fetch", { url }, signal));
      signal?.throwIfAborted();
      const billable = body.content.trim().length > 0;
      if (billable) {
        settle(true);
        this.charge("fetch");
        cache.set(url, body);
      }
      return { ...body, costCny: billable ? PRICE_PER_CALL_CNY : 0 };
    } finally { settle(false); }
  }
}

/**
 * Page identity for mirror detection: `exec(3)`, `exec.3`, and `.../man3/exec.3`
 * all reduce to `exec#3`; ordinary pages match only by URL (excluding fragment).
 */
export function pageIdentity(r: { title: string; url: string }): string {
  const t = `${r.title} ${r.url}`;
  const m = t.match(/([a-z0-9_+-]{2,})\((\d[a-z]?)\)/i) ?? t.match(/\/?([a-z0-9_+-]{2,})\.(\d[a-z]?)(?:[.\s/#]|$)/i);
  if (m) return `${m[1].toLowerCase()}#${m[2]}`;
  const url = new URL(r.url);
  url.hash = "";
  return `url:${url.href}`;
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


/** Resolve credentials: personal config > legacy extension .env > Pi deepseek credential. */
export function resolveCredentials(
  readCred: (providerId: string) => { type: string; key?: string } | undefined = (id) => {
    try {
      return readStoredCredential(id);
    } catch {
      return undefined;
    }
  },
  readEnvFile: () => Record<string, string> = readConfigEnvFile,
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
