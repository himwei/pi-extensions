import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createShellAuthorizer } from "./authorization.js";

const command = "Remove-Item -LiteralPath C:\\test-only-target -Recurse -Force";
const entries: Array<{ type: string; data: unknown }> = [];
const audit = (type: string, data: unknown) => { entries.push({ type, data }); };
const handlers = new Map<string, (...args: any[]) => any>();
const authorizeShellCommand = createShellAuthorizer({ on: (name: string, handler: any) => handlers.set(name, handler), appendEntry: audit } as any);
const clearSessionAllowlist = () => handlers.get("session_start")!({}, {});
let receivedSignal: AbortSignal | undefined;
const controller = new AbortController();
let resolveAnswer: (value: boolean) => void = () => {};
let opened: () => void = () => {};
const dialogOpened = new Promise<void>(resolve => { opened = resolve; });
const ctx = { hasUI: true, ui: { notify() {}, confirm: async (_title: string, _message: string, options?: { signal?: AbortSignal }) => {
  receivedSignal = options?.signal;
  opened();
  return new Promise<boolean>(resolve => { resolveAnswer = resolve; });
} } } as unknown as ExtensionContext;
const pending = authorizeShellCommand(command, ctx, { signal: controller.signal, audit });
await dialogOpened;
assert.ok(receivedSignal, "caller cancellation is forwarded to the dialog");
controller.abort();
assert.equal(receivedSignal.aborted, true);
assert.match((await pending)!, /cancelled/);
resolveAnswer(true); // A late approval must never authorize execution.
await Promise.resolve();
assert.equal(entries.length, 2);
assert.equal(entries[0].type, "approval-asked");
assert.equal(entries[1].type, "approval-decided");
assert.equal((entries[1].data as { outcome: string }).outcome, "cancelled");
assert.equal(JSON.stringify(entries).includes(command), false, "audit retains hash, not raw shell content");

entries.length = 0;
const failing = { ...ctx, ui: { ...ctx.ui, confirm: async () => { throw new Error("UI gone"); } } };
assert.match((await authorizeShellCommand(command, failing, { audit }))!, /unavailable/);
assert.equal((entries[1].data as { outcome: string }).outcome, "unavailable");
const allowed = { ...ctx, ui: { ...ctx.ui, confirm: async () => true } };
assert.equal(await authorizeShellCommand(command, allowed, { audit }), undefined);
const noUi = { ...ctx, hasUI: false };
assert.match((await authorizeShellCommand(command, noUi, { audit }))!, /unavailable/);

// overlay 路径 + 会话放行：[a] 后同哈希命令静默通过并记审计；不同命令仍需确认
clearSessionAllowlist();
let customCalls = 0;
const overlayCtx = {
  hasUI: true,
  mode: "tui",
  cwd: process.cwd(),
  sessionManager: { getSessionId: () => "approval-test" },
  ui: {
    notify() {},
    custom: async () => {
      customCalls++;
      return "allowed-session" as const;
    },
  },
} as unknown as ExtensionContext;
entries.length = 0;
assert.equal(await authorizeShellCommand(command, overlayCtx, { audit }), undefined);
assert.equal(customCalls, 1);
assert.equal(entries[1].type, "approval-decided");
assert.equal((entries[1].data as { outcome: string }).outcome, "allowed-session");
entries.length = 0;
assert.equal(await authorizeShellCommand(command, overlayCtx, { audit }), undefined);
assert.equal(customCalls, 1, "identical command auto-passes without opening the overlay");
assert.equal(entries.length, 1);
assert.equal(entries[0].type, "approval-decided");
assert.equal((entries[0].data as { outcome: string }).outcome, "allowed-session");
assert.equal((entries[0].data as { auto?: boolean }).auto, true);
assert.equal(JSON.stringify(entries).includes(command), false, "audit retains hash, not raw shell content");
clearSessionAllowlist();
console.log("approval cancellation and audit tests passed");
