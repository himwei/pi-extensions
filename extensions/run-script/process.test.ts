import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess, shutdownProcesses } from "./process.js";
import { ProcessExecutionError, type ExecutionState } from "./execution.js";

const dir = mkdtempSync(join(tmpdir(), "pi-process-test-"));
const run = (source: string, options: Partial<Parameters<typeof runProcess>[3]> = {}) =>
  runProcess(process.execPath, ["-e", source], dir, { timeoutMs: 10000, ...options });
try {
  // Supply Windows command-line edge cases through actual argv (not a shell).
  const quoted = await runProcess(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "a b", "x\"y", "c:\\tail\\", "中文"], dir, { timeoutMs: 10000 });
  assert.equal(quoted.exitCode, 0, quoted.output);
  assert.deepEqual(JSON.parse(quoted.output.trim()), ["a b", "x\"y", "c:\\tail\\", "中文"]);

  const full = await run("console.log('complete-log');", { log: true });
  assert.equal(full.exitCode, 0, full.output);
  assert.ok(full.logPath);
  assert.match(readFileSync(full.logPath, "utf8"), /complete-log/);
  const cap = await run("console.log('x'.repeat(3000));console.log('TAIL');", { log: true, maxLogBytes: 1024 });
  assert.equal(cap.exitCode, 0, cap.output);
  assert.equal(cap.logPath, undefined);
  assert.match(cap.logWarning!, /exceeded/);
  assert.match(cap.output, /TAIL/);
  const disk = await run("console.log('still-completed');", { log: true, logDirectory: join(dir, "missing") });
  assert.equal(disk.exitCode, 0, disk.output);
  assert.equal(disk.logPath, undefined);
  assert.match(disk.logWarning!, /unavailable/);
  assert.match(disk.output, /still-completed/);

  if (process.platform === "win32") {
    const marker = join(dir, "orphan.txt");
    const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),3500)`;
    // The root exits immediately, before cancellation. Its child retains output
    // handles and stays owned by the runner's Job rather than the dead root PID.
    const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','inherit','inherit']}).unref();console.log('root-exited:'+process.pid);process.exit(0)`;
    // Job runner startup can exceed 2.5 s on Windows. Cancel only after the
    // payload reports readiness and its root PID has actually exited.
    const controller = new AbortController();
    let ready: (pid: number) => void = () => {};
    const started = new Promise<number>(resolve => { ready = resolve; });
    const settled = run(parent, { timeoutMs: 10000, signal: controller.signal,
      onUpdate: text => { const match = /root-exited:(\d+)/.exec(text); if (match) ready(Number(match[1])); },
    }).then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
    const pid = await Promise.race([started, settled.then(outcome => {
      throw outcome.error ?? new Error(`Parent finished before readiness: ${outcome.result?.output}`);
    })]);
    const deadline = Date.now() + 2000;
    let rootExited = false;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        rootExited = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    controller.abort();
    const outcome = await settled;
    assert.equal(rootExited, true, "root process exited before cancellation");
    assert.ok(outcome.error instanceof ProcessExecutionError);
    assert.equal(outcome.error.outcome.execution.status, "cancelled");
    assert.match(outcome.error.outcome.output, /root-exited/);
    await new Promise(resolve => setTimeout(resolve, 4000));
    assert.equal(existsSync(marker), false, "child cannot outlive cancellation after its root exited");
  }
  const cancelled = new AbortController();
  const states: ExecutionState[] = [];
  const pending = run("console.log('abort-ready');setTimeout(()=>{},10000)", {
    log: true, onState: value => states.push(value),
    signal: cancelled.signal, onUpdate: text => { if (text.includes("abort-ready")) cancelled.abort(); },
  });
  await assert.rejects(pending, error => {
    assert.ok(error instanceof ProcessExecutionError);
    const outcome = error.outcome as Awaited<ReturnType<typeof runProcess>>;
    assert.match(error.message, /aborted/);
    assert.equal(outcome.execution.status, "cancelled");
    assert.equal(outcome.execution.cleanup.result, "owner_exited");
    assert.ok(outcome.execution.ownerPid);
    assert.match(readFileSync(outcome.logPath!, "utf8"), /abort-ready/);
    return true;
  });
  assert.equal(states[0].phase, "starting");
  assert.ok(states.some(s => s.phase === "stopping"));
  assert.equal(states.at(-1)!.phase, "finished");
  assert.equal(new Set(states.map(s => s.id)).size, 1);
  assert.ok(states.at(-1)!.finishedAt);
  const observerFailure = await run("console.log('observer-independent')", { onState() { throw new Error("observer failure"); } });
  assert.equal(observerFailure.exitCode, 0);
  assert.match(observerFailure.execution.warning!, /observer failed/);
  let ready: () => void = () => {};
  const started = new Promise<void>(resolve => { ready = resolve; });
  const owned = run("console.log('shutdown-ready');setTimeout(()=>{},10000)", {
    onUpdate: text => { if (text.includes("shutdown-ready")) ready(); },
  });
  await started;
  await Promise.all([shutdownProcesses(), shutdownProcesses()]);
  const shutdownResult = await owned;
  assert.notEqual(shutdownResult.exitCode, 0, "shutdown joined and terminated owned work");
  console.log("managed process and bounded log tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
