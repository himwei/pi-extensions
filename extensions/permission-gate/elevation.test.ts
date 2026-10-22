import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import gateFactory from "../permission-gate.js";
import { createShellAuthorizer } from "./authorization.js";
import { detectElevationIntents } from "./elevation.js";
import { assessCommand } from "./assessment.js";

const lifecycleHandlers = new Map<string, (...args: any[]) => any>();
const authorizeShellCommand = createShellAuthorizer({ on: (name: string, handler: any) => lifecycleHandlers.set(name, handler), appendEntry() {} } as any);
const clearSessionAllowlist = () => lifecycleHandlers.get("session_start")!({}, {});
const sessionManager = { getSessionId: () => "elevation-test" };

// Only parse source in these cases. No inspected invocation is ever executed.
const variants = [
  "Start-Process -FilePath pwsh -Verb RunAs",
  "saps pwsh -Ve:'rUnAs'",
  'start pwsh -Verb "RunAs"',
  "Microsoft.PowerShell.Management\\Start-Process pwsh -Verb RunAs",
  "& 'C:\\tools\\gsudo.exe' whoami",
  "gsudo { whoami }",
  "gsudo cache on",
  "gsudo config CacheMode --global Auto",
  "gsudo",
];
const combined = variants.join("\r\n");
const detected = await detectElevationIntents(combined);
assert.equal(detected.length, variants.length);
assert.deepEqual(detected.map(fact => fact.kind), ["start-process", "start-process", "start-process", "start-process", ...Array(5).fill("gsudo")]);
assert.equal(combined.slice(detected[0].index, detected[0].end), "-Verb RunAs");
assert.equal(combined.slice(detected[1].index, detected[1].end), "-Ve:'rUnAs'");
const wrapped = [
  "Start-Process pwsh -Verb ('RunAs')",
  "Start-Process pwsh -Verb ([string]'RunAs')",
  'Start-Process pwsh -Verb (([System.String]("RunAs")))',
  "saps pwsh -Verb:('RunAs')",
  "Start-Process pwsh -Verb ([STRING]'rUnAs')",
];
const wrappedSource = wrapped.join("\n");
const wrappedFacts = await detectElevationIntents(wrappedSource);
assert.equal(wrappedFacts.length, wrapped.length, "parentheses and string casts expose literal verbs");
assert.deepEqual(wrappedFacts.map(fact => wrappedSource.slice(fact.index, fact.end)), wrapped.map(line => line.slice(line.indexOf("-Verb"))));
assert.deepEqual(await detectElevationIntents("Start-Process pwsh -Verb ($verb); Start-Process pwsh -Verb (Get-Verb); Start-Process pwsh -Verb ([Custom.Type]'RunAs')"), [],
  "variables, command pipelines and arbitrary type conversions are not evaluated");
const unicode = "\uFEFF'中文🙂'; Start-Pro`cess pwsh -V RunA`s\r\ngsu`do whoami";
const unicodeFacts = await detectElevationIntents(unicode);
assert.equal(unicodeFacts.length, 2, "literal escaped command names still reach AST analysis");
assert.equal(unicode.slice(unicodeFacts[0].index, unicodeFacts[0].end), "-V RunA`s",
  "BOM, Chinese and surrogate pairs retain source offsets");

const mentions = String.raw`
# Start-Process pwsh -Verb RunAs
$documentation = 'gsudo whoami; Start-Process pwsh -Verb RunAs'
Write-Output 'Start-Process pwsh -Verb RunAs'
Start-Process pwsh -Verb Open
gsudo --help
gsudo status
gsudo status --json
gsudo status IsElevated --no-output
gsudo config
gsudo config CacheMode
gsudo cache off
gsudo cache help
gsudo -k
runas.exe /user:another pwsh
wsl.exe --exec sudo true
`;
assert.deepEqual(await detectElevationIntents(mentions), []);
assert.deepEqual(await detectElevationIntents("Start-Sleep 1; 'ordinary'"), []);
assert.equal((await detectElevationIntents("gsudo status --json; gsudo whoami")).length, 1);

const directory = mkdtempSync(join(tmpdir(), "pi-elevation-inspection-"));
try {
  const marker = join(directory, "must-not-exist.txt").replaceAll("'", "''");
  await detectElevationIntents(`[IO.File]::WriteAllText('${marker}', 'bad'); Start-Process pwsh -Verb RunAs`);
  assert.equal(existsSync(marker), false, "inspection never executes source");
} finally { rmSync(directory, { recursive: true, force: true }); }

const command = "Start-Process pwsh -Verb RunAs; Remove-Item C:\\fictional-target -Recurse -Force; git reset --hard HEAD";
const assessment = assessCommand(command, await detectElevationIntents(command))!;
assert.equal(assessment.requiresReadiness, true);
assert.match(assessment.zh, /管理员提权.*递归删除.*Git 强制重置/);
assert.equal(assessment.reasons.length, 3);
assert.equal(assessCommand("'safe'", []), undefined);

clearSessionAllowlist();
const entries: Array<{ type: string; data: any }> = [];
const audit = (type: string, data: unknown) => { entries.push({ type, data }); };
let calls = 0;
let answer = "allowed-session";
const overlay = { hasUI: true, mode: "tui", cwd: process.cwd(), sessionManager, ui: {
  notify() {}, custom: async () => { calls++; return answer; },
} } as unknown as ExtensionContext;

// A grant for another language cannot authorize this request. Elevation still
// requires readiness even if the UI tries to return a session grant.
assert.equal(await authorizeShellCommand(command, overlay, { audit, language: "python" }), undefined);
assert.equal(calls, 1);
assert.match((await authorizeShellCommand(command, overlay, { audit }))!, /rejected/);
assert.equal(calls, 2, "cached source hash cannot bypass elevation readiness");
answer = "allowed-once";
assert.equal(await authorizeShellCommand(command, overlay, { audit }), undefined);
assert.equal(await authorizeShellCommand(command, overlay, { audit }), undefined);
assert.equal(calls, 4, "each elevation invocation requires fresh readiness");
assert.equal(entries.at(-1)!.data.requiresReadiness, true);
assert.ok(entries.at(-1)!.data.waitedMs >= 0);
assert.equal(JSON.stringify(entries).includes(command), false);
assert.equal(JSON.stringify(entries).includes("fictional-target"), false);

let promptText = "";
let confirmCount = 0;
const rpc = { hasUI: true, mode: "rpc", cwd: process.cwd(), sessionManager, ui: { notify() {}, confirm: async (title: string, text: string) => {
  confirmCount++; promptText = title + "\n" + text; return true;
} } } as unknown as ExtensionContext;
assert.equal(await authorizeShellCommand(command, rpc, { audit, callId: "nested-call", toolName: "powershell" }), undefined);
assert.equal(confirmCount, 1, "elevation and destructive reasons share one prompt");
assert.match(promptText, /提权执行就绪确认/);
assert.match(promptText, /递归删除/);
assert.match(promptText, /Git 强制重置/);
assert.equal(entries.at(-1)!.data.callId, "nested-call");
assert.match((await authorizeShellCommand(command, { ...rpc, hasUI: false }))!, /unavailable/);

// A pending readiness decision has no payload process; cancellation or a session
// transition must settle it even if the UI answers much later.
for (const sessionChange of [false, true]) {
  clearSessionAllowlist();
  entries.length = 0;
  const controller = new AbortController();
  let respond: (value: boolean) => void = () => {};
  let reached: () => void = () => {};
  const opened = new Promise<void>(resolve => { reached = resolve; });
  const waiting = { ...rpc, ui: { ...rpc.ui, confirm: async () => {
    reached(); return new Promise<boolean>(resolve => { respond = resolve; });
  } } };
  let executed = false;
  const pending = authorizeShellCommand(command, waiting, { signal: controller.signal, audit }).then(reason => {
    if (!reason) executed = true;
    return reason;
  });
  await opened;
  assert.equal(executed, false);
  assert.equal(entries.length, 1);
  if (sessionChange) clearSessionAllowlist();
  else controller.abort();
  assert.match((await pending)!, /cancelled/);
  const count = entries.length;
  respond(true);
  await Promise.resolve();
  assert.equal(executed, false);
  assert.equal(entries.length, count, "late UI answers cannot write fresh authorization audit");
  assert.equal(count, sessionChange ? 1 : 2, "old-session callbacks do not append to a new session");
}

// Inspection failure cannot silently authorize. No inspected program is started.
const previousExecutable = process.env.PI_POWERSHELL_EXE;
try {
  process.env.PI_POWERSHELL_EXE = "powershell.exe";
  assert.match((await authorizeShellCommand(command, rpc))!, /inspection unavailable/);
} finally {
  if (previousExecutable === undefined) delete process.env.PI_POWERSHELL_EXE;
  else process.env.PI_POWERSHELL_EXE = previousExecutable;
}
await assert.rejects(detectElevationIntents(command, AbortSignal.abort()));

// Both distributed shell tools use the public hook, including nested calls.
// This package has no run-script entry; its snapshot integration is tested upstream.
// No payload or real UAC is requested.
const handlers = new Map<string, (...args: any[]) => any>();
gateFactory({ on: (name: string, handler: any) => handlers.set(name, handler), appendEntry() {} } as any);
for (const toolName of ["bash", "powershell"]) {
  assert.equal((await handlers.get("tool_call")!({ toolName, toolCallId: "nested", input: { command } },
    { cwd: process.cwd(), hasUI: false, signal: new AbortController().signal })).block, true);
}
clearSessionAllowlist();
console.log("elevation analysis, readiness, lifecycle and tool integration tests passed (no UAC)");
