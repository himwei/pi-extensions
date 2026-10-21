import assert from "node:assert/strict";
import shellFactory from "../powershell-bash.js";
import permissionFactory, { clearSessionAllowlist } from "../permission-gate.js";
import { createPowerShellOperations } from "./operations.js";
import { validateToolArguments } from "@earendil-works/pi-ai";

const tools = new Map<string, any>();
const events = new Map<string, (...args: any[]) => any>();
shellFactory({ on: (name: string, handler: any) => events.set(name, handler),
  registerCommand() {}, appendEntry() {},
  registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
events.get("session_start")!({}, { cwd: process.cwd() });
assert.deepEqual([...tools.keys()], ["bash", "powershell"]);
assert.equal(tools.get("powershell").defaultActive, false, "registration preserves native powershell opt-in");
assert.match(tools.get("powershell").promptGuidelines[0], /Use powershell/);
const ops = createPowerShellOperations();
for (const timeout of [0, -1, Infinity, NaN, 2_147_484]) {
  await assert.rejects(() => ops.exec("'never-run'", process.cwd(), { timeout, onData() {} }), /Invalid timeout/);
}
const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(() => ops.exec("'never-run'", process.cwd(), { signal: cancelled.signal, onData() {} }), /aborted/);

// Headless policy tests never execute the denied commands and exercise both Pi tool names.
const handlers = new Map<string, (...args: any[]) => any>();
const audit: any[] = [];
permissionFactory({ on: (name: string, handler: any) => handlers.set(name, handler),
  appendEntry: (type: string, data: unknown) => audit.push({ type, data }) } as any);
const gate = handlers.get("tool_call")!;
const ctx = { cwd: process.cwd(), hasUI: false, signal: new AbortController().signal };
clearSessionAllowlist();
for (const name of tools.keys()) {
  const secret = await gate({ toolName: name, input: { command: "Get-Content auth.json" }, toolCallId: "secret" }, ctx);
  assert.equal(secret.block, true, name);
  const danger = await gate({ toolName: name, input: { command: "Remove-Item -LiteralPath C:\\fictional-target -Recurse -Force" }, toolCallId: "danger" }, ctx);
  assert.equal(danger.block, true, name);
  assert.equal(audit.at(-1).data.outcome, "unavailable");
  assert.equal(await gate({ toolName: name, input: { command: "Write-Output 'allowed'" } }, ctx), undefined);
}

// Native factories keep their parameter/result contracts with the shared real executor.
try {
  for (const name of tools.keys()) {
    const tool = tools.get(name);
    const output = await tool.execute("utf8", { command: "Write-Output '中文'; Write-Output $PSVersionTable.PSEdition" });
    assert.match(output.content[0].text, /中文/);
    assert.match(output.content[0].text, /Core/);
    assert.equal(output.structuredContent.execution.status, "exited");
    assert.match(output.content.at(-1).text, /exited \(success, exit code 0\)/);
    validateToolArguments({ name: "result", description: "native result", parameters: tool.outputSchema },
      { type: "toolCall", id: "result", name: "result", arguments: output.structuredContent });
    await assert.rejects(() => tool.execute("legacy", { command: "if ($false) { powershell.exe -NoProfile }" }), /blocked/);
    const failure = await tool.execute("failfast", { command: "Write-Error 'expected-failure'; Write-Output 'must-not-run'" });
    assert.equal(failure.isError, true, "Pi reports the nonzero exit as an error result");
    assert.match(failure.content[0].text, /expected-failure/);
    assert.doesNotMatch(failure.content[0].text, /\nmust-not-run\s*\n/);
    assert.match(failure.content.at(-1).text, /exited \(failure, exit code 1\)/);
    assert.doesNotMatch(failure.content.at(-1).text, /timeout|Cancellation/);
    // Native exit handling is explicit: preserve intentional probes while preventing masked failures.
    const masked = await tool.execute("native-masked", { command: "node -e 'process.exit(7)'\nWrite-Output 'after-native-failure'" });
    assert.notEqual(masked.isError, true, "later successful statements can mask a native failure; no blanket fail-fast is enabled");
    assert.match(masked.content[0].text, /after-native-failure/);
    const propagated = await tool.execute("native-propagated", { command:
      "node -e 'process.exit(7)'\n$nativeExitCode = $LASTEXITCODE\nif ($nativeExitCode -ne 0) { exit $nativeExitCode }\nWrite-Output 'must-not-run'" });
    assert.equal(propagated.isError, true);
    assert.equal(propagated.structuredContent.execution.exitCode, 7);
    assert.match(propagated.content.at(-1).text, /exited \(failure, exit code 7\)/);
    assert.doesNotMatch(propagated.content.map((c: any) => c.text).join("\n"), /must-not-run|timeout|Cancellation/);
    const accepted = await tool.execute("native-accepted", { command:
      "node -e 'process.exit(1)'\n$nativeExitCode = $LASTEXITCODE\nif ($nativeExitCode -notin @(0, 1)) { exit $nativeExitCode }\nWrite-Output 'expected-no-match'\nexit 0" });
    assert.notEqual(accepted.isError, true, "documented nonzero probe outcomes remain usable");
    assert.equal(accepted.structuredContent.execution.exitCode, 0);
    assert.match(accepted.content[0].text, /expected-no-match/);
    const timeout = await tool.execute("timeout", { command: "Write-Output 'timeout-ready'; Start-Sleep 10", timeout: 4 });
    assert.equal(timeout.isError, true);
    assert.equal(timeout.structuredContent.execution.status, "timed_out");
    assert.equal(timeout.structuredContent.execution.cleanup.result, "owner_exited");
    assert.match(timeout.content.at(-1).text, /partial changes/);
    assert.ok(timeout.structuredContent.execution.outputLogPath);
    validateToolArguments({ name: "result", description: "native error result", parameters: tool.outputSchema },
      { type: "toolCall", id: "result", name: "result", arguments: timeout.structuredContent });
  }
} finally { await events.get("session_shutdown")!(); }
console.log("shared PowerShell tools, opt-in activation, UTF-8, legacy checks and permission coverage passed");
