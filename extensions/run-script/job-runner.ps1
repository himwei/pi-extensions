$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -Path (Join-Path $PSScriptRoot 'job-runner.cs')
    $application = Get-Command -Name $request.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if ($application.Source -notmatch '\.exe$') {
        throw 'Managed execution requires a native executable; invoke cmd.exe explicitly for .cmd/.bat files.'
    }
    $code = [PiJobRunner]::Run($application.Source, [string[]]$request.args, $request.cwd)
    exit $code
} catch {
    [Console]::Error.WriteLine(('Pi managed process launch/cleanup failed: ' + $_.Exception.Message))
    exit 125
}
