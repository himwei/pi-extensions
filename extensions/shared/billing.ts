import { randomUUID } from "node:crypto";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EXTENSION_USAGE_ENTRY, readUsageFact, type Currency } from "./usage.js";
import { readUsagePricing } from "./pricing.js";

type Writer = Pick<ExtensionAPI, "appendEntry">;
export interface Expense {
  id?: string;
  source: string;
  kind: string;
  amount: number;
  currency: Currency;
  provider?: string;
  model?: string;
}

/** Fixed service fees carry currency and identity, without invented token usage. */
export function recordExpense(pi: Writer, expense: Expense): string {
  if (!expense.source.trim() || !expense.kind.trim() || !Number.isFinite(expense.amount) || expense.amount < 0 ||
    !["USD", "CNY"].includes(expense.currency)) throw new Error("Invalid extension expense");
  const id = expense.id ?? randomUUID();
  if (!id) throw new Error("Expense id must not be empty");
  pi.appendEntry(EXTENSION_USAGE_ENTRY, { ...expense, id, version: 1 });
  return id;
}

/** Auxiliary model calls use Pi's returned USD cost, including billed error/abort replies. */
export function recordModelUsage(pi: Writer, source: string, model: Model<any>, response: AssistantMessage): void {
  if (!source.trim()) throw new Error("Model usage source must not be empty");
  const provider = response.provider || model.provider;
  const modelId = response.model || model.id;
  const fact = readUsageFact({ type: "usage", currency: "USD", provider, model: modelId, usage: response.usage });
  if (fact && (fact.usage.totalTokens > 0 || fact.usage.cost.total > 0)) {
    const extensionPricing = readUsagePricing(response.usage);
    pi.appendEntry(EXTENSION_USAGE_ENTRY, { version: 1, id: randomUUID(), source, kind: "model", currency: "USD",
      provider, model: modelId, usage: { ...fact.usage, ...(extensionPricing ? { extensionPricing } : {}) }, outcome: response.stopReason });
  }
}
