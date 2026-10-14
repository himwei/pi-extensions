import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";

/** Local relay prices are configured in CNY; all other attributed prices are USD. */
const CNY_PROVIDERS = new Set(["new-api", "claude_kiro"]);
export type Currency = "CNY" | "USD";
export function providerCurrency(provider: string): Currency {
  return CNY_PROVIDERS.has(provider) ? "CNY" : "USD";
}
const DEFAULT_USD_CNY_RATE = 6.67;

/** Read `usdCnyRate` from a settings file (Pi preserves unknown top-level keys when
 * saving). Cached per file by mtime/size; absent, malformed, or invalid values are ignored. */
const settingsRateCache = new Map<string, { mtimeMs: number; size: number; rate: number | undefined }>();
function agentSettingsPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
}
export function settingsUsdCnyRate(path = agentSettingsPath()): number | undefined {
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(path);
  } catch {
    return undefined;
  }
  const cached = settingsRateCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.rate;
  let rate: number | undefined;
  try {
    const value = record(JSON.parse(readFileSync(path, "utf8")))?.usdCnyRate;
    rate = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    rate = undefined;
  }
  settingsRateCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, rate });
  return rate;
}

/** USD→CNY rate precedence: explicit argument > `USD_CNY_RATE` env > settings.json
 * `usdCnyRate` > built-in default. */
export function usdCnyRate(configured?: number): number {
  const override = configured ?? Number(process.env.USD_CNY_RATE);
  if (Number.isFinite(override) && override > 0) return override;
  return settingsUsdCnyRate() ?? DEFAULT_USD_CNY_RATE;
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const nonnegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export interface UsageFact {
  provider: string;
  model: string;
  usage: Usage;
  currency?: Currency;
  conversation: boolean;
  kind: string;
}

/** Read each persisted usage owner once. Streaming updates are not ledger entries.
 * Records without provider attribution (compaction, branch summary, nested tool
 * usage) follow Pi's dollar convention — the native footer also displays them
 * as dollars — and convert as USD. Legacy summary rows remain readable. */
export function readUsageFact(value: unknown): UsageFact | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  let owner: Record<string, unknown> | undefined;
  let conversation = false;
  let kind = String(entry.type ?? "");
  if (entry.type === "message") {
    owner = record(entry.message);
    if (owner?.role !== "assistant" && owner?.role !== "toolResult") return undefined;
    conversation = owner.role === "assistant";
    kind = String(owner.role);
  } else if (entry.type === "custom" && entry.customType === "summary-usage") {
    owner = record(entry.data);
    kind = "summary";
  } else if (["usage", "summary-usage", "compaction", "branch_summary"].includes(kind)) {
    owner = entry;
    kind = typeof entry.kind === "string" ? entry.kind : kind;
  } else return undefined;
  const raw = record(owner?.usage);
  if (!raw) return undefined;
  const rawCost = record(raw.cost);
  const cost = {
    input: nonnegative(rawCost?.input), output: nonnegative(rawCost?.output),
    cacheRead: nonnegative(rawCost?.cacheRead), cacheWrite: nonnegative(rawCost?.cacheWrite),
    total: nonnegative(rawCost?.total),
  };
  const input = nonnegative(raw.input), output = nonnegative(raw.output);
  const cacheRead = nonnegative(raw.cacheRead), cacheWrite = nonnegative(raw.cacheWrite);
  const provider = typeof owner?.provider === "string" ? owner.provider : "unknown";
  const model = typeof owner?.model === "string" ? owner.model : "unknown";
  const explicitCurrency = owner?.currency;
  const currency = explicitCurrency === "CNY" || explicitCurrency === "USD"
    ? explicitCurrency : provider === "unknown" ? undefined : providerCurrency(provider);
  return {
    provider, model, currency, conversation, kind,
    usage: { input, output, cacheRead, cacheWrite,
      totalTokens: nonnegative(raw.totalTokens) || input + output + cacheRead + cacheWrite,
      reasoning: nonnegative(raw.reasoning), cost },
  };
}

export function costInCny(fact: UsageFact, rate = usdCnyRate()): number {
  return fact.currency === "CNY" ? fact.usage.cost.total : fact.usage.cost.total * rate;
}
