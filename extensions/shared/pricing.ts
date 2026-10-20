import { createHash, randomUUID } from "node:crypto";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { usdCnyRate, type Currency } from "./currency.js";

export type CostRates = Model<any>["cost"];
/** Quotes use the same per-million-token rates and tiers as Pi. */
export type ModelPricing = CostRates & { currency: Currency };
export interface PriceSnapshot {
  version: 1;
  id: string;
  currency: Currency;
  /** Frozen quote-to-USD conversion; presentation uses its own current rate. */
  usdCnyRate: number;
  quote: CostRates;
  usd: CostRates;
}
export interface PricePart {
  id: string;
  provider: string;
  model: string;
  snapshot: PriceSnapshot;
  usdAmount: number;
  amount: number;
}
export interface UsagePricing { version: 1; parts: PricePart[] }
export const USAGE_PRICING_ENTRY = "usage-pricing";
const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const rate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const positive = (value: unknown): value is number => rate(value) && value > 0;

export function validateRates(value: unknown): asserts value is CostRates {
  const cost = object(value);
  if (!cost || fields.some(key => !rate(cost[key]))) throw new Error("cost must specify four finite nonnegative rates");
  if (cost.tiers !== undefined && (!Array.isArray(cost.tiers) || cost.tiers.some(raw => {
    const tier = object(raw);
    return !tier || !Number.isSafeInteger(tier.inputTokensAbove) || (tier.inputTokensAbove as number) < 0 || fields.some(key => !rate(tier[key]));
  }))) throw new Error("cost.tiers must specify valid thresholds and rates");
}

function mapRates(cost: CostRates, divisor: number): CostRates {
  const convert = (row: Pick<CostRates, typeof fields[number]>): CostRates => ({
    input: row.input / divisor, output: row.output / divisor, cacheRead: row.cacheRead / divisor, cacheWrite: row.cacheWrite / divisor,
  });
  const result = { ...convert(cost), ...(cost.tiers ? { tiers: cost.tiers.map(tier => ({ ...convert(tier), inputTokensAbove: tier.inputTokensAbove })) } : {}) };
  validateRates(result);
  return result;
}

/** Legacy cost is USD; pricing is an explicit USD/CNY quote. Never accept both. */
export function resolvePricing(cost?: CostRates, pricing?: ModelPricing, conversionRate = usdCnyRate()): PriceSnapshot | undefined {
  if (cost !== undefined && pricing !== undefined) throw new Error("cost and pricing cannot be configured together");
  if (cost === undefined && pricing === undefined) return undefined;
  if (pricing !== undefined && !object(pricing)) throw new Error("pricing must be an object with an explicit currency");
  const currency = pricing !== undefined ? pricing.currency : "USD";
  if (currency !== "USD" && currency !== "CNY") throw new Error("pricing.currency must be USD or CNY");
  const quote = pricing ?? cost!;
  validateRates(quote);
  const allowed = new Set<string>([...fields, "tiers", ...(pricing !== undefined ? ["currency"] : [])]);
  const unknown = Object.keys(quote).find(key => !allowed.has(key));
  if (unknown) throw new Error(`Unsupported ${pricing !== undefined ? "pricing" : "cost"} field: ${unknown}; use pricing.currency for an explicit quote currency`);
  if (!positive(conversionRate)) throw new Error("Invalid pricing conversion rate");
  const original = mapRates(quote, 1);
  const usd = mapRates(original, currency === "CNY" ? conversionRate : 1);
  const frozenRate = currency === "CNY" ? conversionRate : 1;
  const id = createHash("sha256").update(JSON.stringify({ currency, usdCnyRate: frozenRate, quote: original })).digest("hex");
  return { version: 1, id, currency, usdCnyRate: frozenRate, quote: original, usd };
}

export function snapshotMatches(snapshot: PriceSnapshot, model: Pick<Model<any>, "cost">): boolean {
  return JSON.stringify(snapshot.usd) === JSON.stringify(mapRates(model.cost, 1));
}

export function pricePart(snapshot: PriceSnapshot, usdAmount: number, provider: string, model: string): PricePart {
  if (!rate(usdAmount)) throw new Error("Invalid usage cost");
  const amount = usdAmount * (snapshot.currency === "CNY" ? snapshot.usdCnyRate : 1);
  if (!rate(amount)) throw new Error("Invalid original-currency cost");
  return { id: randomUUID(), provider, model, snapshot: structuredClone(snapshot), usdAmount, amount };
}

/** Only persisted, self-contained quote snapshots affect a historical amount. */
function parsePart(value: unknown): PricePart | undefined {
  const part = object(value), snapshot = object(part?.snapshot);
  if (!part || typeof part.id !== "string" || !part.id || typeof part.provider !== "string" || typeof part.model !== "string" ||
    !rate(part.usdAmount) || !rate(part.amount) || !snapshot || snapshot.version !== 1 || typeof snapshot.id !== "string" ||
    !["USD", "CNY"].includes(String(snapshot.currency)) || !positive(snapshot.usdCnyRate)) return undefined;
  try {
    validateRates(snapshot.quote); validateRates(snapshot.usd);
    const expected = resolvePricing(undefined, { ...snapshot.quote, currency: snapshot.currency as Currency }, snapshot.usdCnyRate)!;
    if (expected.id !== snapshot.id || JSON.stringify(expected.usd) !== JSON.stringify(mapRates(snapshot.usd, 1))) return undefined;
    const amount = part.usdAmount * (expected.currency === "CNY" ? expected.usdCnyRate : 1);
    if (Math.abs(amount - part.amount) > Math.max(1e-10, amount * 1e-10)) return undefined;
    return { id: part.id, provider: part.provider, model: part.model, snapshot: expected, usdAmount: part.usdAmount, amount: part.amount };
  } catch { return undefined; }
}

export function readUsagePricing(usage: unknown, annotation?: unknown): UsagePricing | undefined {
  const owner = object(usage), metadata = object(annotation ?? owner?.extensionPricing);
  const total = object(owner?.cost)?.total;
  if (!metadata || metadata.version !== 1 || !Array.isArray(metadata.parts) || !rate(total)) return undefined;
  const parts: PricePart[] = [], seen = new Set<string>();
  for (const raw of metadata.parts) {
    const part = parsePart(raw);
    if (!part) return undefined;
    if (!seen.has(part.id)) { seen.add(part.id); parts.push(part); }
  }
  if (parts.reduce((sum, part) => sum + part.usdAmount, 0) > total + Math.max(1e-10, total * 1e-10)) return undefined;
  return parts.length ? { version: 1, parts } : undefined;
}

export function withUsagePricing(usage: Usage, parts: readonly PricePart[]): Usage {
  const extensionPricing = readUsagePricing(usage, { version: 1, parts });
  return extensionPricing ? { ...usage, extensionPricing } as Usage : usage;
}

/** Preserve unrelated USD charges in mixed native tool/summary aggregates. */
export function priceAmounts(usage: Usage, metadata: UsagePricing): { usd: number; cny: number } {
  const cnyParts = metadata.parts.filter(part => part.snapshot.currency === "CNY");
  return { usd: Math.max(0, usage.cost.total - cnyParts.reduce((sum, part) => sum + part.usdAmount, 0)),
    cny: cnyParts.reduce((sum, part) => sum + part.amount, 0) };
}
