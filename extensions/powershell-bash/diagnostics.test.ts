import assert from "node:assert/strict";
import { registerHarnessDiagnostics, executionObserver, toolAvailability } from "../shared/harness-diagnostics.js";
import type { ExecutionState } from "../run-script/execution.js";

const handlers = new Map<string, Array<(...args: any[]) => any>>();
const entries: any[] = [];
const notices: string[] = [];
let registry: any[] = [{ name: "bash", exposure: "direct" }, { name: "gateway", exposure: "model-only" }];
let active = ["bash", "gateway"];
let command: any;
const pi = { on: (name: string, fn: any) => handlers.set(name, [...handlers.get(name) ?? [], fn]),
  registerCommand: (_name: string, value: any) => { command = value; },
  getAllTools: () => registry, getActiveTools: () => active,
  appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
} as any;
const ctx = { ui: { notify: (text: string) => notices.push(text) }, sessionManager: { getEntries: () => entries } } as any;
const emit = async (name: string, event: any = {}) => {
  let result: any;
  for (const fn of handlers.get(name) ?? []) result = await fn(event, ctx);
  return result;
};
registerHarnessDiagnostics(pi);
await emit("session_start");
assert.equal(toolAvailability(pi).find(t => t.name === "gateway")!.callable, false);
let prompt = (await emit("before_agent_start", { systemPrompt: "original" })).systemPrompt;
assert.match(prompt, /^original/);
assert.match(prompt, /run-script registered=false, active=false, nested=false/);
assert.match(prompt, /explicitly syntax-check/);
assert.match(prompt, /Immediately save \$LASTEXITCODE/);
assert.match(prompt, /accept only the exit codes documented/);
assert.equal(entries.length, 1);
await emit("before_agent_start", { systemPrompt: "original" });
assert.equal(entries.length, 1, "identical tool snapshots are deduplicated");
registry = [...registry, { name: "run-script", exposure: "deferred" }];
prompt = (await emit("before_agent_start", { systemPrompt: "original" })).systemPrompt;
assert.match(prompt, /registered=true, active=false, nested=true/);
await command.handler("tools", ctx);
assert.match(notices.at(-1)!, /run-script: registered=yes, active=false, nested=true/);
assert.deepEqual(active, ["bash", "gateway"], "diagnostics never activate tools");
registry = registry.map(t => t.name === "run-script" ? { ...t, exposure: "direct" } : t);
await command.handler("tools", ctx);
assert.match(notices.at(-1)!, /--tools \+run-script/);
assert.deepEqual(active, ["bash", "gateway"]);
active = [...active, "run-script"];
await emit("before_agent_start", { systemPrompt: "original" });
assert.equal(entries.filter(e => e.customType === "harness-tools").length, 3);
await command.handler("tools", ctx);
assert.doesNotMatch(notices.at(-1)!, /--tools \+run-script/);

const state: ExecutionState = { id: "operation-a", startedAt: "2026-10-21T01:00:00Z", elapsedMs: 12,
  phase: "owner_started", ownerPid: 100, cleanup: { requested: false, scope: "windows-job", result: "not_requested" } };
const observe = executionObserver(pi, ctx, "bash", "call-a");
observe(state);
await command.handler("execution operation-a", ctx);
assert.match(notices.at(-1)!, /No terminal observation/);
observe({ ...state, phase: "finished", status: "timed_out", cleanup: { ...state.cleanup, requested: true, result: "owner_exited" } });
await command.handler("execution operation-a", ctx);
assert.match(notices.at(-1)!, /timed_out/);
assert.match(notices.at(-1)!, /does not prove nothing ran/);
assert.doesNotMatch(notices.at(-1)!, /No terminal observation/);
const count = entries.length;
await emit("session_start");
observe(state);
assert.equal(entries.length, count, "late old-session completions do not pollute the new session");
entries.push({ type: "custom", customType: "execution-status", data: { version: 1, execution: { id: "malformed" } } });
await command.handler("execution malformed", ctx);
assert.match(notices.at(-1)!, /没有对应/);
const broken = { ...pi, appendEntry() { throw new Error("disk full"); } };
const brokenObserver = executionObserver(broken, ctx, "bash");
const noticeCount = notices.length;
assert.doesNotThrow(() => { brokenObserver(state); brokenObserver(state); });
assert.equal(notices.length, noticeCount + 1, "audit failure warns once and does not fail the operation");
console.log("tool availability snapshots, prompt fallback, execution diagnostics and lifecycle guards passed");
