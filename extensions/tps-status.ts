/**
 * Decode TPS for the latest completed assistant response, following DSH's
 * first generated content -> completion window. Excludes TTFT and tool execution.
 * Uses provider-reported output tokens; never substitutes character/chunk counts
 * or durationMs when token usage or the first-token observation is missing.
 * rmb-footer places the `tps` status at the first line's right edge.
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tps";
const LIVE_REFRESH_MS = 400;

/** Pi can deliver the tool name with toolcall_start rather than a delta. */
function isTokenEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
      return event.delta.length > 0;
    case "toolcall_start":
    case "toolcall_delta": {
      const block = event.partial.content[event.contentIndex];
      const hasName = block?.type === "toolCall" && block.name.length > 0;
      const hasArgs = block?.type === "toolCall" && Object.keys(block.arguments).length > 0;
      return hasName || (event.type === "toolcall_delta" ? event.delta.length > 0 : hasArgs);
    }
    default:
      return false;
  }
}

function formatTps(tps: number, streaming: boolean): string {
  // Match DSH's formatter: whole tokens from 10 up, one decimal below.
  const value = tps >= 10 ? String(Math.round(tps)) : String(Math.round(tps * 10) / 10);
  return `${streaming ? "~" : ""}${value} tok/s`;
}

export default function tpsStatus(pi: ExtensionAPI) {
  let firstTokenAt: number | undefined;
  let lastPushAt = -Infinity;
  let active = false;

  function reset(): void {
    firstTokenAt = undefined;
    lastPushAt = -Infinity;
    active = false;
  }

  pi.on("message_start", (event, ctx) => {
    if (ctx.mode !== "tui" || event.message.role !== "assistant") return;
    reset();
    active = true;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("message_update", (event, ctx) => {
    const message = event.message;
    if (ctx.mode !== "tui" || message.role !== "assistant" || !active) return;
    const now = performance.now();
    if (firstTokenAt === undefined && isTokenEvent(event.assistantMessageEvent)) firstTokenAt = now;
    if (firstTokenAt === undefined) return;
    const elapsedMs = Math.max(0, now - firstTokenAt);
    if (elapsedMs <= 0 || now - lastPushAt < LIVE_REFRESH_MS) return;

    // Live usage is not guaranteed to update for every delta, so even provider
    // usage is labelled provisional. Providers reporting only final usage show
    // no live estimate rather than inventing token counts from characters.
    const tokens = message.usage.output;
    const tps = tokens / (elapsedMs / 1000);
    if (Number.isFinite(tokens) && tokens > 0 && Number.isFinite(tps)) {
      lastPushAt = now;
      ctx.ui.setStatus(STATUS_KEY, formatTps(tps, true));
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (ctx.mode !== "tui" || message.role !== "assistant") return;
    const decodeMs = active && firstTokenAt !== undefined
      ? Math.max(0, performance.now() - firstTokenAt)
      : 0;
    reset();
    const tokens = message.usage.output;
    const tps = tokens / (decodeMs / 1000);
    const completed = message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse";
    const valid = completed && decodeMs > 0 && Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(tps);
    ctx.ui.setStatus(STATUS_KEY, valid ? formatTps(tps, false) : undefined);
  });

  pi.on("session_start", (_event, ctx) => {
    reset();
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
  pi.on("session_shutdown", () => reset());
  pi.on("model_select", (_event, ctx) => {
    reset();
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
