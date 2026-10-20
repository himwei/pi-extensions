import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { runProcess } from "../run-script/process.js";
import { assertNoLegacyInvocation, resolvePowerShell7 } from "../run-script/powershell.js";

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


export function createPowerShellOperations(): BashOperations {
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
