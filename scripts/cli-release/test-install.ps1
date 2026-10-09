# Exercise the real Windows binary and installer with local release fixtures, never the network.
$ErrorActionPreference = 'Stop'
$OriginalLocalAppData = $env:LOCALAPPDATA
$OriginalPath = $env:Path
$OriginalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
$FixtureRelease = Join-Path $FixtureRoot 'release'
New-Item -ItemType Directory -Path $FixtureRelease | Out-Null
Copy-Item 'dist/cli-release/fidy-windows-x64.zip*' $FixtureRelease
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  Copy-Item (Join-Path $FixtureRelease ([IO.Path]::GetFileName($Uri))) $OutFile
}
try {
  $env:LOCALAPPDATA = Join-Path $FixtureRoot 'local'
  & "$PSScriptRoot/install.ps1" -Version '0.1.0'
  $Installed = Join-Path $env:LOCALAPPDATA 'Programs\Fidy\fidy.exe'
  if ((& $Installed --version) -ne 'fidy 0.1.0') { throw 'Installed executable failed.' }
  $PreviousHash = (Get-FileHash $Installed).Hash
  Set-Content (Join-Path $FixtureRelease 'fidy-windows-x64.zip') 'corrupt download'
  $Rejected = $false
  try { & "$PSScriptRoot/install.ps1" -Version '0.1.0' } catch { $Rejected = $true }
  if (-not $Rejected -or (Get-FileHash $Installed).Hash -ne $PreviousHash) {
    throw 'A corrupt update did not preserve the prior installation.'
  }
  Write-Output 'Windows installer verified: real executable and corruption rollback.'
} finally {
  $env:LOCALAPPDATA = $OriginalLocalAppData
  $env:Path = $OriginalPath
  [Environment]::SetEnvironmentVariable('Path', $OriginalUserPath, 'User')
  Remove-Item -Recurse -Force $FixtureRoot
}
