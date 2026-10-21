import { Type } from "typebox";

/** Describes the process owner we observe, never an inferred UAC/payload state. */
export type ExecutionState = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
  ownerPid?: number;
  phase: "starting" | "owner_started" | "stopping" | "finished";
  status?: "exited" | "timed_out" | "cancelled" | "failed" | "stopped";
  exitCode?: number | null;
  cleanup: {
    requested: boolean;
    scope: "windows-job" | "windows-client-tree" | "process";
    result: "not_requested" | "owner_exited" | "unverified";
  };
  outputLogPath?: string;
  warning?: string;
}

export const executionSchema = Type.Object({
  id: Type.String(), startedAt: Type.String(), finishedAt: Type.Optional(Type.String()), elapsedMs: Type.Number(),
  ownerPid: Type.Optional(Type.Integer()),
  phase: Type.Union([Type.Literal("starting"), Type.Literal("owner_started"), Type.Literal("stopping"), Type.Literal("finished")]),
  status: Type.Optional(Type.Union([Type.Literal("exited"), Type.Literal("timed_out"), Type.Literal("cancelled"), Type.Literal("failed"), Type.Literal("stopped")])),
  exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  cleanup: Type.Object({ requested: Type.Boolean(),
    scope: Type.Union([Type.Literal("windows-job"), Type.Literal("windows-client-tree"), Type.Literal("process")]),
    result: Type.Union([Type.Literal("not_requested"), Type.Literal("owner_exited"), Type.Literal("unverified")]),
  }),
  outputLogPath: Type.Optional(Type.String()), warning: Type.Optional(Type.String()),
});

export function executionText(state: ExecutionState): string {
  const exitCode = typeof state.exitCode === "number" ? `exit code ${state.exitCode}` : "exit code unavailable";
  const result = state.status === "exited" ?
    ` (${state.exitCode === 0 ? "success" : typeof state.exitCode === "number" ? "failure" : "result unknown"}, ${exitCode})` :
    state.status ? ` (${exitCode})` : "";
  let advice = "";
  switch (state.status) {
    case "exited":
      if (state.exitCode !== 0) advice = typeof state.exitCode === "number" ?
        "The command exited with a nonzero code and may have made partial changes. Check output and current state before retrying.\n" :
        "The owner's exit code is unavailable; success is unknown. Check output and current state before retrying.\n";
      break;
    case "timed_out":
      advice = "The command timed out and may have made partial changes. A timeout does not prove nothing ran; verify state before retrying.\n";
      break;
    case "cancelled":
      advice = "The command was cancelled and may have made partial changes. Cancellation does not prove nothing ran; verify state before retrying.\n";
      break;
    case "stopped":
      advice = "The owner stopped; completed effects and descendant state require verification before retrying.\n";
      break;
    case "failed":
      advice = "Execution failed; this status does not establish whether work ran. Check output and current state before retrying.\n";
      break;
  }
  return `Execution ${state.id}: ${state.status ?? state.phase}${result}; ${state.phase === "finished" ? "elapsed" : "observed elapsed"} ${(state.elapsedMs / 1000).toFixed(1)}s; ` +
    `owner PID ${state.ownerPid ?? "unavailable"}; started ${state.startedAt}\n` +
    `Cleanup: ${state.cleanup.result}; scope ${state.cleanup.scope}. ` +
    "Elevated/out-of-Job processes and WSL Linux descendants are not verified.\n" +
    (state.outputLogPath ? `Output log: ${state.outputLogPath}\n` : "") +
    (state.warning ? `warning: ${state.warning}\n` : "") + advice;
}

/** Preserve observed outcomes even when the public process API must reject cancellation. */
export class ProcessExecutionError<T> extends Error {
  constructor(message: string, readonly outcome: T) { super(message); this.name = "ProcessExecutionError"; }
}
