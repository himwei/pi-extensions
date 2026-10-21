import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { finished } from "node:stream/promises";
import { resolvePowerShell7 } from "./powershell.js";
import { ProcessExecutionError, type ExecutionState } from "./execution.js";

const MEMORY_TAIL_CHARS = 256 * 1024;
const STREAM_VIEW_CHARS = 4000;
const STREAM_THROTTLE_MS = 250;
const DEFAULT_MAX_LOG_BYTES = 64 * 1024 * 1024;
const running = new Set<() => Promise<void>>();

/** The runner outlives the payload and retains the Job until every ordinary
 * Windows descendant exits. Termination closes its sole kill-on-close handle.
 * WSL Linux processes and elevated/out-of-Job processes are outside this owner. */
export async function terminateProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") { child.kill("SIGKILL"); return; }
  await new Promise<void>(resolve => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore",
    });
    const fallback = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
    killer.once("error", () => { fallback(); resolve(); });
    killer.once("close", code => { if (code !== 0) fallback(); resolve(); });
  });
}

/** Idempotent session cleanup shared by the shell and script extensions. */
export async function shutdownProcesses(): Promise<void> {
  await Promise.all([...running].map(stop => stop()));
}

export interface ExecOutcome {
  execution: ExecutionState;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  totalBytes: number;
  totalLines: number;
  tailDropped: boolean;
  logPath?: string;
  logWarning?: string;
}

/** Independent UTF-8 decoders, bounded memory/disk output and an owned Windows
 * Job. Log failure degrades output recovery, never the command's exit result. */
export async function runProcess(exe: string, args: string[], cwd: string, options: {
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onUpdate?: (snapshot: string) => void;
  onData?: (data: Buffer) => void;
  log?: boolean;
  maxLogBytes?: number;
  logDirectory?: string;
  onState?: (state: ExecutionState) => void;
  /** WSL brokers outlive commands; use client-tree cleanup for WSL calls. */
  windowsJob?: boolean;
}): Promise<ExecOutcome> {
  options.signal?.throwIfAborted();
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2147483647) {
    throw new Error("Invalid process timeout");
  }
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  if (!Number.isSafeInteger(maxLogBytes) || maxLogBytes <= 0) throw new Error("Invalid log byte limit");
  const env = options.env ?? process.env;
  // An explicitly supplied pwsh path has already been validated by its caller;
  // other payloads resolve Core 7+ for the Job runner before any user code runs.
  const runner = process.platform === "win32" && options.windowsJob !== false && !/^wsl\.exe$/i.test(basename(exe))
    ? (/^pwsh\.exe$/i.test(basename(exe)) ? exe : await resolvePowerShell7(env, options.signal)) : undefined;
  options.signal?.throwIfAborted();
  const started = performance.now();
  let execution: ExecutionState = { id: randomUUID(), startedAt: new Date().toISOString(), elapsedMs: 0,
    phase: "starting", cleanup: { requested: false,
      scope: runner ? "windows-job" : process.platform === "win32" ? "windows-client-tree" : "process", result: "not_requested" } };
  const publish = (changes: Partial<ExecutionState> = {}) => {
    execution = Object.fromEntries(Object.entries({ ...execution, ...changes,
      elapsedMs: Math.max(0, performance.now() - started) }).filter(([, value]) => value !== undefined)) as ExecutionState;
    // Observability must not turn a successful command into a failed mutation.
    try { options.onState?.({ ...execution, cleanup: { ...execution.cleanup } }); }
    catch { execution = { ...execution, warning: "Execution status observer failed; diagnostics may be incomplete." }; }
  };
  publish();
  const child = spawn(runner ?? exe, runner
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(__dirname, "job-runner.ps1")]
    : args, { cwd, env, windowsHide: true, stdio: [runner ? "pipe" : "ignore", "pipe", "pipe"] });

  let output = "", totalBytes = 0, totalLines = 1;
  let tailDropped = false, timedOut = false;
  let failure: Error | undefined;
  let logWarning: string | undefined;
  const logPath = options.log ? join(options.logDirectory ?? tmpdir(), `pi-run-script-${execution.id}.log`) : undefined;
  const log = logPath ? createWriteStream(logPath, { encoding: "utf8", flags: "wx" }) : undefined;
  const logDone = log ? finished(log).then(() => undefined, error => error as Error) : undefined;
  let logOwned = false;
  let logDisabled = false;
  let updateTimer: NodeJS.Timeout | undefined;
  let lastUpdate = -Infinity;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (execution.phase === "finished") return stopping ?? Promise.resolve();
    if (!stopping) publish({ phase: "stopping", cleanup: { ...execution.cleanup, requested: true, result: "unverified" } });
    child.stdout!.resume(); child.stderr!.resume();
    return stopping ??= terminateProcessTree(child);
  };
  let closed: Promise<number | null>;
  const dispose = async () => { await stop(); await closed; };
  running.add(dispose);
  const callbackFailed = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    void stop();
  };
  const emit = () => {
    lastUpdate = performance.now();
    let view = output.slice(-STREAM_VIEW_CHARS);
    if (/^[\uDC00-\uDFFF]/.test(view)) view = view.slice(1);
    try { options.onUpdate?.(view); } catch (error) { callbackFailed(error); }
  };
  const schedule = () => {
    if (!options.onUpdate) return;
    const delay = STREAM_THROTTLE_MS - (performance.now() - lastUpdate);
    if (delay <= 0) {
      if (updateTimer) clearTimeout(updateTimer);
      updateTimer = undefined;
      emit();
    } else if (!updateTimer) updateTimer = setTimeout(() => { updateTimer = undefined; emit(); }, delay);
  };
  const disableLog = (why: string) => {
    if (logDisabled) return;
    logDisabled = true;
    logWarning = why;
    log?.destroy();
    child.stdout!.resume(); child.stderr!.resume();
  };
  const append = (text: string) => {
    totalBytes += Buffer.byteLength(text, "utf8");
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) totalLines++;
    output += text;
    if (output.length > MEMORY_TAIL_CHARS) {
      output = output.slice(-MEMORY_TAIL_CHARS);
      if (/^[\uDC00-\uDFFF]/.test(output)) output = output.slice(1);
      tailDropped = true;
    }
    try { options.onData?.(Buffer.from(text, "utf8")); } catch (error) { callbackFailed(error); }
    if (log && !logDisabled) {
      if (totalBytes > maxLogBytes) disableLog(`Full output log exceeded ${maxLogBytes} bytes; only the retained tail is available.`);
      else if (!log.write(text)) { child.stdout!.pause(); child.stderr!.pause(); }
    }
    schedule();
  };
  child.stdout!.setEncoding("utf8").on("data", append);
  child.stderr!.setEncoding("utf8").on("data", append);
  log?.once("open", () => { logOwned = true; publish({ outputLogPath: logPath }); });
  log?.on("drain", () => { child.stdout!.resume(); child.stderr!.resume(); });
  log?.on("error", error => disableLog(`Full output log unavailable: ${error.message}`));
  child.stdin?.on("error", error => { if (!options.signal?.aborted && !timedOut) callbackFailed(error); });
  closed = new Promise<number | null>(resolve => {
    child.once("error", error => { failure ??= error; });
    child.once("close", resolve);
  });
  child.once("spawn", () => publish({ ownerPid: child.pid, phase: "owner_started" }));
  if (runner) child.stdin!.end(JSON.stringify({ exe, args, cwd }), "utf8");
  const abort = () => { void stop(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; void stop(); }, options.timeoutMs);
  let exitCode: number | null;
  try {
    exitCode = await closed;
    await stopping;
  } finally {
    clearTimeout(timer);
    if (updateTimer) clearTimeout(updateTimer);
    options.signal?.removeEventListener("abort", abort);
    running.delete(dispose);
    if (log && !logDisabled) log.end();
  }
  const logError = await logDone;
  if (logError && !logDisabled) disableLog(`Full output log unavailable: ${logError.message}`);
  if (logDisabled && logOwned && logPath) await unlink(logPath).catch(() => { /* Incomplete log is never advertised. */ });
  if (options.onUpdate) emit();
  publish({ phase: "finished", finishedAt: new Date().toISOString(), exitCode,
    status: timedOut ? "timed_out" : options.signal?.aborted ? "cancelled" : failure ? "failed" : stopping ? "stopped" : "exited",
    cleanup: { ...execution.cleanup, result: execution.cleanup.requested ?
      (child.exitCode !== null || child.signalCode !== null ? "owner_exited" : "unverified") : "not_requested" },
    outputLogPath: logDisabled ? undefined : logPath,
    warning: [execution.warning, logWarning].filter(Boolean).join("; ") || undefined });
  const outcome: ExecOutcome = { execution, exitCode, output, timedOut, totalBytes, totalLines, tailDropped,
    logPath: logDisabled ? undefined : logPath, logWarning };
  if (options.signal?.aborted) throw new ProcessExecutionError("aborted", outcome);
  if (failure) throw new ProcessExecutionError(failure.message, outcome);
  return outcome;
}
