# Installs a versioned release for the current user and adds its directory to user PATH.
param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version)
$ErrorActionPreference = 'Stop'
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This release supports Windows x64.' }
$Directory = Join-Path $env:LOCALAPPDATA 'Programs\Fidy'
$Temporary = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
$Archive = 'fidy-windows-x64.zip'
$Base = "https://github.com/B4rz99/fidy-ai/releases/download/cli-v$Version"
New-Item -ItemType Directory -Path $Temporary | Out-Null
try {
  foreach ($File in @($Archive, "$Archive.sha256")) {
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/$File" -OutFile (Join-Path $Temporary $File)
  }
  $Manifest = (Get-Content -Raw (Join-Path $Temporary "$Archive.sha256")).Trim()
  if ($Manifest -notmatch '^([a-f0-9]{64})  fidy-windows-x64\.zip$') { throw 'Invalid checksum manifest.' }
  $Expected = $Matches[1]
  $Actual = (Get-FileHash -Algorithm SHA256 (Join-Path $Temporary $Archive)).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw 'Checksum mismatch; nothing installed.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $Temporary $Archive))
  try {
    if ($Zip.Entries.Count -ne 1 -or $Zip.Entries[0].FullName -ne 'fidy.exe') { throw 'Unexpected archive contents.' }
  } finally { $Zip.Dispose() }
  Expand-Archive -Path (Join-Path $Temporary $Archive) -DestinationPath (Join-Path $Temporary 'extracted')
  $Binary = Join-Path $Temporary 'extracted\fidy.exe'
  $InstalledVersion = & $Binary --version
  if ($LASTEXITCODE -ne 0 -or $InstalledVersion -ne "fidy $Version") { throw 'Release version mismatch.' }
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $Staged = Join-Path $Directory 'fidy.new.exe'
  Copy-Item $Binary $Staged -Force
  Move-Item $Staged (Join-Path $Directory 'fidy.exe') -Force
  $UserPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
  if (($UserPath -split ';') -notcontains $Directory) {
    [Environment]::SetEnvironmentVariable('Path', ($UserPath.TrimEnd(';') + ';' + $Directory), 'User')
  }
  if (($env:Path -split ';') -notcontains $Directory) { $env:Path += ';' + $Directory }
  Write-Output "Installed Fidy $Version. Run: fidy login"
} finally { Remove-Item -Recurse -Force $Temporary }
