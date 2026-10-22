import { inspectPowerShellAst } from "../shared/powershell-analysis.js";
export { resolvePowerShell7 } from "../shared/powershell-analysis.js";

/** Normalize only the optional UTF-8 BOM. Never replace malformed bytes or
 * guess an encoding; NUL-containing sources also reject BOM-less UTF-16/32. */
export function decodePowerShellSource(bytes: Uint8Array): string {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("PowerShell source must be valid UTF-8 (with or without BOM). Save explicitly as UTF-8 before retrying; no encoding conversion was performed.");
  }
  if (source.includes("\0")) {
    throw new Error("PowerShell source contains NUL bytes; UTF-16/UTF-32 and binary source files are not supported. Save explicitly as UTF-8 before retrying; no encoding conversion was performed.");
  }
  return source;
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
  const output = await inspectPowerShellAst(source, LEGACY_COMMAND_CHECK + "\nif ($legacy) { exit 1 }; $hasWsl = $ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] -and $a.GetCommandName() -and (($a.GetCommandName() -split '[\\\\/]')[-1] -match '^wsl(\\.exe)?$') }, $true).Count -gt 0; if ($hasWsl) { [Console]::WriteLine('PI_DIRECT_WSL') }", executable, env, signal);
  return output.includes("PI_DIRECT_WSL");
}
