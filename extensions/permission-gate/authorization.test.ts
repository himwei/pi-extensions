import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellAuthorizer, type AuthorizationContext, type AuthorizationOptions } from "./authorization.js";

// Authorization only: these commands are never passed to an execution tool.
const root = await mkdtemp(join(tmpdir(), "pi-authorizer-test-"));
const events = new Map<string, (...args: any[]) => any>();
const entries: Array<{ type: string; data: any }> = [];
const pi = { on: (name: string, handler: any) => { events.set(name, handler); },
  appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); } } as any;
const authorize = createShellAuthorizer(pi);
const source = "Remove-Item -LiteralPath .\\build -Recurse -Force";
const version = (value: string) => createHash("sha256").update(value).digest("hex");
let id = "session-a";
let prompts = 0;
let answer = "allowed-session";
const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => id }, ui: {
  notify() {}, custom: async () => { prompts++; return answer; },
} } as unknown as AuthorizationContext;
const denied = (context: AuthorizationContext = ctx, options: AuthorizationOptions = {}) =>
  authorize(source, { ...context, hasUI: false }, options);
const grant = (context: AuthorizationContext = ctx, options: AuthorizationOptions = {}) => authorize(source, context, options);
const emitStart = () => events.get("session_start")!({}, ctx);

try {
  const a = join(root, "a");
  const b = join(root, "b");
  await mkdir(a); await mkdir(b);
  emitStart();
  const atA = { ...ctx, cwd: a };
  const atB = { ...ctx, cwd: b };
  assert.equal(await grant(atA), undefined);
  assert.equal(await denied(atA), undefined);
  assert.equal(prompts, 1, "same session, source and directory reuse one grant");
  assert.match((await denied(atB))!, /unavailable/, "another directory never inherits the grant");
  assert.match((await denied(atA, { language: "python" }))!, /unavailable/, "another interpreter never inherits the grant");
  assert.match((await denied(atA, { toolName: "powershell" }))!, /unavailable/, "another tool has its own permission");
  assert.match((await denied(atA, { language: "bash", distro: "A" }))!, /unavailable/);
  assert.equal(await grant(atA, { language: "bash", distro: "A" }), undefined);
  assert.match((await denied(atA, { language: "bash", distro: "B" }))!, /unavailable/, "WSL distributions are distinct execution contexts");

  const scriptA = join(a, "same.ps1");
  const scriptB = join(b, "same.ps1");
  await writeFile(scriptA, source, "utf8"); await writeFile(scriptB, source, "utf8");
  const script = { toolName: "run-script", script: { path: scriptA, version: version(source) } };
  assert.equal(await grant(ctx, script), undefined);
  assert.equal(await denied(ctx, script), undefined);
  assert.match((await denied(ctx, { ...script, script: { ...script.script, path: scriptB } }))!, /unavailable/,
    "identical content in another physical script requires confirmation");
  assert.match((await denied(ctx, { ...script, script: { ...script.script, version: version("\uFEFF" + source) } }))!, /unavailable/,
    "different raw bytes do not inherit a text-equivalent version's grant");
  assert.match((await denied(ctx, { toolName: "run-script" }))!, /unavailable/, "missing script identity never borrows an inline grant");
  assert.equal(JSON.stringify(entries).includes(root), false, "context identity is audited as a hash");
  assert.equal(JSON.stringify(entries).includes(source), false);
  assert.ok(entries.some(entry => typeof entry.data.contextHash === "string" && entry.data.auto === true));

  id = "session-b";
  assert.match((await denied(atA))!, /session/, "a changed session ID is rejected even before a lifecycle callback");
  emitStart();
  assert.match((await denied({ ...atA, sessionManager: { getSessionId: () => "session-a" } } as AuthorizationContext))!, /session/,
    "an old context cannot move the authorizer back to its former session");
  assert.match((await denied(atA))!, /unavailable/);
  assert.equal(await grant(atA), undefined);
  emitStart(); // reload of the same session ID
  assert.match((await denied(atA))!, /unavailable/, "same-ID reload also clears grants");

  // Factory instances, including cached factories used by later sessions, share
  // implementation but never share grants or a shutdown controller.
  assert.equal(await grant(atA), undefined);
  const independent = createShellAuthorizer({ on() {}, appendEntry() {} } as any);
  assert.match((await independent(source, { ...atA, hasUI: false }))!, /unavailable/);
  events.get("session_shutdown")!();
  assert.match((await denied(atA))!, /session/);
  emitStart();

  // No stable session/cwd identity: once remains possible, session grants don't.
  const unidentified = { ...ctx, sessionManager: undefined };
  emitStart();
  const fresh = createShellAuthorizer({ on() {}, appendEntry() {} } as any);
  assert.match((await fresh(source, unidentified))!, /rejected/);
  answer = "allowed-once";
  assert.equal(await fresh(source, unidentified), undefined);
  assert.match((await fresh(source, { ...unidentified, hasUI: false }))!, /unavailable/);
  answer = "allowed-session";

  // A directory changing while the user reads the prompt invalidates even once.
  const changing = { ...ctx, cwd: a, ui: { ...ctx.ui, custom: async () => {
    changing.cwd = b; return "allowed-once";
  } } } as unknown as AuthorizationContext;
  assert.match((await authorize(source, changing))!, /context changed/);

  // Shutdown/start cancels pending UI and drops late decisions/audit writes.
  let respond: (value: boolean) => void = () => {};
  let reached: () => void = () => {};
  const opened = new Promise<void>(resolve => { reached = resolve; });
  const waiting = { ...ctx, mode: "rpc", ui: { ...ctx.ui, confirm: async () => {
    reached(); return new Promise<boolean>(resolve => { respond = resolve; });
  } } } as unknown as AuthorizationContext;
  entries.length = 0;
  const pending = authorize(source, waiting);
  await opened;
  events.get("session_shutdown")!();
  emitStart();
  assert.match((await pending)!, /cancelled/);
  const count = entries.length;
  respond(true);
  await Promise.resolve();
  assert.equal(entries.length, count);
  assert.match((await denied())!, /unavailable/);
} finally {
  events.get("session_shutdown")!();
  await rm(root, { recursive: true, force: true });
}
console.log("authorization instances, context binding, lifecycle and stale-decision tests passed (no commands executed)");
