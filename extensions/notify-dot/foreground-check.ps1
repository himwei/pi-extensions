# Foreground probe for notify-dot. Prints exactly one line: present | away | unknown
# Usage: foreground-check.ps1 [-ExpectedSuffix ' - <session> - <cwd>']
#
# Decision ladder (cheap first):
# 1. Foreground window is not WindowsTerminal.exe                  → away
# 2. Window caption (== active tab title in WT) ends with the
#    expected suffix                                               → present   [~0.4 s]
# 3. UIA on the foreground WT window:
#      our tab (name ends with the suffix) is the selected one    → present
#      our tab exists but another tab is selected                 → away
#      no tab matches our suffix (other WT window, or titles
#      overridden by profile settings) → ancestor process check:
#         foreground WT is in our process tree                    → present
#         otherwise                                               → away
# 4. UIA unavailable → ancestor process check (window level)
# 5. Nothing decidable                                             → unknown
param(
	[Parameter()] [string] $ExpectedSuffix = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

# Window-level fallback: is the foreground process an ancestor of this probe?
function Test-ForegroundIsOurs([uint32] $FgPid) {
	try {
		$map = @{}
		foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId) {
			$map[[uint32]$p.ProcessId] = [uint32]$p.ParentProcessId
		}
		$cur = [uint32]$PID
		for ($i = 0; $i -lt 24 -and $cur -ne 0; $i++) {
			if ($cur -eq $FgPid) { return $true }
			if (-not $map.ContainsKey($cur)) { break }
			$cur = $map[$cur]
		}
		return $false
	}
	catch {
		return $null   # undecidable
	}
}

$hwnd = [Fg]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output 'unknown'; exit 0 }
$fgPid = [uint32]0
[void][Fg]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
if ($fgPid -eq 0) { Write-Output 'unknown'; exit 0 }

$proc = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
if ($proc.ProcessName -ne 'WindowsTerminal') { Write-Output 'away'; exit 0 }

# Stage 1: window caption. WT keeps the caption in sync with the active tab title.
$caption = [System.Text.StringBuilder]::new(1024)
[void][Fg]::GetWindowTextW($hwnd, $caption, 1024)
if ($ExpectedSuffix -ne '' -and $caption.ToString().EndsWith($ExpectedSuffix)) {
	Write-Output 'present'
	exit 0
}

# Stage 2: UIA over the foreground WT window's tabs.
$uiaDecided = $false
$uiaResult = 'unknown'
try {
	Add-Type -AssemblyName UIAutomationClient
	$el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
	$cond = [System.Windows.Automation.PropertyCondition]::new(
		[System.Windows.Automation.AutomationElement]::ControlTypeProperty,
		[System.Windows.Automation.ControlType]::TabItem)
	$tabs = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
	if ($tabs.Count -gt 0) {
		if ($ExpectedSuffix -eq '') {
			$uiaDecided = $true
			$uiaResult = 'present'
		}
		else {
			$found = $false
			foreach ($t in $tabs) {
				if (-not $t.Current.Name.EndsWith($ExpectedSuffix)) { continue }
				$found = $true
				$p = $null
				if ($t.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p) -and $null -ne $p) {
					$uiaDecided = $true
					$uiaResult = $p.Current.IsSelected ? 'present' : 'away'
				}
				break
			}
			if (-not $found) {
				# Our tab is not among this window's tabs: either a different WT
				# window or the profile overrides tab titles. Window-level answer.
				$ancestor = Test-ForegroundIsOurs $fgPid
				if ($null -ne $ancestor) {
					$uiaDecided = $true
					$uiaResult = $ancestor ? 'present' : 'away'
				}
			}
		}
	}
}
catch {
	# UIA unavailable; fall through to the ancestor check.
}

if ($uiaDecided) { Write-Output $uiaResult; exit 0 }
$ancestor = Test-ForegroundIsOurs $fgPid
if ($null -eq $ancestor) { Write-Output 'unknown'; exit 0 }
Write-Output ($ancestor ? 'present' : 'away')
