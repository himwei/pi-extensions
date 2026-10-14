import { execFile, spawn } from "node:child_process";
import { basename } from "node:path";

/** Resolve and validate the actual interpreter on every call; overrides may only select Core 7+. */
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

/** Embedded in the AST checker. Only executable command positions are inspected:
 * comments and ordinary strings are never treated as commands. Dynamic values are unresolved. */
export const LEGACY_COMMAND_CHECK = String.raw`
function Test-LegacyExecutable($Value) {
  if (-not $Value) { return $false }
  $leaf = ($Value -split '[\\/]')[-1]
  return $leaf -match '^powershell(\.exe)?$'
}
$legacy = $false
$ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
  $command = $_
  $name = $command.GetCommandName()
  $target = $null
  if (Test-LegacyExecutable $name) { $target = $name }
  if ($name -and (($name -split '\\')[-1] -in @('Start-Process', 'saps', 'start'))) {
    $elements = $command.CommandElements
    # An explicitly named FilePath takes precedence over positional arguments,
    # wherever it appears; -File/-Fi/-F are valid parameter abbreviations.
    $namedPath = $false
    for ($i = 1; $i -lt $elements.Count; $i++) {
      $e = $elements[$i]
      if ($e -is [System.Management.Automation.Language.CommandParameterAst] -and
          'FilePath'.StartsWith($e.ParameterName, [StringComparison]::OrdinalIgnoreCase)) {
        $namedPath = $true
        $v = $e.Argument
        if (-not $v -and $i + 1 -lt $elements.Count) { $v = $elements[$i + 1] }
        if ($v -is [System.Management.Automation.Language.StringConstantExpressionAst] -and (Test-LegacyExecutable $v.Value)) { $target = $v.Value }
        break
      }
    }
    if (-not $namedPath) {
      for ($i = 1; $i -lt $elements.Count; $i++) {
        $e = $elements[$i]
        if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
          if (-not $e.Argument -and $e.ParameterName -notin @('Wait', 'PassThru', 'NoNewWindow', 'UseNewEnvironment', 'LoadUserProfile', 'Verbose', 'Debug', 'WhatIf', 'Confirm')) { $i++ }
          continue
        }
        if ($e -is [System.Management.Automation.Language.StringConstantExpressionAst] -and (Test-LegacyExecutable $e.Value)) { $target = $e.Value }
        break
      }
    }
  }
  if ($target) {
    [pscustomobject]@{ line = $command.Extent.StartLineNumber; col = $command.Extent.StartColumnNumber;
      message = "Windows PowerShell 5.1 invocation '$target' is blocked. Use pwsh 7+. For elevation: Start-Process -FilePath pwsh -Verb RunAs -ArgumentList '-NoProfile -File ""C:\path\script.ps1""'";
      severity = 'error' } | ConvertTo-Json -Compress
    $script:legacy = $true
  }
}
`;

/** Validate literal legacy invocations and report direct WSL invocations for
 * client-tree execution; WSL brokers cannot use ordinary Job completion. */
export async function assertNoLegacyInvocation(source: string, executable: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean> {
  const checker = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $PSModuleAutoLoadingPreference = 'None'; Import-Module ([IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop; $ast = [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$null);\n" + LEGACY_COMMAND_CHECK + "\nif ($legacy) { exit 1 }; $hasWsl = $ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] -and $a.GetCommandName() -and (($a.GetCommandName() -split '[\\\\/]')[-1] -match '^wsl(\\.exe)?$') }, $true).Count -gt 0; if ($hasWsl) { [Console]::WriteLine('PI_DIRECT_WSL') }";
  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", checker], {
      env, signal, timeout: 30_000, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output.includes("PI_DIRECT_WSL")) : reject(new Error(output.trim() || "PowerShell invocation check failed")));
    child.stdin.end(source, "utf8");
  });
}
