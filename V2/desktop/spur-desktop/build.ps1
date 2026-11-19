param([string]$PythonPath = '', [string]$NodePath = '')
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$repositoryDirectory = (Resolve-Path (Join-Path $projectDirectory '../../..')).Path
$serviceSource = (Resolve-Path (Join-Path $projectDirectory '../spur-ring-windows')).Path
if (-not $PythonPath) {
    $PythonPath = Join-Path $repositoryDirectory '.build-tools/ring-windows-env/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $PythonPath)) { $PythonPath = (Get-Command python.exe).Source }
}
if (-not $NodePath) {
    $NodePath = Join-Path $repositoryDirectory '.build-tools/node_modules/node/bin/node.exe'
    if (-not (Test-Path -LiteralPath $NodePath)) { $NodePath = (Get-Command node.exe).Source }
}
$npmCommand = (Get-Command npm.cmd).Source
$npmCli = Join-Path (Split-Path $npmCommand) 'node_modules/npm/bin/npm-cli.js'
$env:PATH = (Split-Path $NodePath) + ';' + $env:PATH
$previousDirectory = Get-Location
try {
    Set-Location -LiteralPath $serviceSource
    & $PythonPath -m unittest discover -s tests -q
    if ($LASTEXITCODE) { throw 'Python regression tests failed.' }
    & $PythonPath -m PyInstaller --noconfirm --onedir --console --name SpurRingService --collect-submodules winrt --collect-submodules bleak --distpath (Join-Path $projectDirectory 'resources/ring-service-build') --workpath build/service-pyinstaller --specpath build service_launcher.py
    if ($LASTEXITCODE) { throw 'Ring service build failed.' }
    Set-Location -LiteralPath $projectDirectory
    & $NodePath -e "require('fs').cpSync('resources/ring-service-build/SpurRingService','resources/ring-service',{recursive:true,force:true})"
    if ($LASTEXITCODE) { throw 'Ring service packaging failed.' }
    & $PythonPath (Join-Path $serviceSource 'collect_licenses.py') (Join-Path $projectDirectory 'resources/ring-service')
    if ($LASTEXITCODE) { throw 'Runtime notice collection failed.' }
    & $NodePath $npmCli ci --no-fund --no-audit
    if ($LASTEXITCODE) { throw 'Dependency installation failed.' }
    & $NodePath node_modules/electron/install.js
    if ($LASTEXITCODE) { throw 'Electron runtime installation failed.' }
    & $NodePath $npmCli test
    if ($LASTEXITCODE) { throw 'TypeScript tests failed.' }
    & $NodePath $npmCli run package
    if ($LASTEXITCODE) { throw 'Desktop packaging failed.' }
    Write-Output (Join-Path $projectDirectory 'release/win-unpacked/Spur Desktop.exe')
} finally { Set-Location -LiteralPath $previousDirectory }
