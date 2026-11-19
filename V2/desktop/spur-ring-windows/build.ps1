param(
    [string]$Python = 'python',
    [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = [IO.Path]::GetFullPath((Join-Path $projectDirectory '../../../artifacts/Spur-Ring-Windows'))
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$environmentDirectory = Join-Path $projectDirectory '.venv'
$buildPython = Join-Path $environmentDirectory 'Scripts/python.exe'
if (!(Test-Path -LiteralPath $buildPython)) {
    & $Python -m venv $environmentDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated Python build environment.' }
    & $buildPython -m pip install --requirement (Join-Path $projectDirectory 'requirements-windows.lock')
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the pinned Windows dependencies.' }
}

Push-Location $projectDirectory
try {
    & $buildPython -m unittest discover -s tests -v
    if ($LASTEXITCODE -ne 0) { throw 'Desktop tests failed; no release was built.' }
    & $buildPython -m PyInstaller --noconfirm --onedir --windowed --name SpurRing `
        --collect-submodules winrt --collect-submodules bleak `
        --distpath $OutputDirectory --workpath (Join-Path $projectDirectory 'build/pyinstaller') `
        --specpath (Join-Path $projectDirectory 'build') launcher.py
    if ($LASTEXITCODE -ne 0) { throw 'Windows executable packaging failed.' }
    & $buildPython collect_licenses.py (Join-Path $OutputDirectory 'SpurRing')
    if ($LASTEXITCODE -ne 0) { throw 'Could not retain upstream license notices.' }
    Copy-Item -LiteralPath (Join-Path $projectDirectory 'README.md') -Destination (Join-Path $OutputDirectory 'SpurRing/README.md')
    Copy-Item -LiteralPath (Join-Path $projectDirectory 'THIRD_PARTY.md') -Destination (Join-Path $OutputDirectory 'SpurRing/THIRD_PARTY.md')
    Copy-Item -LiteralPath (Join-Path $projectDirectory 'PROTOCOL_AUTH.md'),(Join-Path $projectDirectory 'PROTOCOL_RECORDINGS.md') -Destination (Join-Path $OutputDirectory 'SpurRing')
    Write-Output ('Windows build: ' + (Join-Path $OutputDirectory 'SpurRing/SpurRing.exe'))
}
finally {
    Pop-Location
}
