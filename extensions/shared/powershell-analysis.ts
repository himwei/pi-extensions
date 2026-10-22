import { execFile, spawn } from "node:child_process";
import { basename } from "node:path";

/** Resolve the configured interpreter without evaluating the inspected source. */
export async function resolvePowerShell7(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const executable = env.PI_POWERSHELL_EXE?.trim() || "pwsh.exe";
  if (/^powershell(?:\.exe)?$/i.test(basename(executable))) {
    throw new Error("Windows PowerShell 5.1 is unsupported. Use pwsh 7+; PI_POWERSHELL_EXE must point to pwsh.");
  }
  return new Promise((resolve, reject) => {
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::WriteLine(('{0}|{1}|{2}' -f $PSVersionTable.PSEdition, $PSVersionTable.PSVersion.Major, ([IO.Path]::Combine($PSHOME, 'pwsh.exe'))))"],
    { env, signal, timeout: 10_000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      if (error) { reject(error); return; }
      const match = /^Core\|(\d+)\|(.+)$/m.exec(stdout.trim());
      if (!match || Number(match[1]) < 7) {
        reject(new Error("PowerShell Core 7+ is required; the configured interpreter failed version validation."));
      } else {
        resolve(match[2].trim());
      }
    });
  });
}

/** Run a trusted AST visitor against stdin. The source is parsed, never invoked.
 * Recovered ASTs are intentional: the execution layer owns syntax diagnostics. */
export async function inspectPowerShellAst(
  source: string, visitor: string, executable: string, env: NodeJS.ProcessEnv, signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const checker = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; $PSModuleAutoLoadingPreference = 'None'; Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop; $ast = [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$null);\n" + visitor;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", checker], {
      env, signal, timeout: 30_000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    let bytes = 0;
    const collect = (isError: boolean, chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > 1024 * 1024) {
        child.kill();
        reject(new Error("PowerShell AST inspection exceeded its output limit"));
        return;
      }
      if (isError) errors += chunk;
      else output += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => collect(false, chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => collect(true, chunk));
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error((output + errors).trim() || "PowerShell invocation check failed")));
    child.stdin.end(source, "utf8");
  });
}
