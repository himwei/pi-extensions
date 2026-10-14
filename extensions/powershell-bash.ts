import { runProcess, shutdownProcesses } from "./run-script/process.js";
import {
  createBashToolDefinition,
  type BashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { assertNoLegacyInvocation, resolvePowerShell7 } from "./run-script/powershell.js";


const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const POWERSHELL_ENCODING_PREFIX = [
  "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$OutputEncoding = [Console]::OutputEncoding",
  "if ($null -eq $env:PYTHONUTF8) { $env:PYTHONUTF8 = '1' }",
  "if ($null -eq $env:PYTHONIOENCODING) { $env:PYTHONIOENCODING = 'utf-8' }",
  "$ErrorActionPreference = 'Stop'",
  "if ($null -ne $PSStyle) { $PSStyle.OutputRendering = 'PlainText' }",
].join("\n");


function createPowerShellOperations(): BashOperations {
  return {
    async exec(command, cwd, options) {
      if (options.signal?.aborted) {
        return Promise.reject(new Error("aborted"));
      }

      const timeoutSeconds = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        return Promise.reject(new Error("Invalid timeout: must be a finite positive number of seconds"));
      }
      if (timeoutSeconds > MAX_TIMEOUT_SECONDS) {
        return Promise.reject(new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
      }

      const env = options.env ?? process.env;
      const executable = await resolvePowerShell7(env, options.signal);
      const usesWsl = await assertNoLegacyInvocation(command, executable, env, options.signal);
      const script = `${POWERSHELL_ENCODING_PREFIX}\n${command}`;

      const result = await runProcess(executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        cwd, { env, signal: options.signal, timeoutMs: timeoutSeconds * 1000, onData: options.onData, windowsJob: !usesWsl });
      if (result.timedOut) throw new Error(`timeout:${timeoutSeconds}`);
      return { exitCode: result.exitCode };
    },
  };
}

export default function (pi: ExtensionAPI) {
  const operations = createPowerShellOperations();
  pi.on("session_shutdown", () => shutdownProcesses());

  pi.on("session_start", (_event, ctx) => {
    const bashTool = createBashToolDefinition(ctx.cwd, { operations });

    pi.registerTool({
      ...bashTool,
      label: "PowerShell",
      description:
        "Execute a PowerShell command on Windows using validated PowerShell Core 7+ (PI_POWERSHELL_EXE may select another Core 7+ binary, never 5.1). Explicit legacy PowerShell invocations are blocked using executable AST positions; dynamic invocation is not a sandboxed boundary. Output streams while running and is truncated to Pi's standard 2000-line/50KB limit; complete truncated output is saved to a temporary file. PowerShell uses UTF-8 plain-text output, and Python child processes receive UTF-8 defaults when their encoding environment variables are unset. The default timeout is 120 seconds. Ordinary Windows processes use a kill-on-close Job and the command waits for descendants; timeout/cancellation ends that Job. Direct WSL calls use client process-tree cleanup, which cannot guarantee termination of all Linux descendants.",
      promptSnippet:
        "Execute PowerShell commands on Windows (Get-ChildItem, Select-String, Remove-Item, git, npm, etc.)",
      promptGuidelines: [
        "Use bash to run shell commands. On this Windows system, bash executes commands through validated PowerShell Core 7+; Windows PowerShell 5.1 is unsupported.",
        "Use PowerShell syntax and cmdlets when shell behavior matters; common aliases such as ls, cat, rm, cp, mv, and mkdir are available.",
        "Use Get-ChildItem -Recurse for recursive file discovery and Select-String or rg for text search.",
        "Use Out-File or Set-Content when explicit output encoding is important.",
        "Python commands run through bash inherit UTF-8 defaults via PYTHONUTF8 and PYTHONIOENCODING when those variables are unset; override them only for an explicit compatibility requirement.",
        "Non-terminating cmdlet errors stop the command with a failing exit code; pass an explicit -ErrorAction such as SilentlyContinue when partial results are intended.",
      ],
    });
  });

  pi.on("user_bash", () => ({ operations }));
}
