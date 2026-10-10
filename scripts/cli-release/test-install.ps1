# Exercise the real Windows binary and installer with local release fixtures, never the network.
param([string]$ReleaseDirectory = 'dist/cli-release')
$ErrorActionPreference = 'Stop'
$OriginalLocalAppData = $env:LOCALAPPDATA
$OriginalPath = $env:Path
$OriginalTemp = $env:TEMP
$OriginalTmp = $env:TMP
$OriginalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
$FixtureRelease = Join-Path $FixtureRoot 'release'
New-Item -ItemType Directory -Path $FixtureRelease | Out-Null
Copy-Item (Join-Path $ReleaseDirectory 'fidy-windows-x64.zip*') $FixtureRelease
$Downloads = [Collections.Generic.List[string]]::new()
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  $Downloads.Add($Uri)
  Copy-Item (Join-Path $FixtureRelease ([IO.Path]::GetFileName($Uri))) $OutFile
}
$Extraction = @{ Count = 0 }
function Expand-Archive {
  param([string]$Path, [string]$DestinationPath)
  $Extraction.Count += 1
  Microsoft.PowerShell.Archive\Expand-Archive -Path $Path -DestinationPath $DestinationPath
}
function Write-HostileArchive {
  param([string[]]$Entries, [string]$Symlink = '')
  $ArchivePath = Join-Path $FixtureRelease 'fidy-windows-x64.zip'
  Remove-Item $ArchivePath
  $Zip = [IO.Compression.ZipFile]::Open($ArchivePath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($Name in $Entries) {
      $Entry = $Zip.CreateEntry($Name)
      $Entry.ExternalAttributes = (0x81ed -shl 16)
      if ($Name -ceq $Symlink) { $Entry.ExternalAttributes = (0xa1ff -shl 16) }
      $Output = $Entry.Open()
      try {
        $Bytes = [IO.File]::ReadAllBytes($Installed)
        $Output.Write($Bytes, 0, $Bytes.Length)
      } finally { $Output.Dispose() }
    }
  } finally { $Zip.Dispose() }
  $Digest = (Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText("$ArchivePath.sha256", "$Digest  fidy-windows-x64.zip`n")
}
try {
  $env:TEMP = Join-Path $FixtureRoot 'temporary'
  $env:TMP = $env:TEMP
  New-Item -ItemType Directory -Path $env:TEMP | Out-Null
  if (-not ([IO.Path]::GetTempPath()).StartsWith($FixtureRoot)) {
    throw 'Installer temporary paths are not isolated to the test fixture.'
  }
  $env:LOCALAPPDATA = Join-Path $FixtureRoot 'local'
  & "$PSScriptRoot/install.ps1"
  $Installed = Join-Path $env:LOCALAPPDATA 'Programs\Fidy\fidy.exe'
  $InstalledVersion = & $Installed --version
  if ($LASTEXITCODE -ne 0 -or $InstalledVersion -ne 'fidy 0.1.0') { throw 'Installed executable failed.' }
  $InstalledHelp = (& $Installed --help) -join "`n"
  if ($LASTEXITCODE -ne 0 -or $InstalledHelp -notmatch 'fidy login') { throw 'Installed help failed.' }
  $Zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $FixtureRelease 'fidy-windows-x64.zip'))
  try {
    foreach ($Name in @('BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt')) {
      $Notice = Join-Path $env:LOCALAPPDATA "Programs\Fidy\fidy-$Name"
      $Reader = [IO.StreamReader]::new($Zip.GetEntry($Name).Open())
      try { $ExpectedNotice = $Reader.ReadToEnd() } finally { $Reader.Dispose() }
      if (-not $ExpectedNotice -or (Get-Content -Raw -LiteralPath $Notice) -cne $ExpectedNotice) {
        throw "Installer did not preserve $Name."
      }
    }
  } finally { $Zip.Dispose() }
  if ($Extraction.Count -ne 1) { throw 'Positive installer did not exercise actual extraction.' }
  $PreviousHash = (Get-FileHash $Installed).Hash
  if ($Downloads[0] -notmatch '/cli-v0\.1\.0/fidy-windows-x64\.zip$') { throw 'Unexpected default release.' }
  & "$PSScriptRoot/install.ps1" -Version '0.1.0'
  if ((Get-FileHash $Installed).Hash -ne $PreviousHash) { throw 'Explicit version changed candidate bytes.' }
  $Failure = ''
  try { & "$PSScriptRoot/install.ps1" -Version '0.2.0' } catch { $Failure = $_.Exception.Message }
  if ($Failure -ne 'Release version mismatch.' -or (Get-FileHash $Installed).Hash -ne $PreviousHash) {
    throw 'A mismatched binary version did not preserve installation.'
  }
  foreach ($Version in @('', '../latest', '0.1.0-beta.1', "0.1.0`n")) {
    $BeforeDownloads = $Downloads.Count
    $Rejected = $false
    try { & "$PSScriptRoot/install.ps1" -Version $Version } catch { $Rejected = $true }
    if (-not $Rejected -or $Downloads.Count -ne $BeforeDownloads -or (Get-FileHash $Installed).Hash -ne $PreviousHash) {
      throw 'Invalid version was not rejected before download.'
    }
  }
  $BeforeDownloads = $Downloads.Count
  $Rejected = $false
  try { & "$PSScriptRoot/install.ps1" -Version '0.1.0' 'unexpected' } catch { $Rejected = $true }
  if (-not $Rejected -or $Downloads.Count -ne $BeforeDownloads) { throw 'Extra arguments were accepted.' }
  Set-Content (Join-Path $FixtureRelease 'fidy-windows-x64.zip') 'corrupt download'
  $Rejected = $false
  try { & "$PSScriptRoot/install.ps1" -Version '0.1.0' } catch { $Rejected = $true }
  if (-not $Rejected -or (Get-FileHash $Installed).Hash -ne $PreviousHash) {
    throw 'A corrupt update did not preserve the prior installation.'
  }
  $InstalledPath = $env:Path
  $InstalledUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $AbsoluteEscape = Join-Path $FixtureRoot 'absolute-escape.exe'
  $Cases = @(
    @{ Names = @('../escaped.exe') },
    @{ Names = @('..\escaped.exe') },
    @{ Names = @($AbsoluteEscape) },
    @{ Names = @('fidy.exe', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'extra.exe') },
    @{ Names = @('fidy.exe', 'BUN-LICENSE.txt', 'BUN-LICENSE.txt') },
    @{ Names = @('fidy.exe', 'bun-license.txt', 'THIRD-PARTY-NOTICES.txt') },
    @{ Names = @('fidy.exe', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt'); Symlink = 'BUN-LICENSE.txt' },
    @{ Names = @('fidy.exe', 'BUN-LICENSE.txt', 'THIRD-PARTY-NOTICES.txt'); Symlink = 'fidy.exe' }
  )
  foreach ($Case in $Cases) {
    Write-HostileArchive -Entries $Case.Names -Symlink $Case.Symlink
    $BeforeFiles = @(Get-ChildItem -Recurse -File $FixtureRoot | ForEach-Object FullName | Sort-Object)
    $BeforeExtraction = $Extraction.Count
    $Failure = ''
    try { & "$PSScriptRoot/install.ps1" -Version '0.1.0' } catch { $Failure = $_.Exception.Message }
    $ExpectedFailure = if ($Case.Symlink) { 'Invalid archive entry.' } else { 'Unexpected archive contents.' }
    if ($Failure -ne $ExpectedFailure) {
      throw "Hostile archive did not reach and fail the entry-name gate: $Failure"
    }
    # No extraction means the fresh temporary directory cannot contain an executable to launch.
    if ($Extraction.Count -ne $BeforeExtraction) { throw 'Hostile archive reached extraction.' }
    if ((Get-FileHash $Installed).Hash -ne $PreviousHash) { throw 'Hostile update changed installation.' }
    if ($env:Path -ne $InstalledPath -or
        [Environment]::GetEnvironmentVariable('Path', 'User') -ne $InstalledUserPath) {
      throw 'Hostile update changed PATH.'
    }
    $AfterFiles = @(Get-ChildItem -Recurse -File $FixtureRoot | ForEach-Object FullName | Sort-Object)
    if (Compare-Object $BeforeFiles $AfterFiles) { throw 'Hostile archive created an unexpected file.' }
    if (Test-Path $AbsoluteEscape) { throw 'Absolute archive entry escaped extraction.' }
  }
  Write-Output 'Windows installer verified: real executable, corruption and hostile archive rejection.'
} finally {
  $env:LOCALAPPDATA = $OriginalLocalAppData
  $env:Path = $OriginalPath
  $env:TEMP = $OriginalTemp
  $env:TMP = $OriginalTmp
  [Environment]::SetEnvironmentVariable('Path', $OriginalUserPath, 'User')
  Remove-Item -Recurse -Force $FixtureRoot
}
