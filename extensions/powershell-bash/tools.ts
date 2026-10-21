import { Type } from "typebox";
import { createBashToolDefinition, createPowerShellToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createPowerShellOperations } from "./operations.js";
import { executionSchema, executionText, type ExecutionState } from "../run-script/execution.js";
import type { ExecOutcome } from "../run-script/process.js";
import { executionObserver } from "../shared/harness-diagnostics.js";

export function observedShell(cwd: string, name: "bash" | "powershell", pi: ExtensionAPI) {
  const factory = name === "bash" ? createBashToolDefinition : createPowerShellToolDefinition;
  const base = factory(cwd);
  return {
    ...base,
    outputSchema: Type.Intersect([base.outputSchema!, Type.Object({ execution: Type.Optional(executionSchema) })]),
    async execute(id: string, input: Parameters<typeof base.execute>[1], signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof base.execute>[3], ctx: Parameters<typeof base.execute>[4]) {
      let state: ExecutionState | undefined;
      let outcome: ExecOutcome | undefined;
      const record = executionObserver(pi, ctx, name, id);
      const withState = <T extends { content: AgentToolResult<unknown>["content"]; details?: unknown; structuredContent?: unknown }>(result: T) => state ? {
        ...result,
        content: [...result.content, { type: "text" as const, text: executionText(state) }],
        details: { ...(result.details as object | undefined), execution: state },
        ...(result.structuredContent ? { structuredContent: { ...result.structuredContent as object, execution: state } } : {}),
      } : result;
      const operations = createPowerShellOperations(value => {
        state = value; record(value);
        if (!signal?.aborted) onUpdate?.(withState({ content: [], details: {} }));
      }, value => { outcome = value; });
      const native = factory(ctx?.cwd ?? cwd, { operations });
      try {
        const result = await native.execute(id, input, signal, value => onUpdate?.(withState(value)), ctx);
        return withState(result);
      } catch (error) {
        // Keep Pi cancellation semantics; the terminal state is already in the session audit.
        if (signal?.aborted || !state || !outcome) throw error;
        const text = error instanceof Error ? error.message : String(error);
        const truncated = outcome.tailDropped || outcome.totalBytes > DEFAULT_MAX_BYTES || outcome.totalLines > DEFAULT_MAX_LINES;
        return withState({ content: [{ type: "text" as const, text }], details: {}, isError: true,
          structuredContent: { output: text, truncated, exit_code: outcome.exitCode,
            ...(truncated && outcome.logPath ? { full_output_path: outcome.logPath } : {}),
            wall_time_seconds: state.elapsedMs / 1000 } });
      }
    },
  };
}
