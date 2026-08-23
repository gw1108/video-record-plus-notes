# Playtest Recorder

Take notes while recording **anything** — a game (windowed, exclusive
fullscreen, or borderless), a video, arbitrary software, a webcam, or a
mirrored mobile device. Press a hotkey when something interesting happens and
dictate a note; afterwards the pipeline transcribes your speech, cuts the
recording down to just the marked moments, and produces a report where
reviewers watch only what matters — as a self-hosted page and as a Notion page.

Architecture and every design decision are documented in the two research
reports this repo was built from:

- [Tech stack report](2026-08-22-playtest-session-recorder-tech-stack.md) — market gap, capture architecture, STT, condensed report, licensing (§ references in code comments point here)
- [Performance report](2026-08-22-playtest-recorder-performance-research.md) — the live-session overhead budget and the hot-path rules

## How it works

```
┌────────────── Recording session (Windows) ───────────────┐
│  Electron app (apps/recorder) — UI CLOSED during session │
│   main process + tray only                               │
│   ├─ globalShortcut mark keys (F8/F9)                    │
│   ├─ obs-websocket → OBS: StartRecord / StopRecord /     │
│   │    CreateRecordChapter / GetRecordStatus (anchor)    │
│   ├─ optional game telemetry poll (localhost)            │
│   └─ session.json + journal sidecar (source of truth)    │
│                                                          │
│  OBS Studio (separate install, Hybrid MP4, mic on        │
│   audio track 2, NVENC single-pass CQP)                  │
│                                                          │
│  capture-helper (helper/, Rust): Raw Input hotkey        │
│   fallback (done) · separate webcam track (Phase 2)      │
└──────────────────────────────────────────────────────────┘
                       ▼ stop
┌────────────── Post-session (pipeline/) ──────────────────┐
│  ffmpeg extract mic track → Silero VAD → faster-whisper  │
│  → mark→segment planning → ffmpeg condensed cut          │
│  → cut map (from ACTUAL keyframe-snapped boundaries)     │
│  → report bundle: report.html + notes + chapters.vtt     │
└──────────────────────────────────────────────────────────┘
                       ▼ publish
┌────────────── Deliverables ──────────────────────────────┐
│  report/report.html — self-contained player page:        │
│    condensed video · seek↔notes sync · segment-skip ·    │
│    interactive transcript   (first-class output)         │
│  Notion page (packages/notion-publisher): video upload + │
│    notes as native blocks + transcript + optional        │
│    embedded synced player widget                         │
└──────────────────────────────────────────────────────────┘
```

## Repo layout

| Path | What | Status |
|---|---|---|
| `apps/recorder` | Electron recorder shell (obs-websocket, hotkeys, sidecar, tray) | ✅ working |
| `packages/shared` | Contracts: sidecar schema, anchor math, cut map, report data | ✅ working + tests |
| `pipeline/` | Python post-session pipeline (VAD/STT/condense/report) | ✅ working + tests |
| `packages/player-embed` | Self-contained report page template (segment-skip + note-sync) | ✅ working |
| `packages/notion-publisher` | Notion page publisher CLI (file upload, note blocks) | ⚠️ written, not yet run against the live API |
| `helper/capture-helper` | Rust native helper: Raw Input hotkey fallback | ✅ built; webcam track is a Phase 2 stub |
| `sdk/unity` + `docs/telemetry-protocol.md` | Optional in-game-time telemetry (own games) | ✅ reference impl |
| `hack/` | Unrelated: Claude agent pipeline tooling | — |

Build order follows tech-stack report §7: (1) recorder ✅ → (2) webcam helper
→ (3) STT/VAD ✅ → (4) condensed export + report page + Notion publisher ✅/⚠️
→ (5) Tier-3 embedded widget hosting → (6) telemetry SDK ✅ → (7) hosted shell.

## Prerequisites

- **Windows**, Node 20+, Python 3.11+, **ffmpeg/ffprobe on PATH**
- **OBS Studio 30.2+** (this machine: 32.2.2 ✓) with the WebSocket server
  enabled: OBS → Tools → WebSocket Server Settings → Enable, set a password
- Rust toolchain only if you want the Raw Input fallback helper

## Quickstart

```bash
npm install && npm run build          # all TS workspaces
pip install -e pipeline               # core pipeline (add "[all]" for STT+VAD)
cargo build --release --manifest-path helper/capture-helper/Cargo.toml   # optional

npm run recorder                      # launch the recorder
```

In the recorder window: connect to OBS → **Run preflight** → *Apply
recommended settings* (sets Advanced output, **Hybrid MP4**, audio track 2;
restart OBS after) → route your **mic to track 2 only** in OBS's Advanced
Audio Properties → pick a session title → **Start recording**. The window
closes; F8 marks a moment (F9 = issue), dictating right after the press is
what the pipeline transcribes into the note. Stop from the tray.

Then:

```bash
playtest-pipeline process "<sessions folder>\<session id>"
# → <session>\report\report.html   (open it — done)

# optional Notion page (integration token with access to the parent page):
set NOTION_TOKEN=secret_…
playtest-notion publish "<session>\report" --parent-page <notion-page-id>
```

## OBS settings the preflight can't set for you

From perf report §2.3 — in OBS Settings → Output → Recording:
NVENC (or AMF/QSV), **single pass**, CQP 18–20, **psycho-visual tuning OFF**,
**lookahead OFF**, NV12, canvas = output resolution, preview disabled while
recording, process priority Above Normal.

Rig checklist (perf report §8): Game Bar/DVR off · HAGS off (advisory) ·
High Performance power plan · record to an internal SSD ≠ game drive · cap
the game's FPS at the monitor refresh rate.

## Design invariants (do not break these)

- **The sidecar (`session.json` + journal) is the source of truth for marks.**
  MP4 chapters are a redundant copy, lost if OBS crashes (§3.2).
- **Marks anchor to `GetRecordStatus.outputDuration`**, never wall/monotonic
  time alone (§3.4). Pure math in `packages/shared/src/anchor.ts`.
- **The cut map is built from actual post-keyframe-snap boundaries** (ffprobe
  of emitted segments), never requested times (§5.4).
- **Nothing heavy runs during recording.** STT, VAD, encoding-beyond-OBS,
  and all processing are post-session (perf report §1).
- **Never link libobs; drive OBS over obs-websocket only** — the process boundary is the GPL boundary (§3.2). FFmpeg: LGPL build for anything shipped (§6.2).