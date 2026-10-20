import { contentText, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { recordModelUsage } from "./billing.js";

type SessionModel = { provider: string; modelId: string } | null;

/** Resolve against Pi's current model/branch; no separate model registry or credential store. */
export function commandModel(ctx: ExtensionContext, fallback?: SessionModel): Model<any> | undefined {
  // A catalog refresh can replace a selected model's price/capacity metadata.
  if (ctx.model) return ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
  const selected = fallback === undefined
    ? buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).model
    : fallback;
  return selected ? ctx.modelRegistry.find(selected.provider, selected.modelId) : undefined;
}

/** Compatibility export; native USD usage retains any original-currency pricing metadata. */
export function recordSummaryUsage(pi: Pick<ExtensionAPI, "appendEntry">, model: Model<any>, response: AssistantMessage): void {
  recordModelUsage(pi, "auto-summary", model, response);
}

/** One auxiliary request; prompt policy stays with the command, billing stays here. */
export async function completeCommand(
  pi: Pick<ExtensionAPI, "appendEntry">,
  registry: Pick<ExtensionContext["modelRegistry"], "streamSimple">,
  model: Model<any>, prompt: string, maxTokens: number, signal: AbortSignal, source = "auto-summary",
): Promise<AssistantMessage> {
  signal.throwIfAborted();
  // The public simple stream resolves auth, baseUrl and virtual routing, and caps routed budgets.
  const response = await registry.streamSimple(model, {
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  }, { maxTokens, signal }).result();
  recordModelUsage(pi, source, model, response);
  return response;
}

export const assistantText = (message: AssistantMessage): string => contentText(message.content, "\n");

/** Each command owns its own pending operation; release only after its call has settled. */
export function commandOperation(pi: ExtensionAPI, navigationWarning: string) {
  let pending: AbortController | undefined;
  pi.on("session_shutdown", () => pending?.abort());
  const preventNavigation = (_event: unknown, ctx: ExtensionContext) => {
    if (!pending) return undefined;
    ctx.ui.notify(navigationWarning, "warning");
    return { cancel: true };
  };
  pi.on("session_before_switch", preventNavigation);
  pi.on("session_before_fork", preventNavigation);
  pi.on("session_before_tree", preventNavigation);
  return {
    isPending: () => pending !== undefined,
    begin(): AbortController {
      if (pending) throw new Error("Command already has a pending model request");
      return pending = new AbortController();
    },
    finish(controller: AbortController): void {
      if (pending === controller) pending = undefined;
    },
  };
}
