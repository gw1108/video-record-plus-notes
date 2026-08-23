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

GPU note: `faster-whisper` uses CUDA when available; on CPU the `small` model
runs about real-time. Batch post-session by design — never during recording
(perf report §1).
