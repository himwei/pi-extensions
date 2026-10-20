import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { amountInCny, type Currency } from "./currency.js";
import { priceAmounts, readUsagePricing, USAGE_PRICING_ENTRY } from "./pricing.js";
export { settingsUsdCnyRate, usdCnyRate, type Currency } from "./currency.js";

const LEGACY_CNY_PROVIDERS = new Set(["new-api", "claude_kiro"]);
/** Only for records predating the USD schema marker. New records declare USD. */
export const providerCurrency = (provider: string): Currency => LEGACY_CNY_PROVIDERS.has(provider) ? "CNY" : "USD";
export const COST_SCHEMA_ENTRY = "cost-schema";
export const EXTENSION_USAGE_ENTRY = "extension-usage";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonnegative = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export interface UsageFact {
  provider: string;
  model: string;
  usage: Usage;
  currency?: Currency;
  conversation: boolean;
  kind: string;
  eventId?: string;
  source?: string;
  /** Original CNY quotes plus the remaining native USD amount. */
  amounts?: { usd: number; cny: number };
}

/** Read a single owner. The session reader supplies the native currency after cutover. */
export function readUsageFact(value: unknown, nativeCurrency?: Currency, annotation?: unknown): UsageFact | undefined {
  const entry = record(value);
  if (!entry) return undefined;
  let owner: Record<string, unknown> | undefined;
  let conversation = false;
  let native = false;
  let kind = String(entry.type ?? "");
  if (entry.type === "message") {
    owner = record(entry.message);
    if (owner?.role !== "assistant" && owner?.role !== "toolResult") return undefined;
    conversation = owner.role === "assistant";
    native = true;
    kind = String(owner.role);
  } else if (entry.type === "custom" && ["summary-usage", EXTENSION_USAGE_ENTRY].includes(String(entry.customType))) {
    owner = record(entry.data);
    kind = entry.customType === "summary-usage" ? "summary" : String(owner?.kind ?? "extension");
    if (entry.customType === EXTENSION_USAGE_ENTRY && (owner?.version !== 1 ||
      typeof owner.id !== "string" || !owner.id || typeof owner.source !== "string" || !owner.source ||
      !["USD", "CNY"].includes(String(owner.currency)))) return undefined;
  } else if (["usage", "summary-usage", "compaction", "branch_summary"].includes(kind)) {
    owner = entry;
    native = kind !== "summary-usage";
    kind = typeof entry.kind === "string" ? entry.kind : kind;
  } else return undefined;
  const raw = record(owner?.usage);
  const expense = entry.customType === EXTENSION_USAGE_ENTRY && typeof owner?.amount === "number" &&
    Number.isFinite(owner.amount) && owner.amount >= 0;
  if (!raw && !expense) return undefined;
  const rawCost = record(raw?.cost);
  const cost = {
    input: nonnegative(rawCost?.input), output: nonnegative(rawCost?.output),
    cacheRead: nonnegative(rawCost?.cacheRead), cacheWrite: nonnegative(rawCost?.cacheWrite),
    total: expense ? owner!.amount as number : nonnegative(rawCost?.total),
  };
  const input = nonnegative(raw?.input), output = nonnegative(raw?.output);
  const cacheRead = nonnegative(raw?.cacheRead), cacheWrite = nonnegative(raw?.cacheWrite);
  const provider = typeof owner?.provider === "string" ? owner.provider : "unknown";
  const model = typeof owner?.model === "string" ? owner.model : "unknown";
  const explicit = owner?.currency;
  const pricing = !expense && raw ? readUsagePricing(raw, annotation) ?? readUsagePricing(raw) : undefined;
  const currency = pricing ? "USD" : explicit === "CNY" || explicit === "USD" ? explicit
    : native && nativeCurrency ? nativeCurrency : provider === "unknown" ? undefined : providerCurrency(provider);
  const usage: Usage = { input, output, cacheRead, cacheWrite,
    totalTokens: nonnegative(raw?.totalTokens) || input + output + cacheRead + cacheWrite,
    reasoning: nonnegative(raw?.reasoning), ...(raw?.cacheWrite1h !== undefined ? { cacheWrite1h: nonnegative(raw.cacheWrite1h) } : {}), cost };
  return {
    provider, model, currency, conversation, kind,
    ...(entry.customType === EXTENSION_USAGE_ENTRY ? { eventId: owner!.id as string, source: owner!.source as string } : {}),
    ...(pricing ? { amounts: priceAmounts(usage, pricing) } : {}),
    usage,
  };
}

export function isUsdSchema(value: unknown): boolean {
  const entry = record(value);
  return entry?.type === "custom" && entry.customType === COST_SCHEMA_ENTRY && record(entry.data)?.version === 2;
}

/** One chronological session pass preserves legacy currency and deduplicates explicit event IDs. */
export function* readSessionUsage(entries: readonly unknown[]): Generator<{ entry: unknown; fact: UsageFact }> {
  let nativeCurrency: Currency | undefined;
  const seen = new Set<string>();
  // Summary metadata may be appended after its immutable native usage owner.
  const annotations = new Map<string, unknown>();
  for (const value of entries) {
    const entry = record(value), data = record(entry?.data);
    if (entry?.type === "custom" && entry.customType === USAGE_PRICING_ENTRY && data?.version === 1 &&
      typeof data.ownerId === "string" && !annotations.has(data.ownerId)) annotations.set(data.ownerId, data.pricing);
  }
  for (const entry of entries) {
    if (isUsdSchema(entry)) { nativeCurrency = "USD"; continue; }
    const id = record(entry)?.id;
    const fact = readUsageFact(entry, nativeCurrency, typeof id === "string" ? annotations.get(id) : undefined);
    if (!fact) continue;
    if (fact.eventId) {
      const key = JSON.stringify([fact.source, fact.eventId]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    yield { entry, fact };
  }
}

/** Append the boundary once, including print mode and reloads of legacy sessions. */
export function ensureUsdSchema(pi: Pick<ExtensionAPI, "appendEntry">, ctx: Pick<ExtensionContext, "sessionManager">): void {
  if (!ctx.sessionManager.getEntries().some(isUsdSchema)) pi.appendEntry(COST_SCHEMA_ENTRY, { version: 2, currency: "USD" });
}

export const costInCny = (fact: UsageFact, rate?: number): number => fact.amounts
  ? fact.amounts.cny + amountInCny(fact.amounts.usd, "USD", rate)
  : amountInCny(fact.usage.cost.total, fact.currency, rate);
