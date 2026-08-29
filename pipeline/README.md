# playtest-pipeline

Post-session processing for the playtest recorder. Consumes a session
directory written by the recorder app (`session.json` sidecar +
`session.journal.jsonl` crash journal, schema in
`packages/shared/schema/session.schema.json`) plus the OBS Hybrid MP4
recording, and produces the report bundle:

```
<session_dir>/
  session.json                # written by the recorder (source of truth)
  pipeline/
    mic.wav                   # extracted OBS audio track 2 (16 kHz mono)
    vad.json                  # Silero VAD speech segments
    transcript.json           # faster-whisper word-timestamped transcript
    segments.json             # planned + actual (post-keyframe-snap) cut ranges
  report/
    condensed.mp4             # the edited-down video (marked segments only)
    cutmap.json               # condensed_time <-> original_time map (from ffprobe
                              #   of the ACTUAL emitted segments, never requested times)
    notes.json                # marks enriched with transcribed speech
    chapters.vtt              # WebVTT chapters (timeline markers + skip ranges)
    report_data.json          # everything the player page needs
    report.html               # self-contained player page (first-class output)
    youtube/title.txt         # ready-to-paste YouTube title …
    youtube/description.txt   # … and description with note-derived chapters
                              #   (condensed time; 0:00 first, ≥ 10 s each, ≤ 4 800 B)
    youtube/url.txt           # the uploaded video's URL, written by `playtest-youtube upload`
                              #   (playtest-notion publish reads it without --youtube)
```

## Usage

```
playtest-pipeline process <session_dir> [--recording PATH] [--skip-stt] [--skip-vad]
                          [--reencode] [--pre 20 --post 10] [--model small]
playtest-pipeline inspect <session_dir>
playtest-pipeline youtube-kit <session_dir>     # rebuild report/youtube/*.txt only

playtest-youtube upload <report_dir> [--privacy unlisted] [--video PATH] [--title T]
                        [--dry-run] [--force] [--client-json PATH] [--token PATH]
                        [--port 0] [--no-browser]
playtest-youtube auth [--reauth]   # loopback OAuth flow; caches the token
playtest-youtube status            # credential paths, token state, audit status
playtest-youtube logout            # forget the cached token
```

- `--recording` overrides the recording path when the sidecar's
  `session.recordingFile` is missing or the file moved.
- `--skip-stt` / `--skip-vad` skip the optional heavyweight stages (they are
  also skipped automatically, with a warning, when `faster-whisper` /
  `silero-vad` are not installed).
- `--reencode` produces frame-exact cuts (slower); default is stream-copy,
  which snaps to keyframes — the cut map always reflects actual boundaries.

## Uploading to YouTube

`playtest-youtube` is the optional API path to the video carrier; the manual YouTube Studio upload of `youtube/title.txt` + `youtube/description.txt` stays the documented product path until Google's compliance audit passes. It installs with the `youtube` extra (`pip install -e "pipeline[youtube]"`), reads the Desktop-app OAuth client JSON the M2.4 wizard leaves at `%APPDATA%\playtest-recorder\youtube-client.json`, and caches its token beside it as `youtube-token.json`.

```powershell
playtest-youtube status                                  # what is configured, before anything opens
playtest-youtube upload "<session_dir>" --dry-run        # exactly what would be sent; no auth, no network
playtest-youtube upload "<session_dir>"                  # browser consent on first run, then videos.insert
npx playtest-notion publish "<session_dir>\report"       # picks up youtube/url.txt on its own
```

- `upload` takes a report bundle or the session dir that holds it, uploads `report/condensed.mp4` (override with `--video`) with `privacyStatus=unlisted`, `embeddable=true`, `selfDeclaredMadeForKids=false`, in 8 MiB resumable chunks, and writes the resulting `https://youtu.be/<id>` to `report/youtube/url.txt`. A second run on the same bundle refuses unless you pass `--force`.
- Scope is `youtube.upload` only — the tool writes one video and reads nothing back. Revoke access at <https://myaccount.google.com/permissions>; `logout` only deletes the local token.
- **Until the audit passes, YouTube locks every upload from the project to *private*** whatever the request says. `upload` warns when `YOUTUBE_AUDIT_STATUS` (from `.env` or the environment) does not read `passed`, and reports the visibility the API actually returned.
- While the consent screen is in *Testing*, Google expires the refresh token after 7 days: the browser flow reappearing weekly is expected.

## Install

The selected Windows release wheel includes `ffmpeg.exe`, `ffprobe.exe`, and the FFmpeg license notice, so users installing that wheel do not install FFmpeg separately or add it to `PATH`:

```powershell
py -m pip install .\pipeline\dist\playtest_pipeline-0.1.0-py3-none-win_amd64.whl
```

Source and editable installs intentionally do not download FFmpeg. For development, provide FFmpeg through `PLAYTEST_FFMPEG_DIR` or `PATH`:

```powershell
py -m pip install -e pipeline            # core source install; external FFmpeg required
py -m pip install -e "pipeline[all]"     # + faster-whisper STT + Silero VAD + YouTube uploader
py -m pip install -e "pipeline[youtube]" # just the YouTube uploader (google-auth + api client)
```

`silero-vad` pulls in `torchaudio`; the pipeline reads `mic.wav` with the stdlib, so `torchcodec` (torchaudio's I/O backend since 2.9) is not needed.

### FFmpeg release route and resolution

`media.py` resolves each FFmpeg tool in this order and `process` prints the selected origin:

1. `$PLAYTEST_FFMPEG_DIR` — an explicit directory for development, CI, and controlled overrides;
2. `playtest_pipeline/bin/` — the copy included in the selected Windows release wheel;
3. `PATH` — the source/editable-install fallback.

The selected wheel uses the unmodified `ffmpeg.exe`, `ffprobe.exe`, and `LICENSE.txt` from BtbN's `ffmpeg-n8.1-latest-win64-lgpl-8.1.zip`. The release builder verifies the pinned archive, the executables' LGPL runtime notice and BtbN configuration signature, absence of `--enable-gpl`, explicit `--disable-libx264`, and absence of a `libx264` encoder before it builds. FFmpeg remains a separate process; the pipeline does not link libav* or libobs.

Release maintainers build this artifact with `py pipeline/tools/build_release_wheel.py`. The selected archive identity is pinned in `pipeline/ffmpeg-release.json`; downloaded files under `pipeline/.release/`, copied package binaries under `pipeline/playtest_pipeline/bin/`, and wheels under `pipeline/dist/` are ignored release artifacts. If BtbN replaces its mutable `latest` asset, update the pin only as an intentional release change after repeating the executable checks.

This technical packaging verification is not a legal review. Separate release legal review remains pending.

### Model choice

`faster-whisper` uses CUDA when available. Measured on the M1 session
(90 s mic track, 6 dictated notes) on an RTX 2060 6 GB, `transcribe()` only
(model load adds ~1 s for small, ~2.6 s for medium; the first `medium` run
also downloads ~1.5 GB):

| `--model` | device / compute | wall  | realtime factor | VRAM    |
|-----------|------------------|-------|-----------------|---------|
| small     | cuda / float16   | 1.3 s | 0.015x          | ~0.8 GB |
| medium    | cuda / float16   | 2.8 s | 0.031x          | ~2.1 GB |
| small     | cpu / int8       | 6.2 s | 0.068x          | —       |

Both models got every note word-for-word right; medium only differed in
wording ("First note." vs "1. Note.", "pathfinding" vs "path finding"). The
default is therefore `small`: use `--model medium` on a GPU when a transcript
reads badly (~2x slower, fits 6 GB in float16); stay on `small` on CPU. Batch
post-session by design — never during recording (perf report §1).
