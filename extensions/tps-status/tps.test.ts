import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tpsStatus from "../tps-status.js";

type Handler = (event: unknown, ctx: unknown) => void;
const handlers = new Map<string, Handler>();
const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI;
const statuses: Array<string | undefined> = [];
const ctx = { mode: "tui", ui: { setStatus: (key: string, text: string | undefined) => {
  assert.equal(key, "tps");
  statuses.push(text);
} } };
let now = 0;
const originalNow = performance.now;
performance.now = () => now;

type Block = { type: string; name?: string; arguments?: object; redacted?: boolean; thinking?: string };
const assistant = (output: number | undefined, stopReason = "stop", reasoning?: number, content: Block[] = []) => ({
  role: "assistant", content, usage: { output, reasoning }, stopReason, durationMs: 99999,
});
const call = (name: string, message: unknown) => handlers.get(name)!({ message }, ctx);
const update = (type: string, delta = "", output = 0, block?: Block, reasoning?: number) => {
  const message = assistant(output, "stop", reasoning, block ? [block] : []);
  handlers.get("message_update")!({
    message, assistantMessageEvent: { type, delta, contentIndex: 0, partial: message },
  }, ctx);
};
const start = () => call("message_start", assistant(0));
const latest = () => statuses.at(-1);

try {
  tpsStatus(pi);
  start();
  assert.equal(latest(), "TPS · 等待输出");
  now = 1000;
  update("thinking_start");
  assert.equal(latest(), "TPS · 思考中");
  now = 2000;
  update("thinking_delta", "r");
  now = 7000;
  update("text_start");
  assert.equal(latest(), "TPS · 生成中");
  update("text_delta", "answer", 600);
  assert.equal(latest(), "~120 tok/s");
  const count = statuses.length;
  now = 7100;
  update("text_delta", "x", 700);
  assert.equal(statuses.length, count, "live refresh is throttled");
  now = 8000;
  call("message_end", assistant(800, "stop", 600));
  assert.equal(latest(), "133 tok/s", "reasoning is already included; 800 / 6s, not durationMs");

  // Monotonic zero and whitespace are real observations; only final usage is needed.
  now = 0;
  start();
  update("text_delta", " ");
  now = 1000;
  call("message_end", assistant(32));
  assert.equal(latest(), "32 tok/s");

  now = 10000;
  start();
  const sharedBlock = { type: "toolCall", name: "", arguments: {} };
  update("toolcall_start", "", 0, sharedBlock);
  sharedBlock.name = "read";
  now = 11000;
  update("toolcall_delta", "", 0, sharedBlock);
  now = 12000;
  update("toolcall_delta", "{");
  now = 14000;
  call("message_end", assistant(64, "toolUse"));
  assert.equal(latest(), "32 tok/s", "later mutation and empty deltas cannot backdate first token");
  for (const block of [
    { type: "toolCall", name: "read", arguments: {} },
    { type: "toolCall", name: "", arguments: { path: "file" } },
  ]) {
    start();
    update("toolcall_start", "", 0, block);
    now += 1000;
    call("message_end", assistant(8.7, "toolUse"));
    assert.equal(latest(), "8.7 tok/s", "tool name/args at start are generated content");
  }

  // No char estimator: reasoning-only, final-only usage still measures correctly.
  start();
  update("thinking_start");
  update("thinking_delta", "r".repeat(10000));
  now += 1000;
  update("thinking_delta", "r");
  assert.equal(latest(), "TPS · 思考中");
  call("message_end", assistant(100, "stop", 100));
  assert.equal(latest(), "100 tok/s");

  // An unchanged cumulative count must never create a false speed decline.
  start();
  update("text_delta", "x");
  now += 1000;
  update("text_delta", "x", 100);
  assert.equal(latest(), "~100 tok/s");
  const freshCount = statuses.length;
  now += 500;
  update("text_delta", "x", 100);
  assert.equal(statuses.length, freshCount);
  now += 1000;
  update("text_delta", "x", 100);
  assert.equal(latest(), "TPS · 生成中", "staleness checked on next event, no timer");
  now += 500;
  update("text_delta", "x", 600);
  assert.equal(latest(), "~200 tok/s");
  now += 1000;
  call("message_end", assistant(800));
  assert.equal(latest(), "200 tok/s");

  // Formatting identical numbers shouldn't request another footer render.
  start();
  update("text_delta", "x");
  now += 1000;
  update("text_delta", "x", 100);
  const sameCount = statuses.length;
  now += 1000;
  update("text_delta", "x", 200);
  assert.equal(statuses.length, sameCount);
  call("message_end", assistant(200));
  assert.equal(latest(), "100 tok/s");

  // Regressed/invalid live usage isn't trusted; final usage is authoritative.
  start();
  update("text_delta", "x");
  now += 1000;
  update("text_delta", "x", 100);
  now += 500;
  update("text_delta", "x", 50);
  assert.equal(latest(), "TPS · 生成中");
  call("message_end", assistant(150));
  assert.equal(latest(), "100 tok/s");

  // Usage on block boundaries cannot invent first-token timing.
  start();
  now += 500;
  for (const type of ["text_start", "text_delta", "text_end", "toolcall_end"]) update(type, "", 400);
  now += 1000;
  call("message_end", assistant(400));
  assert.equal(latest(), "TPS —");

  for (const output of [undefined, -1, NaN, Infinity]) {
    start(); update("text_delta", "x"); now += 1000;
    call("message_end", assistant(output));
    assert.equal(latest(), "TPS —");
  }
  for (const reason of ["aborted", "error", "deferred"]) {
    start(); update("text_delta", "x"); now += 1000;
    update("text_delta", "x", 100);
    call("message_end", assistant(100, reason));
    assert.equal(latest(), undefined, "cancelled/failed/deferred replies discard live values");
  }

  // Short batched windows are labelled, not capped or presented as a benchmark.
  for (const elapsed of [0, 1, 249, 250]) {
    start(); update("text_delta", "a".repeat(5000)); now += elapsed;
    call("message_end", assistant(100));
    assert.equal(latest(), elapsed < 250 ? "TPS · 短样本" : "400 tok/s");
  }
  start(); update("text_delta", "x"); now -= 1;
  call("message_end", assistant(100));
  assert.equal(latest(), "TPS —");
  start(); update("text_delta", "x"); now += 1000;
  call("message_end", assistant(0));
  assert.equal(latest(), "0 tok/s");

  // Hidden reasoning and redacted thinking don't share the measured text window.
  start(); update("text_delta", "answer"); now += 1000;
  update("text_delta", "more", 500, undefined, 400);
  assert.equal(latest(), "TPS · 计时不全");
  call("message_end", assistant(500, "stop", 400));
  assert.equal(latest(), "TPS · 计时不全");
  start();
  const redacted = { type: "thinking", thinking: "[Reasoning redacted]", redacted: true };
  update("thinking_start", "", 0, redacted);
  assert.equal(latest(), "TPS · 计时不全");
  update("thinking_delta", "visible");
  now += 1000;
  call("message_end", assistant(500, "stop", 400, [redacted]));
  assert.equal(latest(), "TPS · 计时不全");
  start(); update("text_delta", "answer"); now += 1000;
  call("message_end", assistant(500, "stop", undefined, [redacted]));
  assert.equal(latest(), "TPS · 计时不全", "final content can reveal previously unknown redaction");

  // Reset invalidates clocks; late end cannot restore a cleared session's value.
  for (const transition of ["session_start", "model_select", "session_shutdown"]) {
    start(); update("text_delta", "x");
    handlers.get(transition)!({}, ctx);
    assert.equal(latest(), undefined);
    const clearedCount = statuses.length;
    now += 1000;
    call("message_end", assistant(100));
    assert.equal(statuses.length, clearedCount);
  }
  const unchanged = statuses.length;
  call("message_end", { role: "toolResult" });
  for (const mode of ["print", "json", "rpc"]) {
    ctx.mode = mode;
    start(); update("thinking_delta", "r"); call("message_end", assistant(100));
  }
  assert.equal(statuses.length, unchanged);
  console.log("tps-status decode timing, freshness, confidence and lifecycle tests passed");
} finally {
  performance.now = originalNow;
}
