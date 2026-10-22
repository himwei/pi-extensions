/**
 * Latest-response decode TPS: provider output tokens / first observed generated
 * content -> message_end. No character estimate or whole-request duration fallback.
 * The observation window is client-side, not a server-side generation benchmark.
 * rmb-footer owns layout and theme styling for the plain-text `tps` status.
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tps";
const LIVE_REFRESH_MS = 400;
const LIVE_STALE_MS = 1500;
// A batch delivered in a few milliseconds is not a useful sustained-speed sample.
const MIN_SAMPLE_MS = 250;

type Phase = "等待输出" | "思考中" | "生成中";

/** Inspect the current event synchronously; partial is shared, not a snapshot.
 * Only toolcall_start may use its block's name/args. A later empty tool delta
 * must not start the clock just because that shared block has since filled in. */
function isTokenEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta.length > 0;
    case "toolcall_start": {
      const block = event.partial.content[event.contentIndex];
      return block?.type === "toolCall" &&
        (block.name.length > 0 || Object.keys(block.arguments).length > 0);
    }
    default:
      return false;
  }
}

function formatTps(tps: number, streaming: boolean): string {
  const value = tps >= 10 ? String(Math.round(tps)) : String(Math.round(tps * 10) / 10);
  return `${streaming ? "~" : ""}${value} tok/s`;
}

export default function tpsStatus(pi: ExtensionAPI) {
  let firstTokenAt: number | undefined;
  let lastPushAt = -Infinity;
  let lastUsageAt = -Infinity;
  let maxOutput = 0;
  let liveText: string | undefined;
  let published: string | undefined | null = null;
  let phase: Phase = "等待输出";
  let sawThinkingDelta = false;
  let redactedThinking = false;
  let active = false;

  function publish(ctx: ExtensionContext, text: string | undefined): void {
    if (text === published) return;
    published = text;
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  function reset(): void {
    firstTokenAt = undefined;
    lastPushAt = lastUsageAt = -Infinity;
    maxOutput = 0;
    liveText = undefined;
    phase = "等待输出";
    sawThinkingDelta = redactedThinking = active = false;
  }

  pi.on("message_start", (event, ctx) => {
    if (ctx.mode !== "tui" || event.message.role !== "assistant") return;
    reset();
    active = true;
    publish(ctx, `TPS · ${phase}`);
  });

  pi.on("message_update", (event, ctx) => {
    const message = event.message;
    if (ctx.mode !== "tui" || message.role !== "assistant" || !active) return;
    const delta = event.assistantMessageEvent;
    const now = performance.now();
    if (delta.type === "thinking_start" || delta.type === "thinking_delta" || delta.type === "thinking_end") {
      const block = delta.partial.content[delta.contentIndex];
      if (block?.type === "thinking" && block.redacted) redactedThinking = true;
      if (delta.type !== "thinking_end") phase = "思考中";
      if (delta.type === "thinking_delta" && delta.delta.length > 0) sawThinkingDelta = true;
    } else if (delta.type === "text_start" || delta.type === "toolcall_start" ||
      ((delta.type === "text_delta" || delta.type === "toolcall_delta") && delta.delta.length > 0)) {
      phase = "生成中";
    }
    if (firstTokenAt === undefined && isTokenEvent(delta)) firstTokenAt = now;

    const tokens = message.usage.output;
    const validTokens = Number.isFinite(tokens) && tokens > 0;
    const increased = validTokens && tokens > maxOutput;
    if (increased) {
      maxOutput = tokens;
      lastUsageAt = now;
    }
    const incompleteTiming = redactedThinking || ((message.usage.reasoning ?? 0) > 0 && !sawThinkingDelta);
    const elapsedMs = firstTokenAt === undefined ? 0 : now - firstTokenAt;
    if (incompleteTiming || !validTokens || tokens < maxOutput || now - lastUsageAt >= LIVE_STALE_MS) {
      liveText = undefined;
    } else if (increased && elapsedMs >= MIN_SAMPLE_MS && now - lastPushAt >= LIVE_REFRESH_MS) {
      const tps = tokens / (elapsedMs / 1000);
      if (Number.isFinite(tps)) {
        liveText = formatTps(tps, true);
        lastPushAt = now;
      }
    }
    // Never recalculate with an unchanged count and a growing denominator.
    // Fresh provisional values may remain until another event detects staleness.
    publish(ctx, incompleteTiming ? "TPS · 计时不全" : liveText ?? `TPS · ${phase}`);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (ctx.mode !== "tui" || message.role !== "assistant" || !active) return;
    const decodeMs = firstTokenAt === undefined ? undefined : performance.now() - firstTokenAt;
    const incompleteTiming = redactedThinking ||
      message.content.some(block => block.type === "thinking" && block.redacted) ||
      ((message.usage.reasoning ?? 0) > 0 && !sawThinkingDelta);
    const tokens = message.usage.output;
    const completed = message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse";
    let text: string | undefined;
    if (completed) {
      if (incompleteTiming) text = "TPS · 计时不全";
      else if (!Number.isFinite(tokens) || tokens < 0 || decodeMs === undefined || decodeMs < 0) text = "TPS —";
      else if (decodeMs < MIN_SAMPLE_MS) text = "TPS · 短样本";
      else {
        const tps = tokens / (decodeMs / 1000);
        text = Number.isFinite(tps) ? formatTps(tps, false) : "TPS —";
      }
    }
    reset();
    publish(ctx, text); // Aborted/error/deferred replies never retain a provisional speed.
  });

  const clear = (_event: unknown, ctx: ExtensionContext) => {
    reset();
    if (ctx.mode === "tui") publish(ctx, undefined);
  };
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);
  pi.on("model_select", clear);
}
