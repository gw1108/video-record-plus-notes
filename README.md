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
│   ├─ mark bindings (default F8/F9; any key/mouse/pad)    │
│   ├─ obs-websocket → OBS: StartRecord / StopRecord /     │
│   │    CreateRecordChapter / GetRecordStatus (anchor)    │
│   ├─ optional game telemetry poll (localhost)            │
│   └─ session.json + journal sidecar (source of truth)    │
│                                                          │
│  OBS Studio (separate install, Hybrid MP4, mic on        │
│   audio track 2, NVENC single-pass CQP)                  │
│                                                          │
│  capture-helper (helper/, Rust): Raw Input kbd/mouse +   │
│   XInput/HID pad listener                                │
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
| `apps/recorder` | Electron recorder shell (obs-websocket, hotkeys, sidecar, tray pause/resume, session browser, in-app pipeline run, first-run wizard, rig advisories, NSIS installer) | ✅ working, live-verified |
| `packages/shared` | Contracts: sidecar schema, anchor math, cut map, report data | ✅ working + tests |
| `pipeline/` | Python post-session pipeline (VAD/STT/condense/report) | ✅ working + tests |
| `packages/player-embed` | Self-contained report page template (segment-skip + note-sync + `?t=` deep links) | ✅ working |
| `deploy/` | nginx / Caddy recipe for hosting a report dir (self-host, or framed inside Notion) | ✅ written, not run on a live host |
| `packages/notion-publisher` | Notion page publisher CLI (video block, note blocks, transcript toggle) | ✅ live-verified 2026-08-23 (`hack/out-m2/`): page + notes + batching + Notion file upload (fallback path). **Video carrier is moving to an unlisted YouTube upload with note-derived chapters** — `--youtube <url>` and the pipeline's `youtube/description.txt` kit are PLAN M2 |
| `helper/capture-helper` | Rust native helper: Raw Input hotkey fallback + pad listener | ✅ built, bundled into the installer |
| `sdk/unity` + `docs/telemetry-protocol.md` | Optional in-game-time telemetry (own games) | ✅ reference impl |
| `hack/` | Live-test harnesses (`live-m1.mjs`, `live-m5.mjs`, evidence in `out-m*/`) + unrelated Claude agent pipeline tooling | — |

Build order follows tech-stack report §7: (1) recorder ✅ → (2) Raw Input
helper ✅ (webcam track dropped 2026-08-23) → (3) STT/VAD ✅ → (4) condensed export + report page ✅ + Notion publisher ✅ (live) + YouTube kit/`--youtube` ⚠️ (PLAN M2)
→ (5) optional: API uploader after YouTube's audit, Tier-3 embedded widget (`?t=` deep links + hosting recipe ✅, embed-in-Notion check deferred) → (6) telemetry SDK ✅ → (7) hosted shell.

## Prerequisites

- **Windows**, Node 20+, Python 3.11+, **ffmpeg/ffprobe on PATH** (or
  `PLAYTEST_FFMPEG_DIR` / a bundled copy — see `pipeline/README.md` → FFmpeg;
  any build works locally, shipping requires an LGPL one)
- **OBS Studio 30.2+** (this machine: 32.2.2 ✓) with the WebSocket server
  enabled: OBS → Tools → WebSocket Server Settings → Enable. You do not need to
  copy the port/password by hand — the recorder's **Auto-detect from OBS**
  button reads them straight out of OBS's own plugin config, and turns the
  server on for you when OBS is closed (OBS rewrites that file on exit, so a
  running OBS has to be flipped from the dialog).
- Rust toolchain only if you want the Raw Input fallback helper

## Quickstart

```powershell
npm install
npm run build
pip install -e pipeline               # core pipeline (add "[all]" for STT+VAD; needs torch)
cargo build --release --manifest-path helper/capture-helper/Cargo.toml   # optional

npm run recorder                      # launch the recorder
npm run dist -w playtest-recorder     # optional: NSIS installer → apps/recorder/release/
```

First launch opens a **setup wizard** (detect OBS → enable WebSocket → apply
the recording profile → face-cam note → rig checklist); it can be reopened
any time from the header. The window also lists past sessions with *Open
report* / *Run pipeline* buttons, and settings has a "run pipeline
automatically after stop" toggle plus the segment policy (seconds before/after
a mark, merge gap), STT model and mark labels — all baked into the pipeline
command it prints.

In the recorder window: connect to OBS → **Run preflight** → *Apply
recommended settings* (sets Advanced output, **Hybrid MP4**, audio track 2;
restart OBS after) → route your **mic to track 2 only** in OBS's Advanced
Audio Properties → pick a session title → **Start recording**. The window
closes; F8 marks a moment (F9 = issue), dictating right after the press is
what the pipeline transcribes into the note. Stop (or pause/resume) from the
tray — pause needs a dedicated recording encoder in OBS, otherwise the tray
reports that OBS ignored it. To rebind,
click a key button in Hotkeys & options and press the new input — any
keyboard chord, mouse button, keyboard-emulating foot pedal, or Xbox/HID
controller button (controller and mouse bindings need the built
capture-helper.exe).

Then:

```powershell
playtest-pipeline process "<sessions folder>\<session id>"
# → <session>\report\report.html   (open it — done)
# to share it: serve <session>/report with deploy/nginx.conf or deploy/Caddyfile (see deploy/README.md)

# optional Notion page: copy .env.example to .env and fill in NOTION_TOKEN (integration
# secret) + PARENT_ID (the page the integration is connected to) — or set them as env vars
playtest-notion publish "<session>\report"            # --parent-page <id> / --token override
#   add --embed-url https://<host>/.../report.html for the synced widget + ?t= timestamp links
#   Free-plan workspaces cap uploads at 5 MiB: the page then carries a "video upload failed"
#   line instead of the player — host the bundle (deploy/) and pass --embed-url
```

## OBS settings the preflight can't set for you

From perf report §2.3 — in OBS Settings → Output → Recording:
NVENC (or AMF/QSV), **single pass**, CQP 18–20, **psycho-visual tuning OFF**,
**lookahead OFF**, NV12, canvas = output resolution, preview disabled while
recording, process priority Above Normal.

**Webcam (optional, yours to set up):** the app records whatever OBS records.
Want a face cam in the recording? Add a **Video Capture Device** source to
your OBS scene and position it as picture-in-picture — OBS composites it into
the one recording, the condensed cut and Notion upload include it
automatically, and the app never touches the camera.

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
- **One video file per session — OBS's.** No app-managed webcam or second
  video track; a webcam is a user-added OBS source (tech-stack §3.6, decided
  2026-08-23).
- **Never link libobs; drive OBS over obs-websocket only** — the process boundary is the GPL boundary (§3.2). FFmpeg: LGPL build for anything shipped (§6.2).