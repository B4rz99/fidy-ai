# Exercise the real Windows binary and installer with local release fixtures, never the network.
$ErrorActionPreference = 'Stop'
$OriginalLocalAppData = $env:LOCALAPPDATA
$OriginalPath = $env:Path
$OriginalTemp = $env:TEMP
$OriginalTmp = $env:TMP
$OriginalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
$FixtureRelease = Join-Path $FixtureRoot 'release'
New-Item -ItemType Directory -Path $FixtureRelease | Out-Null
Copy-Item 'dist/cli-release/fidy-windows-x64.zip*' $FixtureRelease
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  Copy-Item (Join-Path $FixtureRelease ([IO.Path]::GetFileName($Uri))) $OutFile
}
$ExtractionCount = 0
function Expand-Archive {
  param([string]$Path, [string]$DestinationPath)
  $script:ExtractionCount += 1
  Microsoft.PowerShell.Archive\Expand-Archive -Path $Path -DestinationPath $DestinationPath
}
function Write-HostileArchive {
  param([string[]]$Entries)
  $ArchivePath = Join-Path $FixtureRelease 'fidy-windows-x64.zip'
  Remove-Item $ArchivePath
  $Zip = [IO.Compression.ZipFile]::Open($ArchivePath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($Name in $Entries) {
      $Entry = $Zip.CreateEntry($Name)
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
  & "$PSScriptRoot/install.ps1" -Version '0.1.0'
  $Installed = Join-Path $env:LOCALAPPDATA 'Programs\Fidy\fidy.exe'
  if ((& $Installed --version) -ne 'fidy 0.1.0') { throw 'Installed executable failed.' }
  if ($ExtractionCount -ne 1) { throw 'Positive installer did not exercise actual extraction.' }
  $PreviousHash = (Get-FileHash $Installed).Hash
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
    @{ Names = @('fidy.exe', 'extra.exe') }
  )
  foreach ($Case in $Cases) {
    Write-HostileArchive -Entries $Case.Names
    $BeforeFiles = @(Get-ChildItem -Recurse -File $FixtureRoot | ForEach-Object FullName | Sort-Object)
    $BeforeExtraction = $ExtractionCount
    $Failure = ''
    try { & "$PSScriptRoot/install.ps1" -Version '0.1.0' } catch { $Failure = $_.Exception.Message }
    if ($Failure -ne 'Unexpected archive contents.') {
      throw "Hostile archive did not reach and fail the entry-name gate: $Failure"
    }
    # No extraction means the fresh temporary directory cannot contain an executable to launch.
    if ($ExtractionCount -ne $BeforeExtraction) { throw 'Hostile archive reached extraction.' }
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
