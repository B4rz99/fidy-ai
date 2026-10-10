# Installs a versioned release for the current user and adds its directory to user PATH.
param([ValidateNotNullOrEmpty()][ValidatePattern('\A[0-9]+\.[0-9]+\.[0-9]+\z')][string]$Version = '0.1.0')
$ErrorActionPreference = 'Stop'
if ($args.Count -ne 0) { throw 'Usage: .\install.ps1 [-Version VERSION]' }
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This release supports Windows x64.' }
$Directory = Join-Path $env:LOCALAPPDATA 'Programs\Fidy'
$Temporary = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
$Archive = 'fidy-windows-x64.zip'
$Base = "https://github.com/B4rz99/fidy-ai/releases/download/cli-v$Version"
$Staged = $null
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
    $Names = @('fidy.exe', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt')
    if ($Zip.Entries.Count -ne $Names.Count) { throw 'Unexpected archive contents.' }
    for ($Index = 0; $Index -lt $Names.Count; $Index++) {
      $Entry = $Zip.Entries[$Index]
      if ($Entry.FullName -cne $Names[$Index]) { throw 'Unexpected archive contents.' }
      if (($Entry.ExternalAttributes -shr 16 -band 0xf000) -ne 0x8000 -or $Entry.Length -le 0) {
        throw 'Invalid archive entry.'
      }
    }
  } finally { $Zip.Dispose() }
  Expand-Archive -Path (Join-Path $Temporary $Archive) -DestinationPath (Join-Path $Temporary 'extracted')
  $Binary = Join-Path $Temporary 'extracted\fidy.exe'
  $InstalledVersion = & $Binary --version
  if ($LASTEXITCODE -ne 0 -or $InstalledVersion -ne "fidy $Version") { throw 'Release version mismatch.' }
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  foreach ($Name in @('fidy.exe', 'fidy-BUN-LICENSE.txt', 'fidy-THIRD-PARTY-NOTICES.txt')) {
    $Existing = Get-Item -LiteralPath (Join-Path $Directory $Name) -Force -ErrorAction SilentlyContinue
    if ($Existing -and ($Existing.PSIsContainer -or ($Existing.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
      throw 'Invalid installation destination.'
    }
  }
  foreach ($Name in @('BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt')) {
    $Staged = Join-Path $Directory ('.fidy-' + [Guid]::NewGuid().ToString() + '.tmp')
    Copy-Item (Join-Path $Temporary "extracted\$Name") $Staged
    Move-Item $Staged (Join-Path $Directory "fidy-$Name") -Force
    $Staged = $null
  }
  $Staged = Join-Path $Directory ('.fidy-' + [Guid]::NewGuid().ToString() + '.exe')
  Copy-Item $Binary $Staged -Force
  Move-Item $Staged (Join-Path $Directory 'fidy.exe') -Force
  $Staged = $null
  $UserPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
  if (($UserPath -split ';') -notcontains $Directory) {
    [Environment]::SetEnvironmentVariable('Path', ($UserPath.TrimEnd(';') + ';' + $Directory), 'User')
  }
  if (($env:Path -split ';') -notcontains $Directory) { $env:Path += ';' + $Directory }
  Write-Output "Installed Fidy $Version. Run: fidy login"
} finally {
  if ($Staged -and (Test-Path -LiteralPath $Staged)) { Remove-Item -LiteralPath $Staged -Force }
  Remove-Item -Recurse -Force $Temporary
}
