import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executionText, type ExecutionState } from "../run-script/execution.js";

const lifecycles = new WeakMap<ExtensionAPI, { generation: number }>();
function lifecycle(pi: ExtensionAPI) {
  let value = lifecycles.get(pi);
  if (!value) {
    value = { generation: 0 };
    lifecycles.set(pi, value);
    const current = value;
    pi.on("session_start", () => { current.generation++; });
    // Let graceful shutdown finish its audit; the next session invalidates late callbacks.
  }
  return value;
}

/** No raw command, script source, argv or output is written to status entries. */
export function executionObserver(pi: ExtensionAPI, ctx: ExtensionContext | undefined, tool: string, callId?: string, step = "execution") {
  let warned = false;
  const current = lifecycle(pi);
  const generation = current.generation;
  return (execution: ExecutionState) => {
    if (current.generation !== generation) return;
    try { pi.appendEntry("execution-status", { version: 1, tool, callId, step, execution }); }
    catch {
      if (!warned) {
        warned = true;
        ctx?.ui?.notify("执行状态记录失败；命令结果保留，但会话诊断可能不完整。", "warning");
      }
    }
  };
}

export function toolAvailability(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">) {
  const active = new Set(pi.getActiveTools());
  return pi.getAllTools().map(tool => ({ name: tool.name, exposure: tool.exposure,
    active: active.has(tool.name), callable: tool.exposure === "codemode" || tool.exposure === "deferred" ||
      (tool.exposure === "direct" && active.has(tool.name)) }));
}

export function registerHarnessDiagnostics(pi: ExtensionAPI): void {
  const current = lifecycle(pi);
  let lastSnapshot = "";
  pi.registerCommand("harness", {
    description: "诊断工具与执行：/harness [tools|execution [操作ID]]",
    handler: async (args, ctx) => {
      const [section = "tools", id] = args.trim().split(/\s+/).filter(Boolean);
      if (section === "tools") {
        const tools = toolAvailability(pi);
        ctx.ui.notify(tools.map(t => `${t.name}: registered=yes, active=${t.active}, nested=${t.callable}, exposure=${t.exposure}`).join("\n") +
          (!tools.some(t => t.name === "run-script") ? "\nrun-script: registered=no, active=false, nested=false" : "") +
          (tools.some(t => t.name === "run-script" && t.exposure === "direct" && !t.active) ?
            "\nPi can restore an earlier session tool list. To explicitly add run-script when resuming, use --tools +run-script; then check /harness tools again. Explicit exclusions still apply." : "") +
          "\nNested callers may impose additional restrictions. No tools were enabled by this command.", "info");
        return;
      }
      if (section !== "execution") { ctx.ui.notify("用法：/harness tools | /harness execution [操作ID]", "warning"); return; }
      const latest = new Map<string, { tool: string; step: string; execution: ExecutionState }>();
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== "execution-status") continue;
        const data = entry.data as { version?: number; tool?: string; step?: string; execution?: ExecutionState } | undefined;
        if (data?.version !== 1 || typeof data.execution?.id !== "string" || !data.execution.cleanup ||
          typeof data.execution.startedAt !== "string" || !Number.isFinite(data.execution.elapsedMs) || (id && data.execution.id !== id)) continue;
        latest.delete(data.execution.id);
        latest.set(data.execution.id, { tool: data.tool ?? "unknown", step: data.step ?? "execution", execution: data.execution });
      }
      const rows = [...latest.values()].slice(-5);
      ctx.ui.notify(rows.length ? rows.map(r => `[${r.tool}/${r.step}]\n${executionText(r.execution)}` +
        (r.execution.phase !== "finished" ? "No terminal observation was recorded; current state is unknown.\n" : "")).join("\n") : "没有对应的执行状态记录。", "info");
    },
  });
  pi.on("before_agent_start", (event, ctx) => {
    const tools = toolAvailability(pi);
    const snapshot = `${current.generation}:${JSON.stringify(tools)}`;
    if (snapshot !== lastSnapshot) {
      try { pi.appendEntry("harness-tools", { version: 1, tools }); lastSnapshot = snapshot; }
      catch { ctx.ui.notify("工具可用性快照写入失败。", "warning"); }
    }
    const tool = tools.find(t => t.name === "run-script");
    return { systemPrompt: event.systemPrompt + "\n\nHarness tool availability for this turn: run-script " +
      `registered=${!!tool}, active=${tool?.active ?? false}, nested=${tool?.callable ?? false}. ` +
      "Do not infer tool availability from old conversation text. Use run-script when directly available; nested access requires a callable gateway. " +
      "If unavailable, use the write tool to save a script, explicitly syntax-check it with the selected interpreter, then execute it by file path. " +
      "If the required file or shell tools are also unavailable, report the limitation instead of inventing an interface. " +
      "Do not inline a complex script or enable restricted tools as a workaround. Separate modification, verification and temporary-file cleanup into independent calls. " +
      "Format heterogeneous PowerShell inspection results explicitly (JSON or separate Format-List/Format-Table | Out-String). " +
      "Cmdlet fail-fast does not propagate native-program failures automatically. Immediately save $LASTEXITCODE after each direct native invocation, " +
      "accept only the exit codes documented for that operation (for example rg 0/1), and exit with any unexpected code before continuing. " +
      "Use explicit exit 0 after an intentionally accepted nonzero result. For Start-Process -Wait -PassThru, check the child object's ExitCode instead. " +
      "Never infer success from the final output or the owner's exited status alone. " +
      "A timeout does not prove cancellation or absence of side effects; verify current state before retrying." };
  });
}
