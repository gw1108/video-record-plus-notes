# Giga-Research Report: Runtime Performance of the Playtest Session Recorder

**Date:** 2026-08-22
**Author:** Claude (giga-research / STORM pipeline), for George (georgetw1108@gmail.com)
**Topic:** Performance-first validation of the recorder tech stack from [2026-08-22-playtest-session-recorder-tech-stack.md](2026-08-22-playtest-session-recorder-tech-stack.md). Constraint: while a GPU/CPU-intensive game is running, the screen recorder, keystroke recorder, and mic recorder must impose minimal overhead. STT and all heavy processing are deferred to post-session.

**End-state note:** the product's deliverable is a **Notion page** per session — the edited-down (FFmpeg-condensed) video + the notes + seek↔notes timestamp sync (see the tech-stack report, §5). This is entirely post-session work: it adds a condensation/publish step after recording stops and changes nothing about the live-session performance budget analyzed here.

**Scope note:** the capture target is **not** assumed to be a borderless-windowed internal game. It can be a game in windowed, exclusive-fullscreen, or borderless-fullscreen mode, a video, arbitrary software, a webcam, or a mobile device's screen (mirrored or via capture card) — the product's goal is taking notes while simultaneously recording any of these. This report benchmarks against the GPU/CPU-intensive-game case because it is the *worst case*; every other target (video playback, mobile mirror, ordinary apps) leaves strictly more headroom, so the recommendations below hold everywhere.

Facts below are tagged by confidence: **[Benchmarked]** (independent measurement with disclosed methodology), **[Documented]** (vendor/official docs), **[Anecdotal]** (forum/community reports), **[Derived]** (calculated or inferred — flagged as such).

---

## 1. Executive Summary

**The prior report's architecture survives the performance review — with targeted changes to the hot path.** The dominant cost of recording gameplay is video encoding, and hardware encoders (NVENC/AMF/QSV) reduce that to roughly **2–5% FPS impact** when configured correctly; everything else you need at record time (hotkeys, mic capture, telemetry stamping, disk writes) is measured or derivable at **well under 1% of one CPU core each**. A custom capture pipeline would not beat OBS: OBS's Game Capture already uses a zero-copy shared-texture path that is at or near the theoretical floor, and its WGC-based capture uses the same OS API any custom pipeline would.

> **Design change (2026-08-23): no app-managed webcam track.** A user who wants a
> face cam adds a Video Capture Device source to their own OBS scene; OBS
> composites it into the single recording. The native helper's remaining live
> duty is the Raw Input hotkey fallback. §6.2 keeps the separate-track analysis
> as reference only; §4.3 and §9 are amended in place.

**Key changes and confirmations versus the prior report:**

1. **Keep OBS via obs-websocket** — confirmed as the right call, but the *settings profile matters more than the tool*: NVENC single-pass CQP, psycho-visual tuning **off**, lookahead **off** (both are CUDA-accelerated and compete with the game), canvas = output resolution, preview disabled. §2.
2. **Electron stays, but gets out of the live session.** During recording, the Electron UI should reduce to a main-process-only tray presence (windows closed, not hidden — Electron has documented hidden-window GPU regressions). The live-session hot path (mark hotkey, telemetry stamping, sidecar log) belongs in the main process, with a small **required** native helper owning the Raw Input hotkey fallback (and, before the 2026-08-23 design change, webcam capture) — the pattern Streamlabs Desktop uses in production. §4, §6.2.
3. **Mic audio: simplest performant option is an extra OBS audio track** (zero extra file, zero sync work, negligible cost), extracted post-session with ffmpeg for STT. A WASAPI shared-mode event-driven helper writing WAV/Opus is the fallback if you need the mic file independent of OBS. Live Opus encode is measured at ~0.07–0.7% of one core — effectively free either way. §6.
4. **Hotkeys: RegisterHotKey for the mark keys** (event-driven, zero polling) and **Raw Input with `RIDEV_INPUTSINK` if you add a full keystroke timeline** — Microsoft explicitly recommends Raw Input over low-level hooks, which add system-wide input-latency risk. Never `WH_KEYBOARD_LL` for logging. §5.
5. **Disk is a non-issue on any internal SSD** (~6–13 MB/s average writes vs 500+ MB/s SATA SSD floor), and modern OBS already ships a 256 MB async write buffer that absorbs stalls. Record to a different drive than the game when convenient; avoid external drives. §7.
6. **OS scheduling has real footguns**: Windows 11 demotes backgrounded processes to E-cores on hybrid Intel CPUs; Game DVR/Game Bar should be disabled; HAGS is a known source of encoder latency spikes; OBS should run Above Normal priority. §8.

**Estimated total recording overhead with the recommended profile** (derived, not a single benchmark): ~2–5% FPS from NVENC capture+encode, <1% of one core for everything else combined, ~100–200 MB RAM for the backgrounded Electron shell (renderer-free main process, §4.3), ~130–300 MB VRAM per encode session, 6–13 MB/s disk writes.

---

## 2. Video Capture: OBS + Hardware Encoder Is Near the Floor

### 2.1 Measured overhead — hardware vs software encoding

- **[Benchmarked, Turing-era but rigorous]** Igor'sLAB (former Tom's Hardware DE editor-in-chief, disclosed methodology, VMAF analysis): streaming Assassin's Creed Odyssey 1080p Ultra at 60 FPS output on RTX 2080/i7-5820K, **NVENC produced 0% skipped frames while x264 "faster" skipped 45.6%** of frames — software encoding at 60 FPS was "no longer possible" on that system ([Igor'sLAB](https://www.igorslab.de/en/nvidias-nvenc-vs-cpu-encoding-the-turing-video-encoder-for-twitch-streaming-co-comparison-analysis-with-netflix-vmaf/4/)).
- **[Benchmarked, moderate-credibility source]** tech-insider.org (RTX 4070 / Ryzen 7 7700X, disclosed rig): CS2 1080p — 7.2% CPU overhead with NVENC vs 14.8% with x264; Cyberpunk 2077 1080p Ultra — 142 fps baseline → 139 fps recording with NVENC (~2%) vs 131 fps with x264 (~7.7%); Black Myth: Wukong 4K60 — x264 cost >21 fps, hardware encode cost 7 fps ([tech-insider.org](https://tech-insider.org/obs-vs-shadowplay-vs-xbox-game-bar-2026/)).
- **[Documented]** NVENC is a dedicated ASIC — it "does not run on CUDA cores"; recent GPUs carry two or three NVENC engines the driver load-balances ([Wikipedia: NVENC](https://en.wikipedia.org/wiki/NVENC)).

**Bottom line: with a hardware encoder, expect ~2–5% FPS impact; with x264, 8–20%+ and frame-skipping risk. x264 should not be used while the game runs.**

### 2.2 Where the *remaining* overhead hides — the settings that matter

The encode ASIC is nearly free, but several OBS features silently move work onto CUDA/GPU shaders where they compete with the game:

- **Psycho-visual tuning / adaptive quantization is CUDA-accelerated** — OBS's own KB says to disable it when the GPU also runs a game ([OBS KB: Advanced NVENC Options](https://obsproject.com/kb/advanced-nvenc-options)). **[Anecdotal but corroborated]** A user's 120→70 fps drop at 4K was diagnosed on the OBS forums as Look-Ahead + Psycho-Visual Tuning, not NVENC itself: "If you deactivate these, the bare nvenc encoder is used" ([OBS Forums](https://obsproject.com/forum/threads/specific-situation-separate-encoding-gpu.166862/)).
- **Lookahead is also CUDA-accelerated** — disable ([OBS KB](https://obsproject.com/kb/advanced-nvenc-options)).
- **Multipass ("Max Quality" / Two-Pass Full Resolution)** requires "the most GPU processing power" of the multipass modes — use single-pass for recording alongside a game ([salivity.github.io explainer](https://salivity.github.io/obs-studio/article/obs-nvenc-multipass-mode-explained)).
- **[Anecdotal, GPU-profiler-based]** Color format matters: NV12 capture showed **0% CUDA usage**, 4:2:0 conversion 6–7%, 4:4:4 notably more (GPU power 56 W → 93 W in one 4K 4:4:4 test) ([OBS Forums](https://obsproject.com/forum/threads/specific-situation-separate-encoding-gpu.166862/)). Record NV12.
- **OBS's compositor cost scales with the base canvas, not the output** — set base (canvas) resolution equal to output resolution to minimize the internal framebuffer/compositing load ([OBS Forums](https://obsproject.com/forum/threads/base-canvas-resolution-settings-affect-cpu-usage.100745/)).
- **Disable the preview** while recording — the preview continuously renders and disabling it is "the quickest and most effective way to free up GPU resources"; minimizing OBS or right-click → Performance Mode achieves this. Since your app drives OBS headlessly over obs-websocket, run OBS minimized-to-tray with preview off ([OBS Forums](https://obsproject.com/forum/threads/disable-gpu-while-in-preview-mode.71453/), [OBS KB: Encoding Performance Troubleshooting](https://obsproject.com/kb/encoding-performance-troubleshooting)).
- **VRAM budget**: allocating an NVENC session costs real VRAM even before encoding — ~130 MB baseline for one session at ~2880×1800, ~300 MB for the first GPU-accelerated thread in one real-world report ([NVIDIA Developer Forums](https://forums.developer.nvidia.com/t/reducing-nvenc-memory-usage/165325)).
- **Rate control**: CQP is the community-recommended mode for local recording (quality-targeted, bitrate floats). NVIDIA's own guide: CQ 15 (lower = higher quality), or VBR 40/60 Mbps ([NVIDIA NVENC OBS Guide](https://www.nvidia.com/en-us/geforce/guides/broadcasting-guide/)).
- **Capture method — pick per target, since the target is not assumed borderless-windowed**: Game Capture (hook injection) passes DXGI shared-texture handles zero-copy from the game's `Present` call ([DeepWiki: OBS capture internals](https://deepwiki.com/obsproject/obs-studio/4.2.3-game-capture-and-window-capture)) and is the only reliable path for exclusive-fullscreen games; WGC-based Window/Display Capture handles windowed/borderless games, videos, and any other software; a Video Capture Device source handles webcams, capture cards, and mirrored mobile-device screens. Forum consensus is Game and Window capture perform similarly on modern Windows, with Display Capture likely slowest ([OBS Forums](https://obsproject.com/forum/threads/game-capture-window-capture-or-display-capture-whats-the-actual-difference-in-performance.164599/)). Prefer Game Capture for games where its hook works (it also avoids capturing overlapping windows); fall back to Window/Display Capture for everything else.
- **"Encoding overloaded"** triggers at >0.1% encoder-skipped frames; OBS's official fixes include capping game FPS to refresh rate, running OBS as admin (helps Windows reserve GPU capacity for it), and reducing output res/FPS ([OBS KB: Encoding Performance Troubleshooting](https://obsproject.com/kb/encoding-performance-troubleshooting)). Capping the game's frame rate is the single most effective stabilizer — uncapped games consume 100% GPU and starve OBS's compositor.

### 2.3 Recommended OBS recording profile (performance-first)

| Setting | Value | Why |
|---|---|---|
| Encoder | NVENC (or AMF/QSV) H.264/HEVC | ASIC, ~2–5% FPS cost |
| Rate control | CQP 18–20 (CQ 15 for higher quality) | quality-targeted, no bitrate tuning |
| Preset | P5 (drop toward P3 if overloaded) | P5–P7 near-identical perf, few % quality delta |
| Multipass | Single Pass | two-pass costs GPU |
| Psycho-Visual Tuning / AQ | **Off** | CUDA, competes with game |
| Lookahead | **Off** | CUDA, competes with game |
| Color format | NV12 | 0% CUDA in profiling |
| Base canvas | = Output resolution | compositor scales with canvas |
| Preview | Disabled / OBS minimized | frees GPU |
| Process priority | Above Normal | OBS's own guidance |
| Container | Hybrid MP4 | crash recovery + `CreateRecordChapter` (prior report) |
| Game FPS | Capped at monitor refresh | leaves GPU headroom for capture+encode |

---

## 3. Alternatives Assessed: Nothing Meaningfully Lighter Exists

- **ShadowPlay / NVIDIA App**: NVIDIA's own claim is ~5% typical, 10% worst-case impact ([NVIDIA Support](https://nvidia.custhelp.com/app/answers/detail/a_id/3326/~/whats-the-performance-impact-of-shadowplay)); **[Benchmarked]** GamersNexus measured ~98.2% baseline FPS retained (2014, GTX 780 Ti) ([GamersNexus](https://gamersnexus.net/game-bench/1561-shadowplay-vs-fraps-vs-gvr-recording-benchmark)) and an independent 10-game RTX 3090 4K test found 2.9–9.7% loss, averaging ~5% ([ExtremeBench](https://extremebench.com/screen-capture-with-nvidia-shadowplay-how-much-performance-loss/)). That is *the same ballpark as tuned OBS+NVENC* — ShadowPlay is not a performance escape hatch, and it offers no programmatic chapter API and no cross-vendor support. Its historical NVFBC capture path is officially frozen/deprecated on Windows 10+ ([NVIDIA technical bulletin, PDF](https://developer.download.nvidia.com/designworks/capture-sdk/docs/NVFBC_Win10_Deprecation_Tech_Bulletin.pdf)), and NVFBC licensing bars third-party GeForce use anyway ([NVIDIA Developer Forums](https://forums.developer.nvidia.com/t/commercial-licensing-question-nvfbc-capture-sdk-access-for-geforce-screen-recording-software/373093)) — so there is no proprietary NVIDIA capture advantage left to chase.
- **Xbox Game Bar**: hardware-encoder based but single-foreground-app capture only, no whole-desktop, no separate webcam track ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/3724257/how-to-make-xbox-game-bar-record-the-whole-screen)); background Game DVR keeps the encoder active and allocates VRAM even when idle. Disable it on recording machines — OBS's KB says Game DVR conflicts with NVENC apps ([OBS KB: Windows Gaming Features](https://obsproject.com/kb/windows-gaming-features-troubleshooting)).
- **Custom WGC + Media Foundation pipeline** (scap / windows-capture crates): WGC rides the same DWM/DXGI infrastructure OBS's own WGC capture uses, so a custom pipeline routes through the same OS path — the only savings would come from dropping OBS's UI/scene-graph/audio-mixer overhead, which you can already largely disable (preview off, minimal scene). OBS's Game Capture hook path is *lighter* than WGC (zero-copy from the game's own `Present`). Neither Rust crate publishes benchmarks; both are single-maintainer projects. **[Derived]** Conclusion: a custom pipeline is a large engineering investment for at best marginal gains and the loss of OBS's mature encoder handling, buffering, and chapter support. **No public quantitative WGC-overhead benchmark exists at all** — a genuine data hole, so any "custom is faster" claim would be unverifiable ([OBS Forums: WGC vs DXGI](https://obsproject.com/forum/threads/windows-graphics-capture-vs-dxgi-desktop-duplication.149320/), [scap](https://github.com/CapSoftware/scap), [windows-capture](https://crates.io/crates/windows-capture)).
- Community signal that WGC ≈ vendor-API parity: when NVFBC was deprecated, OBS devs saw "not much point" implementing anything new for it since WGC was already in place ([OBS Forums: obs-nvfbc](https://obsproject.com/forum/threads/obs-nvfbc.105590/)).

**Verdict: the prior report's OBS-via-websocket choice stands. Keep the scap/windows-capture crates as a documented fallback only.**

---

## 4. Desktop Shell: Electron Is Fine — If It Leaves the Session Alone

### 4.1 What Electron actually costs during gameplay

- The expensive thing is **overlays, not background processes**: sources consistently agree Discord's FPS cost comes from its injected in-game overlay (extra D3D rendering layer), while "Discord in a browser tab uses significantly fewer system resources... and does not inject an overlay" ([usekudu.com](https://usekudu.com/guides/gaming/fix-discord-overlay-causing-fps-drops-and-stuttering)). Your recorder needs **no overlay** — marks are audio/hotkey driven.
- **[Anecdotal but important]** Circulating FPS-loss percentages for background Electron apps (e.g. "Discord costs 1.2–2.8%") trace to no primary benchmark and should not be trusted. **No rigorous benchmark of tray-idle Electron's FPS impact on a fullscreen game exists.**
- **RAM**: real-world Electron apps idle from ~150–300 MB (typical) up to 1 GB+ (Discord, feature-heavy) ([Windows Latest](https://www.windowslatest.com/2025/12/07/ram-prices-soar-but-popular-windows-11-apps-are-using-more-ram-due-to-electron-web-components/), [RaftLabs](https://www.raftlabs.com/blog/tauri-vs-electron-pros-cons/)). Note Tauri is not automatically better: with correct USS/PSS accounting, one measurement found Electron 118 MB vs Tauri 125 MB USS ([tauri-apps/tauri#5889](https://github.com/tauri-apps/tauri/issues/5889)), and WebView2 apps like Teams/WhatsApp idle at 300 MB–1 GB ([Windows Latest](https://www.windowslatest.com/2025/12/07/ram-prices-soar-but-popular-windows-11-apps-are-using-more-ram-due-to-electron-web-components/)).

### 4.2 Electron's hidden-window trap

- **[Measured, old/Linux]** A hidden BrowserWindow was observed consuming GPU identically to a visible one (25%) until a show/hide cycle ([electron#5831](https://github.com/electron/electron/issues/5831)).
- `backgroundThrottling` behaves differently on Windows: it does **not** cover fully-hidden windows there ([electron#31016](https://github.com/electron/electron/issues/31016)), and disabling it on long-hidden windows can blank them ([electron#42378](https://github.com/electron/electron/issues/42378)).
- `app.disableHardwareAcceleration()` has repeatedly regressed — on Electron v38+ it "no longer fully disables GPU usage" on Windows, and multiple past versions spawned GPU processes anyway ([electron#51363](https://github.com/electron/electron/issues/51363), [#14273](https://github.com/electron/electron/issues/14273), [#28164](https://github.com/electron/electron/issues/28164)). **Verify per Electron version; don't trust it blindly.**
- Good news: `globalShortcut` is a **main-process** module and the docs state it works without keyboard focus, with no stated requirement for any window to exist ([Electron docs: globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)) — so a windowless, renderer-free Electron process can still register hotkeys.

### 4.3 The production-proven pattern

Streamlabs Desktop (Electron + native OBS core) documents exactly the architecture you want: heavy native work isolated from throwaway UI renderers, with the backend in a process the UI merely talks to ([Streamlabs architecture wiki](https://github.com/streamlabs/desktop/wiki/Application-Architecture)). Independent comparisons put OBS at ~180–300 MB idle vs 650–800 MB for Streamlabs *because* of its always-on Chromium shell ([shattered.io](https://shattered.io/obs-studio-vs-streamlabs/)) — the lesson being: keep the Chromium surface minimal while recording.

**Recommendation:** Electron for setup/review UI. When recording starts: **close (don't hide) all BrowserWindows**, leaving only the main process + tray icon alive — main process registers the mark hotkey, talks to obs-websocket, polls game telemetry (when the target is an instrumented game), and appends the sidecar JSON. (With zero windows the app must handle `window-all-closed` to prevent Electron's default quit; tray-only `globalShortcut` works fine with no windows.) This makes Electron's cost during the session a mostly-idle Node process (~100–200 MB RAM, near-zero CPU/GPU). A tiny native/Rust helper process is **already a required component of the architecture** — it owns the Raw Input mark-hotkey fallback (§5), which Electron does not expose (tech-stack report §3.6). (Until 2026-08-23 it was also slated to own a separate webcam track; that is dropped — see §6.2.) If profiling later shows Chromium misbehaving, the hotkey/telemetry/sidecar block moves into that same helper (Streamlabs/Medal-style) — an incremental refactor, not a rewrite. Skip Electron's `desktopCapturer`/`getUserMedia` for anything session-critical (OBS and the helper own capture).

---

## 5. Keystroke Capture: RegisterHotKey + Raw Input, Never LL Hooks

- **Mark hotkeys → `RegisterHotKey`.** Zero polling: the OS posts `WM_HOTKEY` to your thread only when the combo fires ([Microsoft Learn: RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey)). Caveat: the combo is **swallowed system-wide** — the game will not see it ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/1286619/blocking-windows-hotkeys-in-an-application)) — so pick keys the game doesn't use (F8/F9 à la Medal). Known edge: some exclusive-fullscreen titles fail to coexist with global shortcuts (Dark Souls 2/3 reported failing in both Tauri *and* Electron — [tauri#7318](https://github.com/tauri-apps/tauri/issues/7318)). Since exclusive-fullscreen games are an in-scope capture target (we do not assume borderless-windowed), verify the mark hotkey per title, and fall back to Raw Input (`RIDEV_INPUTSINK`, next bullet) for mark detection where `RegisterHotKey` fails — Raw Input doesn't swallow the key, so pick one the game ignores. Electron exposes no Raw Input API, so this fallback lives in the required native helper (§4.3, tech-stack report §3.6). Non-game targets (videos, desktop apps, mobile-device mirrors) have no such conflict.
- **Full keystroke timeline (if built) → Raw Input with `RIDEV_INPUTSINK`.** Registered with a target window, the app receives `WM_INPUT` even while backgrounded/fullscreen-game-focused ([RAWINPUTDEVICE docs](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice)); it's a parallel delivery channel that does **not** intercept or delay the game's input, supports per-device attribution, and offers buffered reads for high-rate devices ([Raw Input Overview](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-raw-input)). Microsoft's docs explicitly say apps needing low-level monitoring "should monitor raw input instead" of hooks ([LowLevelKeyboardProc docs](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc)).
- **Avoid `WH_KEYBOARD_LL`**: every keystroke in every app routes synchronously through your callback; a busy hook delays *all* system input, and if it exceeds `LowLevelHooksTimeout` (max 1000 ms) Windows **silently removes the hook with no notification** ([LowLevelKeyboardProc docs](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc)). Also increasingly anti-cheat-hostile (EAC titles refusing to launch with AutoHotkey present — [AutoHotkey forums](https://www.autohotkey.com/boards/viewtopic.php?t=38423)) — directly relevant, since third-party games with anti-cheat are an in-scope capture target.
- **Avoid `GetAsyncKeyState` polling**: wastes CPU when idle, documented false negatives, fails across desktop/elevation boundaries ([GetAsyncKeyState docs](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate)).

Cost of the recommended setup: effectively zero — both APIs are event-driven kernel deliveries.

---

## 6. Audio & Webcam: Everything Live Is Sub-1%-of-a-Core

### 6.1 Microphone

- **WASAPI shared mode, event-driven** (`AUDCLNT_STREAMFLAGS_EVENTCALLBACK`). Exclusive mode silences other apps and is explicitly discouraged by Microsoft for anything without hard-realtime needs; `IAudioClient3` shared-mode gets near-exclusive latency anyway ([Microsoft: Exclusive-Mode Streams](https://learn.microsoft.com/en-us/windows/win32/coreaudio/exclusive-mode-streams)). ~10 ms default periods → ~100 wakeups/sec moving ~2 KB each — **[Derived]** well under 1% of a core (no public microbenchmark exists; the arithmetic is trivial).
- **Live Opus encoding is essentially free**: Xiph's official numbers — ~21 MHz of a 2.9 GHz Haswell core for 48 kHz stereo music at complexity 5 (~0.7% of a core), ~2 MHz for wideband mono speech (~0.07%) ([Opus 1.2 release notes](https://jmvalin.ca/opus/opus-1.2/)). Raw WAV is ~5.5 MiB/min mono (~660 MB per 2-hour session) — also trivial. **Choose on robustness, not CPU**: WAV is dumber and more crash-tolerant; Opus saves disk.
- **Simplest recommended path: skip the separate mic recorder entirely — put the mic on OBS audio track 2.** OBS records up to 6 audio tracks in the same container ([MakeUseOf](https://www.makeuseof.com/obs-studio-record-multiple-audio-tracks-to-one-file/)); the mic rides the same clock and container as the video (sync solved by OBS), costs one negligible Opus/AAC audio encode, and post-session you extract the track with ffmpeg for STT. Build the standalone WASAPI helper only if the product needs mic capture independent of OBS.
- **Sync (if you do capture independently)**: use QPC as the single master clock; timestamp buffers at the WASAPI event callback; don't trust device-reported timestamps (the classic OBS drift cause — [OBS Forums](https://obsproject.com/forum/threads/audio-out-of-sync-cant-find-most-common-solution-device-timestamps.87221/)); reconcile periodically with `IAudioClock::GetPosition`'s QPC-correlated position from a housekeeping thread, never the hot path ([IAudioClock::GetPosition docs](https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclock-getposition)).
- **VAD**: Silero self-reports <1 ms per 30 ms chunk on one CPU thread ([silero-vad README](https://github.com/snakers4/silero-vad/blob/master/README.md)) — could run live, but defer it post-session anyway per the design; it buys nothing live.

### 6.2 Webcam

- **Owner: the user's OBS scene (design change 2026-08-23).** A webcam is an optional **Video Capture Device** source the user adds themselves; OBS decodes the camera's MJPEG on the CPU and composites it into the single recording. Cost is a 720p30 MJPEG decode plus one extra compositor layer — sub-1% of a core and well inside the §2 budget, so there is no performance reason to keep it out of OBS. The app does not enumerate, capture, transcode, or display a webcam, and the report page has one video element.
- *Reference only — the separate-track design that was dropped.* The original plan had the native helper record the webcam independently because Electron cannot capture renderer-free and OBS's standard output composites rather than keeping a second video track. The two cheap helper implementations, kept here in case a separate track is ever required:
- Most consumer webcams deliver **MJPEG** over USB (raw formats are USB-bandwidth-capped around 720p30) ([Microsoft: MJPEG At Source Autodecode](https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/mjpeg-at-source-autodecode-for-uvc)). Two cheap options for the helper:
  1. **MJPEG passthrough to disk** — write the camera's native MJPEG stream untouched (zero decode/encode CPU live), transcode post-session. Larger intermediate files; maximum robustness.
  2. **Second NVENC session** — decode MJPEG (small, unbenchmarked-but-qualitatively-cheap CPU cost) and hardware-encode. Session limits are no obstacle: consumer GeForce allows **8 concurrent NVENC sessions** since the January 2024 driver ([VideoCardz](https://videocardz.com/newz/nvdia-geforce-gpus-now-support-up-to-8-concurrent-nvenc-encoding-sessions); verify per-GPU at [NVIDIA's support matrix](https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new)). Note: the OBS KB's "two sessions" claim predates this driver change and is outdated.
- A 720p30 webcam encode is a rounding error next to the 1080p60+ game encode either way. UVC 1.5 H.264 passthrough cameras exist but are rare in consumer hardware — don't design around them.

---

## 7. Disk I/O: A Non-Problem With Two Rules

- **Throughput**: CQP-18 1080p60 recording runs ~20 GB/hour ≈ 5.5 MB/s average ([VdoCipher settings guide](https://www.vdocipher.com/blog/best-obs-recording-settings/)); even 4K60 at 50–100 Mbps is 6–13 MB/s — far below SATA SSD (~500 MB/s) and even 7200 rpm HDD (~100–160 MB/s) sequential floors ([tech-insider SSD/HDD benchmarks](https://tech-insider.org/ssd-vs-hdd-2026/)). The risk is bursts + seek latency, not average rate.
- **OBS already fixed the disk-stall problem**: PR #5717 added an async I/O thread with a circular buffer growing to **256 MB**, batching ~1 MB aligned writes — before it, slow disks surfaced as a misleading "Encoding overloaded!" warning ([obs-studio PR #5717](https://github.com/obsproject/obs-studio/pull/5717)). Modern OBS ships this.
- **Rule 1 — internal SSD, ideally not the game's drive.** Same-drive recording works but shares I/O with game asset streaming ([OBS Forums](https://obsproject.com/forum/threads/best-ssd-hdd-setup-for-obs.117826/)); avoid external drives (write cache often disabled → latency-bound writes, a documented frame-drop cause in the PR discussion) and never NTFS-compressed volumes (confirmed 60→50s fps drop from fragmentation — [OBS Forums](https://obsproject.com/forum/threads/windows-hard-drive-compression-causes-recordings-to-drop-frames.113638/)).
- **Rule 2 — crash-safe container.** Hybrid MP4 (OBS 31+) gives MP4 compatibility with MKV-style recovery ([unifab.ai explainer](https://unifab.ai/resource/mkv-vs-mp4-obs)) and is required for `CreateRecordChapter` anyway (prior report). Sidecar JSON remains the mark source of truth.
- **Separate files vs multi-track**: mic-in-OBS-track adds zero container overhead, and with the webcam composited in OBS (§6.2) the session has exactly one sequential writer. (A separate webcam file would have added one more — trivially within budget; Cap.so ships separate screen+webcam tracks in production ([Cap](https://cap.so/open-source-screen-recorder)) — but that path was dropped 2026-08-23.)

---

## 8. Windows Scheduling: The Footguns List

- **Process priority**: set OBS to **Above Normal** (its own advanced setting; official guidance) — never High/Realtime, which can starve the game ([OBS advanced settings docs](https://jp9000.github.io/OBS/settings/advancedsettings.html)).
- **E-core demotion (Intel 12th-gen+)**: Windows 11 "heavily prioritizes the E-cores for apps that are not being drawn on the screen," and merely minimizing a window can lower a process's QoS onto E-cores — a direct threat to a backgrounded recorder/helper ([ElevenForum discussion](https://www.elevenforum.com/t/forcing-performance-mode-for-background-app-on-intel-p-e-core-cpu.15763/), [Intel hybrid-architecture whitepaper](https://cdrdv2-public.intel.com/685865/211112_Hybrid_WP_2_Developing_v1.2.pdf)). Mitigations: for your own helper, call `SetProcessInformation` with `PROCESS_POWER_THROTTLING_STATE` disabling EcoQoS, and register capture threads with **MMCSS** (`AvSetMmThreadCharacteristics`, "Capture"/"Pro Audio" classes — priorities 16–26) ([Microsoft: MMCSS](https://learn.microsoft.com/en-us/windows/win32/procthread/multimedia-class-scheduler-service), [AvSetMmThreadCharacteristics](https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmthreadcharacteristicsa)). WASAPI auto-registers exclusive-mode threads; shared-mode capture threads should self-register.
- **Game Mode**: safe to leave enabled on Windows 10 1809+/11 (the GPU-starvation behavior was fixed March 2019), but **disable Game Bar and Game DVR** — OBS's KB flags Game DVR conflicts with hardware-encoding apps ([OBS KB: Windows Gaming Features](https://obsproject.com/kb/windows-gaming-features-troubleshooting)).
- **HAGS**: OBS's KB: "HAGS may cause performance issues and failures with OBS and hardware encoders" — recommended off as a troubleshooting step; community reports 100–200 ms encode-latency spikes with it on, though effects are hardware/driver-dependent and some features (DLSS 3 FG) require it ([OBS KB: HAGS](https://obsproject.com/kb/hags), [OBS Forums](https://obsproject.com/forum/threads/enhanced-broadcasting-hags-instability-0-kbps-drops-and-system-freezes.184509/)). Default off on dedicated playtest rigs; test per machine.
- **Core parking / power plan**: Balanced/Power Saver plans park cores aggressively; wakes take 1–15 ms and can eat a frame budget ([cpu-parking-disabler notes](https://github.com/vadyaravadim/cpu-parking-disabler), anecdotal). Use High Performance on playtest rigs. Core-affinity pinning is generally unnecessary (NVENC work isn't on CPU cores) and resets on reboot — skip it unless profiling shows contention.
- Ship these as a **"playtest rig checklist"** in the product (or an automated preflight check in the recorder app): Game Bar/DVR off, HAGS off, High Performance plan, recording drive ≠ game drive, game FPS capped.

---

## 9. Revised Architecture (deltas from prior report **bolded**)

```
┌────────────── Recording session (Windows) ───────────────┐
│  Capture target (any): game in windowed / fullscreen /    │
│  borderless mode · video · any app · webcam ·             │
│  mobile-device screen (mirror or capture card)            │
│                                                           │
│  [optional] Own game ──telemetry SDK──► localhost pipe    │
│                                                           │
│  Electron app — **UI CLOSED during session**:             │
│   main process only + tray icon                           │
│   ├─ RegisterHotKey mark keys (globalShortcut)            │
│   ├─ obs-websocket: StartRecord/CreateRecordChapter       │
│   ├─ telemetry poll + session.json sidecar                │
│   └─ (**move this block into the native helper too if     │
│       Electron profiling disappoints**)                   │
│                                                           │
│  OBS (minimized, preview off, Above Normal priority)      │
│   ├─ Capture source per target (Game / Window / Display   │
│   │   / Device) **+ optional user-added webcam source,    │
│   │   composited by OBS** → NVENC single-pass CQP,        │
│   │   AQ/lookahead OFF, canvas=output, NV12               │
│   ├─ **mic = audio track 2 (same file — sync free)**      │
│   └─ Hybrid MP4 on internal SSD ≠ game drive              │
│                                                           │
│  **Native helper (required): Raw Input hotkey fallback    │
│  only — the separate webcam track was dropped             │
│  2026-08-23; webcam lives in the user's OBS scene**       │
└───────────────────────────────────────────────────────────┘
              ▼ stop
   Post-session: ffmpeg track extract → Silero VAD →
   faster-whisper/WhisperX → ffmpeg condensed cut →
   publish Notion page (edited-down video + notes +
   seek↔notes sync via embedded player)
```

**Estimated session-time budget (derived):** NVENC capture+encode ~2–5% FPS · OBS compositor ≈ small once preview off/canvas matched · hotkeys ≈ 0 · mic track <1% core · telemetry poll ≈ 0 · Electron tray ~100–200 MB RAM, ~0 CPU/GPU · VRAM ~130–300 MB/session · disk 6–13 MB/s.

---

## 10. Risks & Open Items

1. **No public WGC-overhead benchmark exists** — if you ever consider the custom-pipeline route, you must benchmark it yourself; treat any performance claim for scap/windows-capture as unverified.
2. **Electron `disableHardwareAcceleration` regressions** recur across versions ([electron#51363](https://github.com/electron/electron/issues/51363)) — pin the Electron version and verify GPU-process behavior in Task Manager per upgrade; closing windows outright is the more reliable mitigation.
3. **Electron `globalShortcut` → RegisterHotKey internally** — since **verified at Chromium-source level** (`GlobalAcceleratorListenerWin` → Win32 `RegisterHotKey`; works with zero BrowserWindows). Still test against real capture targets early — including at least one exclusive-fullscreen game (cheap prototype: register F8 during a playtest session).
4. **AMD AMF above 1440p30** has anecdotal quality/perf complaints ([OBS Forums](https://obsproject.com/forum/threads/amd-hardware-encoder-s.52305/page-29)) and Intel Arc recording has essentially no public overhead data — validate on non-NVIDIA rigs before promising parity in the sellable product.
5. **HAGS guidance is contradictory** (some systems degrade with it off) — make the preflight check advisory, not forced.
6. The tech-insider.org benchmark numbers (§2.1) come from a moderate-credibility outlet; the directional conclusion (hardware ≫ software encoding) is corroborated by Igor'sLAB and NVIDIA/GamersNexus data, but don't quote its exact percentages in marketing.
7. **Mic-on-OBS-track couples mic capture to OBS's lifecycle** — if OBS crashes you lose video *and* mic (mitigated by Hybrid MP4 recovery). If dictated notes are mission-critical, add standalone WASAPI→WAV capture to the (already required) native helper as a redundant second copy (~0 cost).

---

## 11. Bibliography

1. https://www.igorslab.de/en/nvidias-nvenc-vs-cpu-encoding-the-turing-video-encoder-for-twitch-streaming-co-comparison-analysis-with-netflix-vmaf/4/
2. https://tech-insider.org/obs-vs-shadowplay-vs-xbox-game-bar-2026/
3. https://en.wikipedia.org/wiki/NVENC
4. https://obsproject.com/kb/advanced-nvenc-options
5. https://obsproject.com/forum/threads/specific-situation-separate-encoding-gpu.166862/
6. https://salivity.github.io/obs-studio/article/obs-nvenc-multipass-mode-explained
7. https://obsproject.com/forum/threads/base-canvas-resolution-settings-affect-cpu-usage.100745/
8. https://obsproject.com/forum/threads/disable-gpu-while-in-preview-mode.71453/
9. https://obsproject.com/kb/encoding-performance-troubleshooting
10. https://forums.developer.nvidia.com/t/reducing-nvenc-memory-usage/165325
11. https://www.nvidia.com/en-us/geforce/guides/broadcasting-guide/
12. https://deepwiki.com/obsproject/obs-studio/4.2.3-game-capture-and-window-capture
13. https://obsproject.com/forum/threads/game-capture-window-capture-or-display-capture-whats-the-actual-difference-in-performance.164599/
14. https://nvidia.custhelp.com/app/answers/detail/a_id/3326/~/whats-the-performance-impact-of-shadowplay
15. https://gamersnexus.net/game-bench/1561-shadowplay-vs-fraps-vs-gvr-recording-benchmark
16. https://extremebench.com/screen-capture-with-nvidia-shadowplay-how-much-performance-loss/
17. https://developer.download.nvidia.com/designworks/capture-sdk/docs/NVFBC_Win10_Deprecation_Tech_Bulletin.pdf
18. https://forums.developer.nvidia.com/t/commercial-licensing-question-nvfbc-capture-sdk-access-for-geforce-screen-recording-software/373093
19. https://learn.microsoft.com/en-us/answers/questions/3724257/how-to-make-xbox-game-bar-record-the-whole-screen
20. https://obsproject.com/kb/windows-gaming-features-troubleshooting
21. https://obsproject.com/forum/threads/windows-graphics-capture-vs-dxgi-desktop-duplication.149320/
22. https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture
23. https://github.com/CapSoftware/scap
24. https://crates.io/crates/windows-capture
25. https://obsproject.com/forum/threads/obs-nvfbc.105590/
26. https://usekudu.com/guides/gaming/fix-discord-overlay-causing-fps-drops-and-stuttering
27. https://www.windowslatest.com/2025/12/07/ram-prices-soar-but-popular-windows-11-apps-are-using-more-ram-due-to-electron-web-components/
28. https://www.raftlabs.com/blog/tauri-vs-electron-pros-cons/
29. https://github.com/tauri-apps/tauri/issues/5889
30. https://github.com/electron/electron/issues/5831
31. https://github.com/electron/electron/issues/31016
32. https://github.com/electron/electron/issues/42378
33. https://github.com/electron/electron/issues/51363
34. https://github.com/electron/electron/issues/14273
35. https://github.com/electron/electron/issues/28164
36. https://www.electronjs.org/docs/latest/api/global-shortcut
37. https://github.com/streamlabs/desktop/wiki/Application-Architecture
38. https://shattered.io/obs-studio-vs-streamlabs/
39. https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey
40. https://learn.microsoft.com/en-us/answers/questions/1286619/blocking-windows-hotkeys-in-an-application
41. https://github.com/tauri-apps/tauri/issues/7318
42. https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice
43. https://learn.microsoft.com/en-us/windows/win32/inputdev/about-raw-input
44. https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc
45. https://www.autohotkey.com/boards/viewtopic.php?t=38423
46. https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate
47. https://learn.microsoft.com/en-us/windows/win32/coreaudio/exclusive-mode-streams
48. https://jmvalin.ca/opus/opus-1.2/
49. https://www.makeuseof.com/obs-studio-record-multiple-audio-tracks-to-one-file/
50. https://obsproject.com/forum/threads/audio-out-of-sync-cant-find-most-common-solution-device-timestamps.87221/
51. https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclock-getposition
52. https://github.com/snakers4/silero-vad/blob/master/README.md
53. https://learn.microsoft.com/en-us/windows-hardware/drivers/stream/mjpeg-at-source-autodecode-for-uvc
54. https://videocardz.com/newz/nvdia-geforce-gpus-now-support-up-to-8-concurrent-nvenc-encoding-sessions
55. https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new
56. https://www.vdocipher.com/blog/best-obs-recording-settings/
57. https://tech-insider.org/ssd-vs-hdd-2026/
58. https://github.com/obsproject/obs-studio/pull/5717
59. https://obsproject.com/forum/threads/best-ssd-hdd-setup-for-obs.117826/
60. https://obsproject.com/forum/threads/windows-hard-drive-compression-causes-recordings-to-drop-frames.113638/
61. https://unifab.ai/resource/mkv-vs-mp4-obs
62. https://cap.so/open-source-screen-recorder
63. https://jp9000.github.io/OBS/settings/advancedsettings.html
64. https://www.elevenforum.com/t/forcing-performance-mode-for-background-app-on-intel-p-e-core-cpu.15763/
65. https://cdrdv2-public.intel.com/685865/211112_Hybrid_WP_2_Developing_v1.2.pdf
66. https://learn.microsoft.com/en-us/windows/win32/procthread/multimedia-class-scheduler-service
67. https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmthreadcharacteristicsa
68. https://obsproject.com/kb/hags
69. https://obsproject.com/forum/threads/enhanced-broadcasting-hags-instability-0-kbps-drops-and-system-freezes.184509/
70. https://github.com/vadyaravadim/cpu-parking-disabler
71. https://obsproject.com/forum/threads/amd-hardware-encoder-s.52305/page-29
