import { inspectPowerShellAst, resolvePowerShell7 } from "../shared/powershell-analysis.js";

export interface ElevationIntent {
  kind: "start-process" | "gsudo";
  index: number;
  end: number;
}

// Only an optimization: this never grants permission, and comments/strings still
// pass through the AST visitor before any elevation decision is made.
const CANDIDATE = /(?<![\w-])(?:start-process|saps|start|gsudo(?:\.exe)?)(?![\w-])/i;

const ELEVATION_VISITOR = String.raw`
function Get-LiteralValue($Element, [int]$Depth = 0) {
  if ($Depth -ge 32) { return $null }
  if ($Element -is [System.Management.Automation.Language.StringConstantExpressionAst]) { return $Element.Value }
  if ($Element -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and $Element.NestedExpressions.Count -eq 0) { return $Element.Value }
  if ($Element -is [System.Management.Automation.Language.ParenExpressionAst]) {
    $pipeline = $Element.Pipeline
    if ($pipeline -is [System.Management.Automation.Language.PipelineAst] -and $pipeline.PipelineElements.Count -eq 1) {
      $expression = $pipeline.PipelineElements[0]
      if ($expression -is [System.Management.Automation.Language.CommandExpressionAst] -and $expression.Redirections.Count -eq 0) {
        return (Get-LiteralValue $expression.Expression ($Depth + 1))
      }
    }
    return $null
  }
  if ($Element -is [System.Management.Automation.Language.ConvertExpressionAst] -and
      $Element.Type.TypeName.FullName -in @('string', 'System.String')) {
    return (Get-LiteralValue $Element.Child ($Depth + 1))
  }
  if ($Element -is [System.Management.Automation.Language.CommandParameterAst] -and -not $Element.Argument) { return $Element.Extent.Text }
  return $null
}
foreach ($command in $ast.FindAll({ param($a) $a -is [System.Management.Automation.Language.CommandAst] }, $true)) {
  $name = $command.GetCommandName()
  if (-not $name) { continue }
  $leaf = ($name -split '[\\/]')[-1]
  $elements = $command.CommandElements
  if ($leaf -in @('Start-Process', 'saps', 'start')) {
    for ($i = 1; $i -lt $elements.Count; $i++) {
      $parameter = $elements[$i]
      if ($parameter -isnot [System.Management.Automation.Language.CommandParameterAst] -or
          -not 'Verb'.StartsWith($parameter.ParameterName, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $value = $parameter.Argument
      if (-not $value -and $i + 1 -lt $elements.Count) { $value = $elements[$i + 1] }
      if ((Get-LiteralValue $value) -ieq 'RunAs') {
        [pscustomobject]@{ kind = 'start-process'; index = $parameter.Extent.StartOffset; end = $value.Extent.EndOffset } | ConvertTo-Json -Compress
      }
    }
  } elseif ($leaf -match '^gsudo(\.exe)?$') {
    # gsudo 2.6 local help: status and config reads, cache off/help, help and
    # credential reset do not launch a privileged payload. Unknown forms prompt.
    $values = @()
    $literal = $true
    for ($i = 1; $i -lt $elements.Count; $i++) {
      $value = Get-LiteralValue $elements[$i]
      if ($null -eq $value) { $literal = $false }
      $values += $value
    }
    $readOnly = $false
    if ($literal -and $values.Count -gt 0) {
      if ($values[0] -ieq 'status' -and ($values.Count -eq 1 -or
          ($values.Count -eq 2 -and ($values[1] -ieq '--json' -or -not $values[1].StartsWith('-'))) -or
          ($values.Count -eq 3 -and -not $values[1].StartsWith('-') -and $values[2] -ieq '--no-output'))) { $readOnly = $true }
      if ($values[0] -ieq 'config' -and ($values.Count -eq 1 -or ($values.Count -eq 2 -and -not $values[1].StartsWith('-')))) { $readOnly = $true }
      if ($values.Count -eq 1 -and $values[0] -in @('--help', '-k', '--reset-timestamp')) { $readOnly = $true }
      if ($values.Count -eq 2 -and $values[0] -ieq 'cache' -and $values[1] -in @('off', 'help')) { $readOnly = $true }
    }
    if (-not $readOnly) {
      [pscustomobject]@{ kind = 'gsudo'; index = $command.Extent.StartOffset; end = $command.Extent.EndOffset } | ConvertTo-Json -Compress
    }
  }
}
`;

/** Static command positions only; never executes source or resolves user aliases.
 * Dynamic verbs, splatting, dependencies and native programs' internal UAC are
 * outside this heuristic. A failed inspection must not become an authorization. */
export async function detectElevationIntents(source: string, signal?: AbortSignal): Promise<ElevationIntent[]> {
  signal?.throwIfAborted();
  if (!CANDIDATE.test(source.replaceAll("`", ""))) return [];
  const executable = await resolvePowerShell7(process.env, signal);
  const output = await inspectPowerShellAst(source, ELEVATION_VISITOR, executable, process.env, signal);
  signal?.throwIfAborted();
  return output.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const value = JSON.parse(line) as ElevationIntent;
    if (!value || !["start-process", "gsudo"].includes(value.kind) || !Number.isInteger(value.index) ||
        !Number.isInteger(value.end) || value.index < 0 || value.end <= value.index || value.end > source.length) {
      throw new Error("Invalid PowerShell elevation inspection result");
    }
    return value;
  });
}
