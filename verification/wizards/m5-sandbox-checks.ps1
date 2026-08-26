[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('ConfirmRun', 'Installed', 'InstallFixture', 'PipelineTools', 'Collect', 'ValidateGuestEvidence', 'ValidateScreenshot', 'ConfirmScreenshotVisual', 'ValidateCopied')]
    [string]$Action,
    [string]$SessionDirectory,
    [string]$KitDirectory,
    [string]$OutboxDirectory,
    [string]$HostEvidenceDirectory,
    [string]$ExpectedRunId,
    [string]$ExpectedManifestSha256,
    [string]$ExpectedHostHelperSha256,
    [ValidateSet('guest-confirm', 'installed-check', 'pipeline-tools-check', 'collection')]
    [string]$EvidenceKind,
    [ValidateSet('smartscreen-reputation', 'first-run-obs-not-found', 'helper-hid', 'missing-pipeline', 'obs-preflight', 'live-pipeline', 'live-report')]
    [string]$ScreenshotKind,
    [string]$AttemptMarkerPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$EvidenceSchema = 'm5-sandbox-evidence-v2'
$ManifestSchema = 'm5-sandbox-kit-v2'
$TrustedHelperPath = $MyInvocation.MyCommand.Path
$GuestActions = @('ConfirmRun', 'Installed', 'InstallFixture', 'PipelineTools', 'Collect')
$HostActions = @('ValidateGuestEvidence', 'ValidateScreenshot', 'ConfirmScreenshotVisual', 'ValidateCopied')

if (-not $KitDirectory) { $KitDirectory = $PSScriptRoot }
if (-not $OutboxDirectory) {
    if (Test-Path -LiteralPath 'C:\M5Outbox' -PathType Container) { $OutboxDirectory = 'C:\M5Outbox' } else { $OutboxDirectory = Join-Path (Split-Path -Parent $KitDirectory) 'outbox' }
}
$ManifestPath = Join-Path $KitDirectory 'kit-manifest.json'

$RequiredChecks = @{
    'guest-confirm' = @('runIdentityPresent', 'manifestSchemaMatches', 'installerMatchesManifest', 'wheelMatchesManifest', 'helperMatchesManifest', 'bundledFfmpegMatchesManifest', 'bundledFfprobeMatchesManifest', 'installerMotwZoneId3')
    'installed-check' = @('installDirectoryFound', 'recorderExeExists', 'captureHelperExists', 'captureHelperMatchesKit', 'startMenuShortcutExists')
    'pipeline-tools-check' = @('cliOnPath', 'cliRuns', 'python311OrNewer', 'ffmpegBundledInPackage', 'ffprobeBundledInPackage', 'ffmpegMatchesSelectedWheel', 'ffprobeMatchesSelectedWheel', 'ffmpegRunsWithoutPath', 'ffprobeRunsWithoutPath')
    'collection' = @('sessionIdPresent', 'negativeFixtureRejected', 'liveTitlePresent', 'sessionFolderMatchesId', 'reportSessionIdMatches', 'reportTitleMatches', 'reportDateMatches', 'reportDeclaresCondensedMedia', 'notesFileMatchesReport', 'cutmapFileMatchesReport', 'hasAtLeastOneMark', 'hasAtLeastOneAnchoredMark', 'manualNotesBelongToSessionMarks', 'markNoteTimingMatches', 'hasCorrespondingMarkNote', 'hasTranscribedCorrespondingMarkNote', 'ffprobeBundledInPackage', 'ffprobeMatchesSelectedWheel', 'sourceMediaAtLeast10Seconds', 'sourceMediaHasStreams', 'reportSourceDurationMatchesMedia', 'condensedMediaNonempty', 'condensedMediaPlayable', 'condensedMediaHasVideo', 'reportCondensedDurationMatchesMedia', 'recordingCopied', 'requiredFilesCopied')
}
$RequiredSessionFiles = @('session.json', 'report\report.html', 'report\report_data.json', 'report\condensed.mp4', 'report\cutmap.json', 'report\notes.json')
$ScreenshotKinds = @('smartscreen-reputation', 'first-run-obs-not-found', 'helper-hid', 'missing-pipeline', 'obs-preflight', 'live-pipeline', 'live-report')

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ZoneId {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $Zone = Get-Content -LiteralPath $Path -Stream Zone.Identifier -Raw -ErrorAction Stop
        if ($Zone -match '(?m)^ZoneId=(\d+)\r?$') { return [int]$Matches[1] }
    } catch { return $null }
    return $null
}

function Get-ZipEntrySha256 {
    param([Parameter(Mandatory = $true)][string]$ZipPath, [Parameter(Mandatory = $true)][string]$EntryName)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $Entry = $Zip.Entries | Where-Object { $_.FullName -eq $EntryName } | Select-Object -First 1
        if (-not $Entry) { throw "Wheel entry is missing: $EntryName" }
        $Stream = $Entry.Open()
        $Sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($Sha.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() } finally { $Sha.Dispose(); $Stream.Dispose() }
    } finally { $Zip.Dispose() }
}

function Get-ArtifactIdentity {
    param([Parameter(Mandatory = $true)]$Manifest)
    return [ordered]@{
        installerSha256 = ([string]$Manifest.installer.sha256).ToLowerInvariant()
        wheelSha256 = ([string]$Manifest.wheel.sha256).ToLowerInvariant()
        captureHelperSha256 = ([string]$Manifest.captureHelper.sha256).ToLowerInvariant()
        sandboxHelperSha256 = ([string]$Manifest.sandboxHelper.sha256).ToLowerInvariant()
        bundledFfmpegSha256 = ([string]$Manifest.wheel.bundledFfmpegSha256).ToLowerInvariant()
        bundledFfprobeSha256 = ([string]$Manifest.wheel.bundledFfprobeSha256).ToLowerInvariant()
    }
}

function Get-TrustedKitContext {
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "Trusted kit manifest is missing: $ManifestPath" }
    $ManifestBytesHash = Get-Sha256 -Path $ManifestPath
    if ($ExpectedManifestSha256 -and $ManifestBytesHash -ne $ExpectedManifestSha256.ToLowerInvariant()) { throw 'The trusted kit manifest hash does not match the host-pinned identity.' }
    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ([string]$Manifest.schema -ne $ManifestSchema) { throw "Unexpected kit manifest schema: $($Manifest.schema)" }
    if (-not [string]$Manifest.runId) { throw 'The kit manifest has no runId.' }
    if ($ExpectedRunId -and [string]$Manifest.runId -ne $ExpectedRunId) { throw 'The kit manifest runId does not match the current host run.' }
    $InstallerPath = Join-Path $KitDirectory ([string]$Manifest.installer.name)
    $WheelPath = Join-Path $KitDirectory ([string]$Manifest.wheel.name)
    $KitHelperPath = Join-Path $KitDirectory ([string]$Manifest.sandboxHelper.name)
    foreach ($Path in @($InstallerPath, $WheelPath, $KitHelperPath)) { if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Trusted kit artifact is missing: $Path" } }
    if ((Get-Sha256 -Path $InstallerPath) -ne ([string]$Manifest.installer.sha256).ToLowerInvariant()) { throw 'Installer bytes do not match the trusted manifest.' }
    if ((Get-Sha256 -Path $WheelPath) -ne ([string]$Manifest.wheel.sha256).ToLowerInvariant()) { throw 'Wheel bytes do not match the trusted manifest.' }
    if ((Get-Sha256 -Path $KitHelperPath) -ne ([string]$Manifest.sandboxHelper.sha256).ToLowerInvariant()) { throw 'Read-only guest helper bytes do not match the trusted manifest.' }
    if ((Get-ZipEntrySha256 -ZipPath $WheelPath -EntryName 'playtest_pipeline/bin/ffmpeg.exe') -ne ([string]$Manifest.wheel.bundledFfmpegSha256).ToLowerInvariant()) { throw 'Bundled ffmpeg.exe does not match the trusted manifest.' }
    if ((Get-ZipEntrySha256 -ZipPath $WheelPath -EntryName 'playtest_pipeline/bin/ffprobe.exe') -ne ([string]$Manifest.wheel.bundledFfprobeSha256).ToLowerInvariant()) { throw 'Bundled ffprobe.exe does not match the trusted manifest.' }
    if ((Get-ZoneId -Path $InstallerPath) -ne 3) { throw 'The staged installer does not carry Zone.Identifier ZoneId=3.' }
    return [pscustomobject]@{ Manifest = $Manifest; ManifestSha256 = $ManifestBytesHash; InstallerPath = $InstallerPath; WheelPath = $WheelPath; KitHelperPath = $KitHelperPath; Artifacts = Get-ArtifactIdentity -Manifest $Manifest }
}

function Assert-HostTrustBoundary {
    if ($HostActions -notcontains $Action) { return }
    if (-not $ExpectedHostHelperSha256) { throw 'Host validation requires the pinned tracked-helper SHA-256.' }
    if ((Get-Sha256 -Path $TrustedHelperPath) -ne $ExpectedHostHelperSha256.ToLowerInvariant()) { throw 'The executing host helper is not the tracked helper identity pinned by the wizard.' }
    if (-not $HostEvidenceDirectory) { throw 'Host validation requires a host-only evidence directory.' }
    $OutboxFull = [IO.Path]::GetFullPath($OutboxDirectory).TrimEnd('\') + '\'
    $HostFull = [IO.Path]::GetFullPath($HostEvidenceDirectory).TrimEnd('\') + '\'
    if ($HostFull.StartsWith($OutboxFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'Host evidence must stay outside the guest-writable outbox.' }
    if ($AttemptMarkerPath) {
        $MarkerFull = [IO.Path]::GetFullPath($AttemptMarkerPath)
        if ($MarkerFull.StartsWith($OutboxFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'Host freshness markers must stay outside the guest-writable outbox.' }
    }
    New-Item -ItemType Directory -Path $HostEvidenceDirectory -Force | Out-Null
}

function New-UniquePath {
    param([Parameter(Mandatory = $true)][string]$Directory, [Parameter(Mandatory = $true)][string]$Name)
    $Path = Join-Path $Directory $Name
    if (-not (Test-Path -LiteralPath $Path)) { return $Path }
    $Base = [IO.Path]::GetFileNameWithoutExtension($Name)
    $Extension = [IO.Path]::GetExtension($Name)
    do { $Path = Join-Path $Directory "$Base-retry-$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$([Guid]::NewGuid().ToString('N').Substring(0, 8))$Extension" } while (Test-Path -LiteralPath $Path)
    return $Path
}

function Write-JsonAtomic {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    $Temporary = "$Path.part-$([Guid]::NewGuid().ToString('N'))"
    $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Temporary -Encoding utf8
    Move-Item -LiteralPath $Temporary -Destination $Path -Force
}

function Write-GuestEvidence {
    param([Parameter(Mandatory = $true)][string]$Kind, [Parameter(Mandatory = $true)]$Context, [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Checks, [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Details)
    New-Item -ItemType Directory -Path $OutboxDirectory -Force | Out-Null
    $AttemptId = [Guid]::NewGuid().ToString('D')
    $Result = [ordered]@{
        schema = $EvidenceSchema
        evidenceKind = $Kind
        runId = [string]$Context.Manifest.runId
        attemptId = $AttemptId
        recordedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        manifestSha256 = $Context.ManifestSha256
        artifacts = $Context.Artifacts
        details = $Details
        checks = $Checks
        pass = -not ($Checks.Values -contains $false)
    }
    $Path = New-UniquePath -Directory $OutboxDirectory -Name "$Kind-$($Context.Manifest.runId)-$AttemptId.json"
    Write-JsonAtomic -Path $Path -Value $Result
    Write-Host "Guest evidence written without replacing prior evidence: $Path" -ForegroundColor Green
    $Result | ConvertTo-Json -Depth 20
    if (-not $Result.pass) { throw "$Kind failed one or more required checks. Correct the issue and create a fresh attempt." }
}

function Get-RecorderInstall {
    $Candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($RegistryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (-not (Test-Path $RegistryRoot)) { continue }
        Get-ChildItem $RegistryRoot -ErrorAction SilentlyContinue | ForEach-Object {
            $Item = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($Item.DisplayName -eq 'Playtest Recorder' -and $Item.InstallLocation) { $Candidates.Add([string]$Item.InstallLocation) }
        }
    }
    $Candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Playtest Recorder'))
    $Candidates.Add((Join-Path $env:ProgramFiles 'Playtest Recorder'))
    $ShortcutCandidates = @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Playtest Recorder.lnk'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Playtest Recorder.lnk'))
    $Shell = New-Object -ComObject WScript.Shell
    foreach ($ShortcutPath in $ShortcutCandidates) {
        if (Test-Path -LiteralPath $ShortcutPath) { $TargetPath = $Shell.CreateShortcut($ShortcutPath).TargetPath; if ($TargetPath) { $Candidates.Add((Split-Path -Parent $TargetPath)) } }
    }
    foreach ($Candidate in $Candidates | Select-Object -Unique) { if (Test-Path -LiteralPath (Join-Path $Candidate 'Playtest Recorder.exe')) { return $Candidate } }
    return $null
}

function Get-PythonCommand {
    $Command = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($Command) { return [pscustomobject]@{ Path = $Command.Source; Prefix = @('-3') } }
    $Command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($Command) { return [pscustomobject]@{ Path = $Command.Source; Prefix = @() } }
    throw 'Python 3.11+ was not found. Install it from python.org, open a new PowerShell, and retry.'
}

function Get-BundledToolPath {
    param([Parameter(Mandatory = $true)][ValidateSet('ffmpeg', 'ffprobe')][string]$Name)
    $Python = Get-PythonCommand
    $Code = "from playtest_pipeline import media; print(media.resolve_tool('$Name'))"
    $Output = & $Python.Path @($Python.Prefix + @('-c', $Code)) 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not resolve bundled $Name from playtest_pipeline: $($Output -join [Environment]::NewLine)" }
    return [IO.Path]::GetFullPath([string]($Output | Select-Object -Last 1))
}

function Invoke-MediaProbe {
    param([Parameter(Mandatory = $true)][string]$FfprobePath, [Parameter(Mandatory = $true)][string]$MediaPath)
    if (-not (Test-Path -LiteralPath $MediaPath -PathType Leaf)) { throw "Media file is missing: $MediaPath" }
    $Output = & $FfprobePath -v error -show_streams -show_format -of json -- $MediaPath 2>&1
    $ExitCode = $LASTEXITCODE
    if ($ExitCode -ne 0) { throw "ffprobe rejected media '$MediaPath' with exit code $ExitCode`: $($Output -join [Environment]::NewLine)" }
    $Value = ($Output -join [Environment]::NewLine) | ConvertFrom-Json
    $DurationSeconds = 0.0
    if ($Value.format -and $Value.format.duration) { $DurationSeconds = [double]::Parse([string]$Value.format.duration, [Globalization.CultureInfo]::InvariantCulture) }
    $Streams = @($Value.streams)
    return [pscustomobject]@{ DurationSeconds = $DurationSeconds; StreamCount = $Streams.Count; HasVideo = [bool]($Streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1); Bytes = (Get-Item -LiteralPath $MediaPath).Length }
}

function Test-JsonEquivalent {
    param($Left, $Right)
    return (($Left | ConvertTo-Json -Depth 30 -Compress) -eq ($Right | ConvertTo-Json -Depth 30 -Compress))
}

function Get-SessionContract {
    param([Parameter(Mandatory = $true)][string]$Root, [Parameter(Mandatory = $true)][string]$FfprobePath)
    $SessionPath = Join-Path $Root 'session.json'
    $ReportPath = Join-Path $Root 'report\report_data.json'
    $NotesPath = Join-Path $Root 'report\notes.json'
    $CutmapPath = Join-Path $Root 'report\cutmap.json'
    $CondensedPath = Join-Path $Root 'report\condensed.mp4'
    foreach ($RelativePath in $RequiredSessionFiles) { if (-not (Test-Path -LiteralPath (Join-Path $Root $RelativePath) -PathType Leaf)) { throw "Required live output is missing: $RelativePath" } }
    $Session = Get-Content -LiteralPath $SessionPath -Raw | ConvertFrom-Json
    $Report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
    $Notes = Get-Content -LiteralPath $NotesPath -Raw | ConvertFrom-Json
    $Cutmap = Get-Content -LiteralPath $CutmapPath -Raw | ConvertFrom-Json
    $SessionId = [string]$Session.session.id
    $RecordingSource = [string]$Session.session.recordingFile
    if (-not $RecordingSource -or -not (Test-Path -LiteralPath $RecordingSource -PathType Leaf)) { throw 'session.json does not point to an existing source recording.' }
    $SourceProbe = Invoke-MediaProbe -FfprobePath $FfprobePath -MediaPath $RecordingSource
    $CondensedProbe = Invoke-MediaProbe -FfprobePath $FfprobePath -MediaPath $CondensedPath
    $Marks = @($Session.marks)
    $AnchoredMarks = @($Marks | Where-Object { $null -ne $_.videoMs })
    $ManualNotes = @($Report.notes | Where-Object { $_.kind -eq 'manual' })
    $MarkById = @{}
    foreach ($Mark in $Marks) { if ([string]$Mark.id) { $MarkById[[string]$Mark.id] = $Mark } }
    $Corresponding = @($ManualNotes | Where-Object { $MarkById.ContainsKey([string]$_.id) })
    $AllManualBelong = -not ($ManualNotes | Where-Object { -not $MarkById.ContainsKey([string]$_.id) })
    $TimingMatches = -not ($Corresponding | Where-Object { [int64]$_.videoMs -ne [int64]$MarkById[[string]$_.id].videoMs })
    $TranscribedCorresponding = @($Corresponding | Where-Object { $_.text -and ([string]$_.text).Trim().Length -gt 0 })
    $SourceDurationMs = [math]::Round($SourceProbe.DurationSeconds * 1000)
    $CondensedDurationMs = [math]::Round($CondensedProbe.DurationSeconds * 1000)
    $Checks = [ordered]@{
        sessionIdPresent = [bool]$SessionId
        negativeFixtureRejected = [bool]($SessionId -ne 'm5-missing-pipeline-fixture' -and (Split-Path -Leaf $Root) -ne 'm5-missing-pipeline-fixture')
        liveTitlePresent = [bool](([string]$Session.session.title).StartsWith('M5 Sandbox live', [StringComparison]::OrdinalIgnoreCase))
        sessionFolderMatchesId = [bool]((Split-Path -Leaf $Root) -eq $SessionId)
        reportSessionIdMatches = [bool]([string]$Report.session.id -eq $SessionId)
        reportTitleMatches = [bool]([string]$Report.session.title -eq [string]$Session.session.title)
        reportDateMatches = [bool]([string]$Report.session.date -eq [string]$Session.session.startedAtWall)
        reportDeclaresCondensedMedia = [bool]([string]$Report.video.kind -eq 'condensed' -and [string]$Report.video.file -eq 'condensed.mp4')
        notesFileMatchesReport = [bool](Test-JsonEquivalent -Left @($Notes) -Right @($Report.notes))
        cutmapFileMatchesReport = [bool](Test-JsonEquivalent -Left @($Cutmap) -Right @($Report.cutmap))
        hasAtLeastOneMark = $Marks.Count -ge 1
        hasAtLeastOneAnchoredMark = $AnchoredMarks.Count -ge 1
        manualNotesBelongToSessionMarks = [bool]$AllManualBelong
        markNoteTimingMatches = [bool]$TimingMatches
        hasCorrespondingMarkNote = $Corresponding.Count -ge 1
        hasTranscribedCorrespondingMarkNote = $TranscribedCorresponding.Count -ge 1
        sourceMediaAtLeast10Seconds = $SourceProbe.DurationSeconds -ge 10.0
        sourceMediaHasStreams = $SourceProbe.StreamCount -gt 0
        reportSourceDurationMatchesMedia = [math]::Abs([double]$Report.session.originalDurationMs - $SourceDurationMs) -le 2000
        condensedMediaNonempty = $CondensedProbe.Bytes -gt 0 -and $CondensedProbe.DurationSeconds -gt 0
        condensedMediaPlayable = $CondensedProbe.StreamCount -gt 0
        condensedMediaHasVideo = $CondensedProbe.HasVideo
        reportCondensedDurationMatchesMedia = [math]::Abs([double]$Report.video.durationMs - $CondensedDurationMs) -le 2000
    }
    return [pscustomobject]@{ Session = $Session; Report = $Report; Checks = $Checks; SessionId = $SessionId; RecordingSource = $RecordingSource; SourceProbe = $SourceProbe; CondensedProbe = $CondensedProbe; CorrespondingMarkIds = @($Corresponding | ForEach-Object { [string]$_.id }); TranscribedMarkIds = @($TranscribedCorresponding | ForEach-Object { [string]$_.id }) }
}

function Confirm-MappedRun {
    $Context = Get-TrustedKitContext
    $Checks = [ordered]@{
        runIdentityPresent = [bool][string]$Context.Manifest.runId
        manifestSchemaMatches = [bool]([string]$Context.Manifest.schema -eq $ManifestSchema)
        installerMatchesManifest = $true
        wheelMatchesManifest = $true
        helperMatchesManifest = $true
        bundledFfmpegMatchesManifest = $true
        bundledFfprobeMatchesManifest = $true
        installerMotwZoneId3 = [bool]((Get-ZoneId -Path $Context.InstallerPath) -eq 3)
    }
    $Details = [ordered]@{ machine = 'Windows Sandbox'; installerZoneId = Get-ZoneId -Path $Context.InstallerPath }
    Write-GuestEvidence -Kind 'guest-confirm' -Context $Context -Checks $Checks -Details $Details
}

function Invoke-InstalledCheck {
    $Context = Get-TrustedKitContext
    $InstallDirectory = Get-RecorderInstall
    $RecorderExe = if ($InstallDirectory) { Join-Path $InstallDirectory 'Playtest Recorder.exe' } else { $null }
    $HelperExe = if ($InstallDirectory) { Join-Path $InstallDirectory 'resources\capture-helper.exe' } else { $null }
    $ShortcutCandidates = @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Playtest Recorder.lnk'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Playtest Recorder.lnk'))
    $Shortcut = $ShortcutCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    $HelperHash = if ($HelperExe -and (Test-Path -LiteralPath $HelperExe)) { Get-Sha256 -Path $HelperExe } else { $null }
    $Checks = [ordered]@{
        installDirectoryFound = [bool]$InstallDirectory
        recorderExeExists = [bool]($RecorderExe -and (Test-Path -LiteralPath $RecorderExe))
        captureHelperExists = [bool]($HelperExe -and (Test-Path -LiteralPath $HelperExe))
        captureHelperMatchesKit = [bool]($HelperHash -and $HelperHash -eq ([string]$Context.Manifest.captureHelper.sha256).ToLowerInvariant())
        startMenuShortcutExists = [bool]$Shortcut
    }
    $Details = [ordered]@{ machine = 'Windows Sandbox'; installDirectory = $InstallDirectory; recorderExe = $RecorderExe; captureHelperExe = $HelperExe; captureHelperSha256 = $HelperHash; startMenuShortcut = $Shortcut }
    Write-GuestEvidence -Kind 'installed-check' -Context $Context -Checks $Checks -Details $Details
    if ($InstallDirectory) { Start-Process explorer.exe -ArgumentList $InstallDirectory }
}

function Install-NegativeFixture {
    $Context = Get-TrustedKitContext
    $FixtureId = 'm5-missing-pipeline-fixture'
    $SessionsRoot = Join-Path ([Environment]::GetFolderPath('MyVideos')) 'PlaytestSessions'
    $FixtureDirectory = Join-Path $SessionsRoot $FixtureId
    $FixturePath = Join-Path $FixtureDirectory 'session.json'
    $PlaceholderRecording = Join-Path $FixtureDirectory 'fixture-placeholder.mp4'
    New-Item -ItemType Directory -Path $FixtureDirectory -Force | Out-Null
    if (-not (Test-Path -LiteralPath $PlaceholderRecording)) { [IO.File]::WriteAllBytes($PlaceholderRecording, [byte[]](0)) }
    $Fixture = [ordered]@{
        schemaVersion = 1
        session = [ordered]@{ id = $FixtureId; title = 'M5 expected missing-pipeline check only'; startedAtWall = '2026-01-01T00:00:00.000Z'; endedAtWall = '2026-01-01T00:00:10.000Z'; captureTarget = [ordered]@{ kind = 'other'; name = 'Negative command-resolution fixture' }; recordingFile = $PlaceholderRecording }
        marks = @([ordered]@{ id = 'fixture-mark'; seq = 1; kind = 'manual'; label = 'fixture'; hotkey = 'F8'; monoMs = 5000; videoMs = 5000; gameTimeMs = $null; anchor = [ordered]@{ method = 'direct'; outputDurationMs = 5000; rttMs = 1 } })
        events = @([ordered]@{ type = 'record-started'; monoMs = 0 }, [ordered]@{ type = 'record-stopped'; monoMs = 10000 })
        telemetry = @()
    }
    $Fixture | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $FixturePath -Encoding utf8
    Write-Host "Created/refreshed the negative-check-only fixture for run $($Context.Manifest.runId): $FixtureDirectory" -ForegroundColor Green
    Write-Host 'This fixture is explicitly rejected by collection and can prove only the expected missing-command behavior.' -ForegroundColor Yellow
}

function Invoke-PipelineToolsCheck {
    $Context = Get-TrustedKitContext
    $Python = Get-PythonCommand
    $CliCommand = Get-Command playtest-pipeline.exe -ErrorAction SilentlyContinue
    if (-not $CliCommand) { $CliCommand = Get-Command playtest-pipeline -ErrorAction SilentlyContinue }
    $Probe = @'
import json
import os
import pathlib
import subprocess
import sys
os.environ.pop("PLAYTEST_FFMPEG_DIR", None)
os.environ["PATH"] = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
from playtest_pipeline import media
resolved = {name: str(pathlib.Path(media.resolve_tool(name)).resolve()) for name in ("ffmpeg", "ffprobe")}
versions = {}
for name, path in resolved.items():
    result = subprocess.run([path, "-version"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    versions[name] = {"exitCode": result.returncode, "firstLine": (result.stdout + result.stderr).splitlines()[0] if (result.stdout or result.stderr) else ""}
print(json.dumps({"python": sys.executable, "pythonVersion": sys.version, "python311OrNewer": sys.version_info >= (3, 11), "sanitizedPath": os.environ["PATH"], "resolved": resolved, "versions": versions}))
'@
    $ProbeOutput = & $Python.Path @($Python.Prefix + @('-c', $Probe)) 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Bundled-tool probe failed: $($ProbeOutput -join [Environment]::NewLine)" }
    $ProbeResult = ($ProbeOutput -join [Environment]::NewLine) | ConvertFrom-Json
    $CliExit = $null
    $CliHelp = $null
    if ($CliCommand) { $CliText = & $CliCommand.Source --help 2>&1; $CliExit = $LASTEXITCODE; $CliHelp = ($CliText | Select-Object -First 1) -join '' }
    $FfmpegHash = Get-Sha256 -Path ([string]$ProbeResult.resolved.ffmpeg)
    $FfprobeHash = Get-Sha256 -Path ([string]$ProbeResult.resolved.ffprobe)
    $FfmpegParts = @(([IO.Path]::GetFullPath([string]$ProbeResult.resolved.ffmpeg) -split '[\\/]') | ForEach-Object { $_.ToLowerInvariant() })
    $FfprobeParts = @(([IO.Path]::GetFullPath([string]$ProbeResult.resolved.ffprobe) -split '[\\/]') | ForEach-Object { $_.ToLowerInvariant() })
    $Checks = [ordered]@{
        cliOnPath = [bool]$CliCommand
        cliRuns = [bool]($CliExit -eq 0)
        python311OrNewer = [bool]$ProbeResult.python311OrNewer
        ffmpegBundledInPackage = [bool]($FfmpegParts -contains 'playtest_pipeline' -and $FfmpegParts -contains 'bin')
        ffprobeBundledInPackage = [bool]($FfprobeParts -contains 'playtest_pipeline' -and $FfprobeParts -contains 'bin')
        ffmpegMatchesSelectedWheel = [bool]($FfmpegHash -eq [string]$Context.Artifacts.bundledFfmpegSha256)
        ffprobeMatchesSelectedWheel = [bool]($FfprobeHash -eq [string]$Context.Artifacts.bundledFfprobeSha256)
        ffmpegRunsWithoutPath = [bool]($ProbeResult.versions.ffmpeg.exitCode -eq 0)
        ffprobeRunsWithoutPath = [bool]($ProbeResult.versions.ffprobe.exitCode -eq 0)
    }
    $Details = [ordered]@{ machine = 'Windows Sandbox'; cliPath = if ($CliCommand) { $CliCommand.Source } else { $null }; cliHelpFirstLine = $CliHelp; cliExitCode = $CliExit; python = $ProbeResult.python; pythonVersion = $ProbeResult.pythonVersion; sanitizedPath = $ProbeResult.sanitizedPath; resolved = $ProbeResult.resolved; toolSha256 = [ordered]@{ ffmpeg = $FfmpegHash; ffprobe = $FfprobeHash }; versions = $ProbeResult.versions }
    Write-GuestEvidence -Kind 'pipeline-tools-check' -Context $Context -Checks $Checks -Details $Details
}

function Copy-SessionEvidence {
    $Context = Get-TrustedKitContext
    if (-not $SessionDirectory) { $SessionDirectory = Read-Host 'Paste the completed M5 Sandbox live session folder shown by Playtest Recorder' }
    $SessionDirectory = $SessionDirectory.Trim().Trim('"')
    if (-not (Test-Path -LiteralPath $SessionDirectory -PathType Container)) { throw "Session folder not found: $SessionDirectory" }
    if ((Split-Path -Leaf $SessionDirectory) -eq 'm5-missing-pipeline-fixture') { throw 'The m5-missing-pipeline-fixture is negative-check-only and is explicitly rejected as live collection evidence.' }
    $FfprobePath = Get-BundledToolPath -Name ffprobe
    $FfprobeParts = @(([IO.Path]::GetFullPath($FfprobePath) -split '[\\/]') | ForEach-Object { $_.ToLowerInvariant() })
    $FfprobeHash = Get-Sha256 -Path $FfprobePath
    $Contract = Get-SessionContract -Root $SessionDirectory -FfprobePath $FfprobePath
    $BaseName = Split-Path -Leaf $SessionDirectory
    $DestinationRoot = Join-Path $OutboxDirectory 'sessions'
    New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null
    $Destination = Join-Path $DestinationRoot "$BaseName-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
    Copy-Item -LiteralPath $SessionDirectory -Destination $Destination -Recurse
    $RecordingDirectory = Join-Path $Destination 'recording'
    New-Item -ItemType Directory -Path $RecordingDirectory -Force | Out-Null
    $RecordingCopy = Join-Path $RecordingDirectory (Split-Path -Leaf $Contract.RecordingSource)
    Copy-Item -LiteralPath $Contract.RecordingSource -Destination $RecordingCopy
    $RequiredCopied = -not ($RequiredSessionFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Destination $_) -PathType Leaf) })
    $Hashes = [ordered]@{}
    foreach ($RelativePath in $RequiredSessionFiles) { $Hashes[$RelativePath] = Get-Sha256 -Path (Join-Path $Destination $RelativePath) }
    $RecordingRelativePath = ('sessions/{0}/recording/{1}' -f (Split-Path -Leaf $Destination), (Split-Path -Leaf $RecordingCopy))
    $Hashes['recording'] = Get-Sha256 -Path $RecordingCopy
    $Checks = [ordered]@{}
    foreach ($Name in @('sessionIdPresent', 'negativeFixtureRejected', 'liveTitlePresent', 'sessionFolderMatchesId', 'reportSessionIdMatches', 'reportTitleMatches', 'reportDateMatches', 'reportDeclaresCondensedMedia', 'notesFileMatchesReport', 'cutmapFileMatchesReport', 'hasAtLeastOneMark', 'hasAtLeastOneAnchoredMark', 'manualNotesBelongToSessionMarks', 'markNoteTimingMatches', 'hasCorrespondingMarkNote', 'hasTranscribedCorrespondingMarkNote')) { $Checks[$Name] = [bool]$Contract.Checks[$Name] }
    $Checks['ffprobeBundledInPackage'] = [bool]($FfprobeParts -contains 'playtest_pipeline' -and $FfprobeParts -contains 'bin')
    $Checks['ffprobeMatchesSelectedWheel'] = [bool]($FfprobeHash -eq [string]$Context.Artifacts.bundledFfprobeSha256)
    foreach ($Name in @('sourceMediaAtLeast10Seconds', 'sourceMediaHasStreams', 'reportSourceDurationMatchesMedia', 'condensedMediaNonempty', 'condensedMediaPlayable', 'condensedMediaHasVideo', 'reportCondensedDurationMatchesMedia')) { $Checks[$Name] = [bool]$Contract.Checks[$Name] }
    $Checks['recordingCopied'] = [bool](Test-Path -LiteralPath $RecordingCopy -PathType Leaf)
    $Checks['requiredFilesCopied'] = [bool]$RequiredCopied
    $Details = [ordered]@{
        machine = 'Windows Sandbox'
        sessionId = $Contract.SessionId
        reportSessionId = [string]$Contract.Report.session.id
        sourceSessionDirectory = $SessionDirectory
        sessionRelativePath = ('sessions/{0}' -f (Split-Path -Leaf $Destination))
        recordingRelativePath = $RecordingRelativePath
        sourceMedia = [ordered]@{ durationSeconds = $Contract.SourceProbe.DurationSeconds; streamCount = $Contract.SourceProbe.StreamCount; bytes = $Contract.SourceProbe.Bytes }
        condensedMedia = [ordered]@{ durationSeconds = $Contract.CondensedProbe.DurationSeconds; streamCount = $Contract.CondensedProbe.StreamCount; hasVideo = $Contract.CondensedProbe.HasVideo; bytes = $Contract.CondensedProbe.Bytes }
        correspondingMarkIds = $Contract.CorrespondingMarkIds
        transcribedCorrespondingMarkIds = $Contract.TranscribedMarkIds
        ffprobePath = $FfprobePath
        ffprobeSha256 = $FfprobeHash
        sha256 = $Hashes
    }
    Write-GuestEvidence -Kind 'collection' -Context $Context -Checks $Checks -Details $Details
    Write-Host 'Copy completed. Keep Windows Sandbox open until the trusted host helper validates the mapped outbox.' -ForegroundColor Yellow
    Start-Process explorer.exe -ArgumentList $OutboxDirectory
}

function Assert-ExactPassingChecks {
    param([Parameter(Mandatory = $true)]$Checks, [Parameter(Mandatory = $true)][string[]]$Names)
    if (-not $Checks) { throw 'Evidence has no checks object.' }
    $Actual = @($Checks.PSObject.Properties.Name | Sort-Object)
    $Expected = @($Names | Sort-Object)
    if (($Actual -join "`n") -ne ($Expected -join "`n")) { throw "Evidence check keys are incomplete or unexpected. Expected: $($Expected -join ', '); actual: $($Actual -join ', ')." }
    foreach ($Name in $Names) {
        $Value = $Checks.PSObject.Properties[$Name].Value
        if ($Value -isnot [bool] -or $Value -ne $true) { throw "Required evidence check is not boolean true: $Name" }
    }
}

function Assert-EvidenceDetails {
    param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$Kind, [Parameter(Mandatory = $true)]$Context)
    if (-not $Value.details) { throw 'Guest evidence has no details object.' }
    if ([string]$Value.details.machine -ne 'Windows Sandbox') { throw 'Guest evidence machine identity is missing or unexpected.' }
    switch ($Kind) {
        'guest-confirm' {
            if ([int]$Value.details.installerZoneId -ne 3) { throw 'Guest confirmation details do not prove MOTW ZoneId=3.' }
        }
        'installed-check' {
            foreach ($Name in @('installDirectory', 'recorderExe', 'captureHelperExe', 'startMenuShortcut')) { if (-not [string]$Value.details.PSObject.Properties[$Name].Value) { throw "Installed evidence detail is missing: $Name" } }
            if (([string]$Value.details.captureHelperSha256).ToLowerInvariant() -ne [string]$Context.Artifacts.captureHelperSha256) { throw 'Installed evidence capture-helper detail does not match the manifest identity.' }
            $InstallFull = [IO.Path]::GetFullPath([string]$Value.details.installDirectory).TrimEnd('\') + '\'
            foreach ($Name in @('recorderExe', 'captureHelperExe')) { if (-not [IO.Path]::GetFullPath([string]$Value.details.PSObject.Properties[$Name].Value).StartsWith($InstallFull, [StringComparison]::OrdinalIgnoreCase)) { throw "$Name is not under the reported install directory." } }
            if ([IO.Path]::GetFileName([string]$Value.details.recorderExe) -ne 'Playtest Recorder.exe' -or [IO.Path]::GetFileName([string]$Value.details.captureHelperExe) -ne 'capture-helper.exe' -or [IO.Path]::GetExtension([string]$Value.details.startMenuShortcut) -ne '.lnk') { throw 'Installed evidence paths do not match the recorder contract.' }
        }
        'pipeline-tools-check' {
            if (-not [string]$Value.details.cliPath -or [int]$Value.details.cliExitCode -ne 0 -or -not [string]$Value.details.python -or -not [string]$Value.details.pythonVersion) { throw 'Pipeline evidence lacks successful CLI/Python measurements.' }
            foreach ($Tool in @('ffmpeg', 'ffprobe')) {
                $Resolved = [IO.Path]::GetFullPath([string]$Value.details.resolved.PSObject.Properties[$Tool].Value)
                $Parts = @(($Resolved -split '[\\/]') | ForEach-Object { $_.ToLowerInvariant() })
                if ($Parts -notcontains 'playtest_pipeline' -or $Parts -notcontains 'bin' -or [IO.Path]::GetFileName($Resolved).ToLowerInvariant() -ne "$Tool.exe") { throw "Pipeline evidence does not resolve package-bundled $Tool." }
                $ExpectedName = "bundled$($Tool.Substring(0, 1).ToUpperInvariant())$($Tool.Substring(1))Sha256"
                if (([string]$Value.details.toolSha256.PSObject.Properties[$Tool].Value).ToLowerInvariant() -ne [string]$Context.Artifacts[$ExpectedName]) { throw "Pipeline evidence $Tool detail does not match the selected wheel." }
                if ([int]$Value.details.versions.PSObject.Properties[$Tool].Value.exitCode -ne 0 -or -not [string]$Value.details.versions.PSObject.Properties[$Tool].Value.firstLine) { throw "Pipeline evidence has no successful $Tool version measurement." }
            }
        }
        'collection' {
            if (-not [string]$Value.details.sessionId -or [string]$Value.details.sessionId -eq 'm5-missing-pipeline-fixture' -or [string]$Value.details.reportSessionId -ne [string]$Value.details.sessionId) { throw 'Collection details have an invalid or mismatched session/report identity.' }
            foreach ($Name in @('sessionRelativePath', 'recordingRelativePath')) { $Relative = ([string]$Value.details.PSObject.Properties[$Name].Value).Replace('\', '/'); if (-not $Relative.StartsWith('sessions/') -or $Relative.Contains('../') -or [IO.Path]::IsPathRooted($Relative)) { throw "Collection detail is not a safe outbox-relative path: $Name" } }
            if (([string]$Value.details.ffprobeSha256).ToLowerInvariant() -ne [string]$Context.Artifacts.bundledFfprobeSha256) { throw 'Collection ffprobe detail does not match the selected wheel.' }
            if ([double]$Value.details.sourceMedia.durationSeconds -lt 10 -or [int]$Value.details.sourceMedia.streamCount -lt 1 -or [double]$Value.details.condensedMedia.durationSeconds -le 0 -or [int]$Value.details.condensedMedia.streamCount -lt 1 -or $Value.details.condensedMedia.hasVideo -ne $true) { throw 'Collection media details are incomplete or fail the duration/playability contract.' }
            foreach ($Name in @($RequiredSessionFiles + 'recording')) { $Property = $Value.details.sha256.PSObject.Properties[$Name]; if (-not $Property -or [string]$Property.Value -notmatch '^[0-9a-fA-F]{64}$') { throw "Collection hash detail is missing or invalid: $Name" } }
            if (@($Value.details.correspondingMarkIds).Count -lt 1 -or @($Value.details.transcribedCorrespondingMarkIds).Count -lt 1) { throw 'Collection details do not bind a transcribed report note to a session mark.' }
        }
    }
}

function Assert-GuestEvidenceValue {
    param([Parameter(Mandatory = $true)]$Value, [Parameter(Mandatory = $true)][string]$Kind, [Parameter(Mandatory = $true)]$Context)
    if ([string]$Value.schema -ne $EvidenceSchema) { throw 'Guest evidence schema does not match.' }
    if ([string]$Value.evidenceKind -ne $Kind) { throw 'Guest evidence kind does not match.' }
    if ([string]$Value.runId -ne [string]$Context.Manifest.runId) { throw 'Guest evidence runId does not match the current run.' }
    $ParsedGuid = [Guid]::Empty
    if (-not [Guid]::TryParse([string]$Value.attemptId, [ref]$ParsedGuid) -or $ParsedGuid -eq [Guid]::Empty) { throw 'Guest evidence attemptId is missing or invalid.' }
    if ([string]$Value.manifestSha256 -ne $Context.ManifestSha256) { throw 'Guest evidence manifest identity does not match.' }
    foreach ($Name in $Context.Artifacts.Keys) {
        $Property = $Value.artifacts.PSObject.Properties[$Name]
        if (-not $Property -or ([string]$Property.Value).ToLowerInvariant() -ne [string]$Context.Artifacts[$Name]) { throw "Guest evidence artifact identity does not match: $Name" }
    }
    if (@($Value.artifacts.PSObject.Properties.Name).Count -ne $Context.Artifacts.Count) { throw 'Guest evidence artifact identity set is incomplete or unexpected.' }
    Assert-ExactPassingChecks -Checks $Value.checks -Names $RequiredChecks[$Kind]
    Assert-EvidenceDetails -Value $Value -Kind $Kind -Context $Context
    if ($Value.pass -isnot [bool] -or $Value.pass -ne $true) { throw 'Guest evidence top-level pass is not boolean true.' }
    $Recorded = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$Value.recordedAtUtc, [ref]$Recorded)) { throw 'Guest evidence recordedAtUtc is invalid.' }
}

function Get-AcceptancePath {
    param([Parameter(Mandatory = $true)][string]$Kind)
    return Join-Path $HostEvidenceDirectory "accepted-$Kind.json"
}

function Assert-PathInside {
    param([Parameter(Mandatory = $true)][string]$Child, [Parameter(Mandatory = $true)][string]$Parent)
    $ChildFull = [IO.Path]::GetFullPath($Child)
    $ParentFull = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (-not $ChildFull.StartsWith($ParentFull, [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes its trusted root: $ChildFull" }
    return $ChildFull
}

function Test-AcceptedGuestEvidence {
    param([Parameter(Mandatory = $true)][string]$Kind, [Parameter(Mandatory = $true)]$Context)
    $AcceptancePath = Get-AcceptancePath -Kind $Kind
    if (-not (Test-Path -LiteralPath $AcceptancePath -PathType Leaf)) { throw "No host acceptance exists for $Kind." }
    $Acceptance = Get-Content -LiteralPath $AcceptancePath -Raw | ConvertFrom-Json
    if ([string]$Acceptance.runId -ne [string]$Context.Manifest.runId -or [string]$Acceptance.manifestSha256 -ne $Context.ManifestSha256 -or [string]$Acceptance.hostHelperSha256 -ne $ExpectedHostHelperSha256.ToLowerInvariant()) { throw "Host acceptance identity is stale for $Kind." }
    $GuestPath = Assert-PathInside -Child (Join-Path $OutboxDirectory ([string]$Acceptance.guestFile)) -Parent $OutboxDirectory
    if (-not (Test-Path -LiteralPath $GuestPath -PathType Leaf) -or (Get-Sha256 -Path $GuestPath) -ne [string]$Acceptance.guestSha256) { throw "Accepted guest evidence changed or disappeared: $Kind" }
    $Value = Get-Content -LiteralPath $GuestPath -Raw | ConvertFrom-Json
    Assert-GuestEvidenceValue -Value $Value -Kind $Kind -Context $Context
    return [pscustomobject]@{ Acceptance = $Acceptance; GuestPath = $GuestPath; Value = $Value }
}

function Validate-GuestEvidence {
    if (-not $EvidenceKind) { throw 'ValidateGuestEvidence requires -EvidenceKind.' }
    $Context = Get-TrustedKitContext
    if (-not $AttemptMarkerPath) {
        $Accepted = Test-AcceptedGuestEvidence -Kind $EvidenceKind -Context $Context
        Write-Host "Reusing host-accepted current-run evidence: $($Accepted.GuestPath)" -ForegroundColor Green
        return
    }
    if (-not (Test-Path -LiteralPath $AttemptMarkerPath -PathType Leaf)) { throw 'The host freshness marker is missing.' }
    $MarkerTime = (Get-Item -LiteralPath $AttemptMarkerPath).LastWriteTimeUtc
    $Candidates = @(Get-ChildItem -LiteralPath $OutboxDirectory -Filter "$EvidenceKind-$($Context.Manifest.runId)-*.json" -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -gt $MarkerTime } | Sort-Object LastWriteTimeUtc -Descending)
    $Selected = $null
    $SelectedValue = $null
    $Errors = [System.Collections.Generic.List[string]]::new()
    foreach ($Candidate in $Candidates) {
        try {
            $Value = Get-Content -LiteralPath $Candidate.FullName -Raw | ConvertFrom-Json
            Assert-GuestEvidenceValue -Value $Value -Kind $EvidenceKind -Context $Context
            $Recorded = [DateTimeOffset]::Parse([string]$Value.recordedAtUtc)
            if ($Recorded.UtcDateTime -lt $MarkerTime.AddMinutes(-2) -or $Recorded.UtcDateTime -gt (Get-Date).ToUniversalTime().AddMinutes(5)) { throw 'Evidence timestamp is stale or implausibly in the future.' }
            $Selected = $Candidate
            $SelectedValue = $Value
            break
        } catch { $Errors.Add("$($Candidate.Name): $($_.Exception.Message)") }
    }
    if (-not $Selected) { throw "No fresh, complete, identity-bound $EvidenceKind evidence passed strict validation. $($Errors -join ' | ')" }
    $Acceptance = [ordered]@{
        schema = 'm5-host-acceptance-v2'
        evidenceKind = $EvidenceKind
        runId = [string]$Context.Manifest.runId
        attemptId = [string]$SelectedValue.attemptId
        acceptedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        manifestSha256 = $Context.ManifestSha256
        hostHelperSha256 = $ExpectedHostHelperSha256.ToLowerInvariant()
        guestFile = $Selected.Name
        guestSha256 = Get-Sha256 -Path $Selected.FullName
    }
    Write-JsonAtomic -Path (Get-AcceptancePath -Kind $EvidenceKind) -Value $Acceptance
    Write-Host "Trusted host accepted fresh $EvidenceKind evidence: $($Selected.FullName)" -ForegroundColor Green
}

function Get-ScreenshotAcceptancePath {
    param([Parameter(Mandatory = $true)][string]$Kind)
    return Join-Path $HostEvidenceDirectory "accepted-screenshot-$Kind.json"
}

function Get-ScreenshotVisualPath {
    param([Parameter(Mandatory = $true)][string]$Kind)
    return Join-Path $HostEvidenceDirectory "visual-confirmed-screenshot-$Kind.json"
}

function Get-PngInfo {
    param([Parameter(Mandatory = $true)][string]$Path)
    $Bytes = [IO.File]::ReadAllBytes($Path)
    $Signature = [byte[]](137, 80, 78, 71, 13, 10, 26, 10)
    if ($Bytes.Length -lt 33) { throw 'PNG is too short.' }
    for ($Index = 0; $Index -lt $Signature.Length; $Index += 1) { if ($Bytes[$Index] -ne $Signature[$Index]) { throw 'File does not have a PNG signature.' } }
    Add-Type -AssemblyName System.Drawing
    $Stream = New-Object IO.MemoryStream(, $Bytes)
    try {
        $Image = [Drawing.Image]::FromStream($Stream, $true, $true)
        try {
            if ($Image.RawFormat.Guid -ne [Drawing.Imaging.ImageFormat]::Png.Guid) { throw 'Decoded image format is not PNG.' }
            $Bitmap = New-Object Drawing.Bitmap($Image)
            try { $null = $Bitmap.GetPixel(0, 0); if ($Bitmap.Width -lt 320 -or $Bitmap.Height -lt 180) { throw "PNG dimensions are implausible for legible UI evidence: $($Bitmap.Width)x$($Bitmap.Height); require at least 320x180." }; return [pscustomobject]@{ Width = $Bitmap.Width; Height = $Bitmap.Height; Bytes = $Bytes.Length } } finally { $Bitmap.Dispose() }
        } finally { $Image.Dispose() }
    } finally { $Stream.Dispose() }
}

function Test-AcceptedScreenshot {
    param([Parameter(Mandatory = $true)][string]$Kind, [Parameter(Mandatory = $true)]$Context, [bool]$RequireVisualConfirmation = $true)
    $AcceptancePath = Get-ScreenshotAcceptancePath -Kind $Kind
    if (-not (Test-Path -LiteralPath $AcceptancePath -PathType Leaf)) { throw "No host acceptance exists for screenshot $Kind." }
    $Acceptance = Get-Content -LiteralPath $AcceptancePath -Raw | ConvertFrom-Json
    if ([string]$Acceptance.runId -ne [string]$Context.Manifest.runId -or [string]$Acceptance.manifestSha256 -ne $Context.ManifestSha256 -or [string]$Acceptance.hostHelperSha256 -ne $ExpectedHostHelperSha256.ToLowerInvariant()) { throw "Screenshot acceptance is stale: $Kind" }
    $ExpectedName = "$($Context.Manifest.runId)-$Kind.png"
    if ([string]$Acceptance.file -ne $ExpectedName) { throw "Screenshot name is not bound to the current run: $Kind" }
    $Path = Assert-PathInside -Child (Join-Path $OutboxDirectory $ExpectedName) -Parent $OutboxDirectory
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Sha256 -Path $Path) -ne [string]$Acceptance.sha256) { throw "Accepted screenshot changed or disappeared: $Kind" }
    $Info = Get-PngInfo -Path $Path
    if ($Info.Width -ne [int]$Acceptance.width -or $Info.Height -ne [int]$Acceptance.height) { throw "Accepted screenshot dimensions changed: $Kind" }
    if ($RequireVisualConfirmation) {
        $VisualPath = Get-ScreenshotVisualPath -Kind $Kind
        if (-not (Test-Path -LiteralPath $VisualPath -PathType Leaf)) { throw "Accepted screenshot lacks host-side human visual confirmation: $Kind" }
        $Visual = Get-Content -LiteralPath $VisualPath -Raw | ConvertFrom-Json
        if ([string]$Visual.runId -ne [string]$Context.Manifest.runId -or [string]$Visual.screenshotKind -ne $Kind -or ([string]$Visual.sha256).ToLowerInvariant() -ne ([string]$Acceptance.sha256).ToLowerInvariant() -or [string]$Visual.manifestSha256 -ne $Context.ManifestSha256 -or [string]$Visual.hostHelperSha256 -ne $ExpectedHostHelperSha256.ToLowerInvariant() -or $Visual.visiblyShowsNamedCriterion -ne $true) { throw "Host-side human visual confirmation is stale or unbound: $Kind" }
    }
    return $Acceptance
}

function Validate-Screenshot {
    if (-not $ScreenshotKind) { throw 'ValidateScreenshot requires -ScreenshotKind.' }
    $Context = Get-TrustedKitContext
    if (-not $AttemptMarkerPath) { $null = Test-AcceptedScreenshot -Kind $ScreenshotKind -Context $Context; Write-Host "Reusing host-accepted current-run PNG: $ScreenshotKind" -ForegroundColor Green; return }
    if (-not (Test-Path -LiteralPath $AttemptMarkerPath -PathType Leaf)) { throw 'The host screenshot freshness marker is missing.' }
    $Path = Assert-PathInside -Child (Join-Path $OutboxDirectory "$($Context.Manifest.runId)-$ScreenshotKind.png") -Parent $OutboxDirectory
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Current-run screenshot is missing: $Path" }
    if ((Get-Item -LiteralPath $Path).LastWriteTimeUtc -le (Get-Item -LiteralPath $AttemptMarkerPath).LastWriteTimeUtc) { throw 'Screenshot is not fresh for this current attempt.' }
    $Info = Get-PngInfo -Path $Path
    $CandidateHash = Get-Sha256 -Path $Path
    foreach ($OtherPath in Get-ChildItem -LiteralPath $HostEvidenceDirectory -Filter 'accepted-screenshot-*.json' -File -ErrorAction SilentlyContinue) {
        try {
            $Other = Get-Content -LiteralPath $OtherPath.FullName -Raw | ConvertFrom-Json
            if ([string]$Other.runId -eq [string]$Context.Manifest.runId -and [string]$Other.screenshotKind -ne $ScreenshotKind -and ([string]$Other.sha256).ToLowerInvariant() -eq $CandidateHash) { throw "PNG content duplicates already accepted criterion $($Other.screenshotKind)." }
        } catch { if ($_.Exception.Message -like 'PNG content duplicates*') { throw } }
    }
    $Acceptance = [ordered]@{
        schema = 'm5-host-screenshot-acceptance-v2'
        screenshotKind = $ScreenshotKind
        runId = [string]$Context.Manifest.runId
        acceptedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        manifestSha256 = $Context.ManifestSha256
        hostHelperSha256 = $ExpectedHostHelperSha256.ToLowerInvariant()
        file = Split-Path -Leaf $Path
        sha256 = $CandidateHash
        bytes = $Info.Bytes
        width = $Info.Width
        height = $Info.Height
    }
    Write-JsonAtomic -Path (Get-ScreenshotAcceptancePath -Kind $ScreenshotKind) -Value $Acceptance
    $VisualPath = Get-ScreenshotVisualPath -Kind $ScreenshotKind
    if (Test-Path -LiteralPath $VisualPath) { Remove-Item -LiteralPath $VisualPath -Force }
    Write-Host "Trusted host decoded and accepted current-run PNG: $Path ($($Info.Width)x$($Info.Height)); human visual confirmation is still required." -ForegroundColor Green
}

function Confirm-ScreenshotVisual {
    if (-not $ScreenshotKind) { throw 'ConfirmScreenshotVisual requires -ScreenshotKind.' }
    $Context = Get-TrustedKitContext
    $Acceptance = Test-AcceptedScreenshot -Kind $ScreenshotKind -Context $Context -RequireVisualConfirmation $false
    $Visual = [ordered]@{
        schema = 'm5-host-screenshot-visual-v2'
        screenshotKind = $ScreenshotKind
        runId = [string]$Context.Manifest.runId
        confirmedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        manifestSha256 = $Context.ManifestSha256
        hostHelperSha256 = $ExpectedHostHelperSha256.ToLowerInvariant()
        sha256 = ([string]$Acceptance.sha256).ToLowerInvariant()
        visiblyShowsNamedCriterion = $true
    }
    Write-JsonAtomic -Path (Get-ScreenshotVisualPath -Kind $ScreenshotKind) -Value $Visual
    Write-Host "Host-only human visual confirmation bound to screenshot: $ScreenshotKind" -ForegroundColor Green
}

function Expand-TrustedFfprobe {
    param([Parameter(Mandatory = $true)]$Context)
    $ToolsDirectory = Join-Path $HostEvidenceDirectory '.trusted-tools'
    New-Item -ItemType Directory -Path $ToolsDirectory -Force | Out-Null
    $Path = Join-Path $ToolsDirectory "ffprobe-$($Context.Artifacts.bundledFfprobeSha256).exe"
    if (Test-Path -LiteralPath $Path -PathType Leaf) { if ((Get-Sha256 -Path $Path) -eq [string]$Context.Artifacts.bundledFfprobeSha256) { return $Path }; Remove-Item -LiteralPath $Path -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($Context.WheelPath)
    try {
        $Entry = $Zip.Entries | Where-Object { $_.FullName -eq 'playtest_pipeline/bin/ffprobe.exe' } | Select-Object -First 1
        if (-not $Entry) { throw 'Trusted wheel has no bundled ffprobe.exe.' }
        $Temporary = "$Path.part"
        $Input = $Entry.Open()
        $Output = [IO.File]::Create($Temporary)
        try { $Input.CopyTo($Output) } finally { $Output.Dispose(); $Input.Dispose() }
        Move-Item -LiteralPath $Temporary -Destination $Path -Force
    } finally { $Zip.Dispose() }
    if ((Get-Sha256 -Path $Path) -ne [string]$Context.Artifacts.bundledFfprobeSha256) { throw 'Extracted host ffprobe does not match the selected wheel identity.' }
    return $Path
}

function Validate-CopiedEvidence {
    $Context = Get-TrustedKitContext
    $AcceptedEvidence = [ordered]@{}
    foreach ($Kind in @('installed-check', 'pipeline-tools-check', 'collection')) { $AcceptedEvidence[$Kind] = Test-AcceptedGuestEvidence -Kind $Kind -Context $Context }
    $AcceptedScreenshots = [ordered]@{}
    foreach ($Kind in $ScreenshotKinds) { $AcceptedScreenshots[$Kind] = Test-AcceptedScreenshot -Kind $Kind -Context $Context }
    $SeenScreenshotHashes = @{}
    foreach ($Kind in $ScreenshotKinds) {
        $ScreenshotHash = ([string]$AcceptedScreenshots[$Kind].sha256).ToLowerInvariant()
        if ($SeenScreenshotHashes.ContainsKey($ScreenshotHash)) { throw "Duplicate PNG content cannot satisfy distinct UI criteria: $($SeenScreenshotHashes[$ScreenshotHash]) and $Kind." }
        $SeenScreenshotHashes[$ScreenshotHash] = $Kind
    }
    $Collection = $AcceptedEvidence['collection'].Value
    $SessionRoot = Assert-PathInside -Child (Join-Path $OutboxDirectory ([string]$Collection.details.sessionRelativePath).Replace('/', '\')) -Parent $OutboxDirectory
    $RecordingPath = Assert-PathInside -Child (Join-Path $OutboxDirectory ([string]$Collection.details.recordingRelativePath).Replace('/', '\')) -Parent $OutboxDirectory
    if (-not (Test-Path -LiteralPath $SessionRoot -PathType Container) -or -not (Test-Path -LiteralPath $RecordingPath -PathType Leaf)) { throw 'Accepted collection paths are missing.' }
    foreach ($RelativePath in $RequiredSessionFiles) {
        $Property = $Collection.details.sha256.PSObject.Properties[$RelativePath]
        $Path = Join-Path $SessionRoot $RelativePath
        if (-not $Property -or -not (Test-Path -LiteralPath $Path -PathType Leaf) -or (Get-Sha256 -Path $Path) -ne ([string]$Property.Value).ToLowerInvariant()) { throw "Copied session artifact changed or is unbound: $RelativePath" }
    }
    $RecordingProperty = $Collection.details.sha256.PSObject.Properties['recording']
    if (-not $RecordingProperty -or (Get-Sha256 -Path $RecordingPath) -ne ([string]$RecordingProperty.Value).ToLowerInvariant()) { throw 'Copied source recording changed or is unbound.' }
    $CopiedSession = Get-Content -LiteralPath (Join-Path $SessionRoot 'session.json') -Raw | ConvertFrom-Json
    $CopiedSession.session.recordingFile = $RecordingPath
    $BoundSessionPath = Join-Path $HostEvidenceDirectory 'bound-session-for-validation'
    if (Test-Path -LiteralPath $BoundSessionPath) { Remove-Item -LiteralPath $BoundSessionPath -Recurse -Force }
    Copy-Item -LiteralPath $SessionRoot -Destination $BoundSessionPath -Recurse
    $BoundJsonPath = Join-Path $BoundSessionPath 'session.json'
    $CopiedSession | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $BoundJsonPath -Encoding utf8
    $FfprobePath = Expand-TrustedFfprobe -Context $Context
    try { $Contract = Get-SessionContract -Root $BoundSessionPath -FfprobePath $FfprobePath } finally { if (Test-Path -LiteralPath $BoundSessionPath) { Remove-Item -LiteralPath $BoundSessionPath -Recurse -Force } }
    foreach ($Name in @('sessionIdPresent', 'negativeFixtureRejected', 'liveTitlePresent', 'reportSessionIdMatches', 'reportTitleMatches', 'reportDateMatches', 'reportDeclaresCondensedMedia', 'notesFileMatchesReport', 'cutmapFileMatchesReport', 'hasAtLeastOneMark', 'hasAtLeastOneAnchoredMark', 'manualNotesBelongToSessionMarks', 'markNoteTimingMatches', 'hasCorrespondingMarkNote', 'hasTranscribedCorrespondingMarkNote', 'sourceMediaAtLeast10Seconds', 'sourceMediaHasStreams', 'reportSourceDurationMatchesMedia', 'condensedMediaNonempty', 'condensedMediaPlayable', 'condensedMediaHasVideo', 'reportCondensedDurationMatchesMedia')) { if (-not [bool]$Contract.Checks[$Name]) { throw "Trusted host collection contract failed: $Name" } }
    if ($Contract.SessionId -ne [string]$Collection.details.sessionId -or [string]$Contract.Report.session.id -ne [string]$Collection.details.reportSessionId) { throw 'Collection-declared session/report identity does not match the copied contracts.' }
    $Checks = [ordered]@{
        trackedHostHelperIdentityVerified = $true
        manifestIdentityVerifiedBeforeOutbox = $true
        readOnlyKitArtifactIdentitiesVerified = $true
        installedEvidenceAccepted = $true
        pipelineToolsEvidenceAccepted = $true
        collectionEvidenceAccepted = $true
        allSevenPngScreenshotsDecodedAndHashBound = $true
        collectionFileHashesMatch = $true
        negativeFixtureRejected = $true
        sessionAndReportIdentityBound = $true
        markNoteCorrespondenceBound = $true
        sourceMediaAtLeast10SecondsByBundledFfprobe = $true
        condensedMediaPlayableByBundledFfprobe = $true
    }
    $Result = [ordered]@{
        schema = 'm5-host-validation-v2'
        runId = [string]$Context.Manifest.runId
        validationAttemptId = [Guid]::NewGuid().ToString('D')
        validatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        validatorMachine = $env:COMPUTERNAME
        manifestSha256 = $Context.ManifestSha256
        hostHelperSha256 = $ExpectedHostHelperSha256.ToLowerInvariant()
        acceptedGuestEvidence = [ordered]@{ installed = $AcceptedEvidence['installed-check'].Acceptance.guestSha256; pipelineTools = $AcceptedEvidence['pipeline-tools-check'].Acceptance.guestSha256; collection = $AcceptedEvidence['collection'].Acceptance.guestSha256 }
        screenshotSha256 = [ordered]@{}
        sessionId = $Contract.SessionId
        sourceDurationSeconds = $Contract.SourceProbe.DurationSeconds
        condensedDurationSeconds = $Contract.CondensedProbe.DurationSeconds
        checks = $Checks
        pass = $true
    }
    foreach ($Kind in $ScreenshotKinds) { $Result.screenshotSha256[$Kind] = [string]$AcceptedScreenshots[$Kind].sha256 }
    $Path = New-UniquePath -Directory $HostEvidenceDirectory -Name "host-validation-$($Context.Manifest.runId).json"
    Write-JsonAtomic -Path $Path -Value $Result
    $Result | ConvertTo-Json -Depth 20
    Write-Host "Trusted host validation written outside guest-writable mappings: $Path" -ForegroundColor Green
}

if ($HostActions -contains $Action) { Assert-HostTrustBoundary }

switch ($Action) {
    'ConfirmRun' { Confirm-MappedRun }
    'Installed' { Invoke-InstalledCheck }
    'InstallFixture' { Install-NegativeFixture }
    'PipelineTools' { Invoke-PipelineToolsCheck }
    'Collect' { Copy-SessionEvidence }
    'ValidateGuestEvidence' { Validate-GuestEvidence }
    'ValidateScreenshot' { Validate-Screenshot }
    'ConfirmScreenshotVisual' { Confirm-ScreenshotVisual }
    'ValidateCopied' { Validate-CopiedEvidence }
}
