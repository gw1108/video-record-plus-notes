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
```

## Usage

```
playtest-pipeline process <session_dir> [--recording PATH] [--skip-stt] [--skip-vad]
                          [--reencode] [--pre 20 --post 10] [--model small]
playtest-pipeline inspect <session_dir>
```

- `--recording` overrides the recording path when the sidecar's
  `session.recordingFile` is missing or the file moved.
- `--skip-stt` / `--skip-vad` skip the optional heavyweight stages (they are
  also skipped automatically, with a warning, when `faster-whisper` /
  `silero-vad` are not installed).
- `--reencode` produces frame-exact cuts (slower); default is stream-copy,
  which snaps to keyframes — the cut map always reflects actual boundaries.

## Install

```
pip install -e pipeline            # core (ffmpeg/ffprobe must be on PATH)
pip install -e "pipeline[all]"     # + faster-whisper STT + Silero VAD
```

`silero-vad` pulls in `torchaudio`; the pipeline reads `mic.wav` with the
stdlib, so `torchcodec` (torchaudio's I/O backend since 2.9) is not needed.

### FFmpeg (which binary, and the LGPL rule)

`media.py` looks for `ffmpeg`/`ffprobe` in this order and `process` prints
which one it took (`ffmpeg: PATH (…)`):

1. `$PLAYTEST_FFMPEG_DIR` — an explicit directory (installer, CI, tests);
2. `playtest_pipeline/bin/` — a bundled build (gitignored; when present,
   `python -m build pipeline` ships it in the wheel as package data);
3. `PATH`.

Anything **shipped** must use an **LGPL** build (tech-stack §6.2): the
dev-machine gyan.dev build is `--enable-gpl` and fine locally, but not
redistributable with this product. The pipeline only needs LGPL features —
demux, stream copy, PCM, concat; `--reencode` picks the first available of
`h264_nvenc` → `h264_amf` → `h264_qsv` → `libopenh264` → `libx264` (the last
exists only in GPL builds and is never reached on an LGPL one). Verified
2026-08-23 with BtbN's `ffmpeg-n8.1-latest-win64-lgpl-8.1.zip`
(`hack/out-m6/`): `enable-gpl` absent, `--disable-libx264`, full pipeline run
+ `--reencode` + a `libopenh264` encode all pass.

To bundle: unzip an `…-win64-lgpl` build from
<https://github.com/BtbN/FFmpeg-Builds/releases>, copy `bin/ffmpeg.exe`,
`bin/ffprobe.exe` and the zip's `LICENSE.txt` into `playtest_pipeline/bin/`,
then build the wheel. Keep FFmpeg a separate process/binary (never link
libav*) — that keeps the LGPL obligations to "ship the notice + the
unmodified binary", the same boundary the recorder keeps with OBS.

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
