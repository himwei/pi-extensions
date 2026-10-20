import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Currency = "CNY" | "USD";
export const DEFAULT_USD_CNY_RATE = 6.8;
const cache = new Map<string, { mtimeMs: number; size: number; rate?: number }>();
const validRate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function settingsUsdCnyRate(path = join(getAgentDir(), "settings.json")): number | undefined {
  try {
    const stat = statSync(path);
    const prior = cache.get(path);
    if (prior && prior.mtimeMs === stat.mtimeMs && prior.size === stat.size) return prior.rate;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const value = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).usdCnyRate : undefined;
    const rate = validRate(value) ? value : undefined;
    cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, rate });
    return rate;
  } catch { return undefined; }
}

/** Explicit > environment > Pi agent settings > 6.8. Rates only affect presentation. */
export function usdCnyRate(configured?: number): number {
  if (validRate(configured)) return configured;
  const environment = Number(process.env.USD_CNY_RATE);
  return validRate(environment) ? environment : settingsUsdCnyRate() ?? DEFAULT_USD_CNY_RATE;
}

export const amountInCny = (amount: number, currency: Currency = "USD", rate = usdCnyRate()): number =>
  currency === "CNY" ? amount : amount * rate;
