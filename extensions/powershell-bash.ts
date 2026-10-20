import { shutdownProcesses } from "./run-script/process.js";
import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createPowerShellOperations } from "./powershell-bash/operations.js";

export default function (pi: ExtensionAPI) {
  const operations = createPowerShellOperations();
  pi.on("session_shutdown", () => shutdownProcesses());

  pi.on("session_start", (_event, ctx) => {
    const tools = [createBashToolDefinition(ctx.cwd, { operations }), createPowerShellToolDefinition(ctx.cwd, { operations })];
    for (const tool of tools) pi.registerTool({
      ...tool,
      // Keep native powershell opt-in through --tools/defaultTools/setActiveTools.
      ...(tool.name === "powershell" ? { defaultActive: false } : {}),
      label: "PowerShell",
      description:
        "Execute a PowerShell command on Windows using validated PowerShell Core 7+ (PI_POWERSHELL_EXE may select another Core 7+ binary, never 5.1). Explicit legacy PowerShell invocations are blocked using executable AST positions; dynamic invocation is not a sandboxed boundary. Output streams while running and is truncated to Pi's standard 2000-line/50KB limit; complete truncated output is saved to a temporary file. PowerShell uses UTF-8 plain-text output, and Python child processes receive UTF-8 defaults when their encoding environment variables are unset. The default timeout is 120 seconds. Ordinary Windows processes use a kill-on-close Job and the command waits for descendants; timeout/cancellation ends that Job. Direct WSL calls use client process-tree cleanup, which cannot guarantee termination of all Linux descendants.",
      promptSnippet:
        "Execute PowerShell commands on Windows (Get-ChildItem, Select-String, Remove-Item, git, npm, etc.)",
      promptGuidelines: [
        `Use ${tool.name} to run shell commands through validated PowerShell Core 7+; Windows PowerShell 5.1 is unsupported.`,
        "Use PowerShell syntax and cmdlets when shell behavior matters; common aliases such as ls, cat, rm, cp, mv, and mkdir are available.",
        "Prefer rg and rg --files for text and file search; use PowerShell cmdlets when appropriate.",
        "Specify -Encoding utf8 when writing text with Out-File or Set-Content.",
        "Python commands inherit UTF-8 defaults via PYTHONUTF8 and PYTHONIOENCODING when those variables are unset; override them only for an explicit compatibility requirement.",
        "Non-terminating cmdlet errors stop the command with a failing exit code; pass an explicit -ErrorAction such as SilentlyContinue when partial results are intended.",
      ],
    });
  });

  pi.on("user_bash", () => ({ operations }));
}
