# Giga-Research Report: Tech Stack for a Playtest Session Recorder & Condensed-Report Note-Taking App

**Date:** 2026-08-22
**Author:** Claude (giga-research / STORM pipeline), for George (georgetw1108@gmail.com)
**Topic:** Frameworks, libraries, and architecture for a self-hostable, sellable app for taking notes while simultaneously recording your own screen, a webcam, or the screen of another device. **No assumption is made about what is being recorded**: the target may be a game (windowed, exclusive fullscreen, or borderless fullscreen), a video, arbitrary software, or a mobile-device app (mirrored or via capture card). The app supports speech-to-text notes and hotkey "marks" (with video time *and*, when the target is an instrumentable game, in-game time), and generates a condensed report where reviewers auto-play only the marked segments of a long recording.

> **Design change (2026-08-23): the separate webcam track is out of scope.** The
> app records what OBS records. A user who wants a face cam adds a **Video
> Capture Device** source to their own OBS scene (picture-in-picture, composited
> into the single recording) — the app never enumerates, captures, or transcodes
> a webcam and the report has no second video element. Rationale: the separate
> track was the single largest block of native code in the plan (Media Foundation
> reader, MJPEG container writer, sync stamp, transcode step, PiP player) for a
> feature whose only advantages over OBS compositing are clean game footage and a
> toggleable overlay — neither has been asked for by a reviewer. Passages below
> that referred to the webcam track are amended in place; the original analysis
> is kept where it still documents the trade-off.

**Desired end state:** each session's deliverable is a **Notion page** containing (1) the **edited-down video** (the FFmpeg-condensed cut of only the marked/interesting segments), (2) **your notes**, and (3) the ability to **seek through the video and see the notes related to the current timestamp** (and, inversely, click a note to jump the video there). Everything upstream — capture, marks, STT, condensation — feeds this page; the previously "optional" condensed export and the report player are re-scoped accordingly in §5.

---

## 1. Executive Summary

**The product you describe does not exist as an integrated off-the-shelf tool — this is a validated gap.** The market splits into three silos that never overlap: gaming clip tools with hotkey bookmarks but no research/report layer (Medal.tv, ShadowPlay, OBS replay buffer); UX-research SaaS with notes, transcripts, and highlight reels but no live gameplay hotkey-marking or condensed multi-segment playback (Lookback, PlaytestCloud, UserTesting); and open-source screen recorders with post-hoc transcript highlights but no live mark hotkey (Cap, SendRec, Descript, Reduct, tl;dv). Games-user-research practitioners explicitly report hand-rolling custom hotkey-timestamp scripts on top of OBS today because nothing turnkey does this ([Games User Research](https://gamesuserresearch.com/a-simple-set-up-for-recording-mobile-games-playtests/)).

**Recommended stack (all pieces are commercially safe and free to self-host):**

| Layer | Recommendation | License |
|---|---|---|
| Capture engine | OBS Studio driven externally via **obs-websocket** (Hybrid MP4 + `CreateRecordChapter` for marks) | Your app stays unencumbered (IPC boundary) |
| Desktop shell | **Electron** (global hotkeys, mature capture APIs) | MIT |
| Raw Input hotkey fallback | Tiny **native helper** process (`RIDEV_INPUTSINK`) — see §3.6 | Yours |
| Webcam (optional, user-configured) | A **Video Capture Device** source the user adds to their own OBS scene; composited into the recording, no app-side code (design change 2026-08-23) | — |
| In-game time (optional, own-game targets only) | Tiny telemetry SDK inside games you control (localhost HTTP / named pipe) | Yours |
| Speech-to-text | **faster-whisper + WhisperX** (word-level timestamps), batch post-session | MIT / BSD-2 |
| Audio-activity marks | **Silero VAD** | MIT |
| Condensed export (**core** — produces the edited-down video) | FFmpeg (LGPL build) segment cut + concat | LGPL |
| Report destination | **Notion page** created via the Notion API (`@notionhq/client`) — edited-down video + notes + timestamp seek/sync | MIT (SDK) |
| Timestamp-synced player (embedded in the Notion page) | **Vidstack** player + **Hyperaudio Lite** transcript + ~30-line note-sync module, served as a small embeddable page | MIT |
| Product license | **AGPLv3** with sole copyright retained → free self-host + sellable cloud/dual license | — |

---

## 2. Landscape & Gap Analysis (What Exists Today)

### 2.1 Games user research platforms
- **PlaytestCloud** records video/audio/touch and offers AI analysis that "highlights major themes and links right to the clips that matter," plus transcripts — but it is a proprietary managed SaaS with no self-hosting and no evidence of a live hotkey mark ([PlaytestCloud](https://www.playtestcloud.com/resources/recording-technology)).
- **Lookback** captures screen, face, and voice with live note-taking; notes can be converted into "Findings" — 1-minute clips anchored at the note's timestamp — and reviewers can watch just the tagged clips ([Lookback features](https://www.lookback.com/all-lookbacks-features), [Lookback help](http://help.lookback.io/recording-editing-and-sharing-research/common-questions-about-recording-editing-and-sharing-research/how-can-i-create-a-highlight-save-part-of-a-recording)). Cloud SaaS only; not gameplay-capture-native; no confirmed single-keystroke mark hotkey.
- **UserTesting** records screen + voice for usability tasks with no hotkey-marking or highlights-only playback found ([UserTesting FAQ](https://testersupport.usertesting.com/hc/en-us/articles/115003700531-FAQ-UserTesting-Screen-Recorder-)).
- The GUR community confirms the DIY status quo: "Some software allows timestamps to be added automatically, or via a keyboard shortcut, and some teams create custom scripts to make this easier," and notes that video recording, gameplay, and feedback logging live in separate applications that researchers must manually correlate — Microsoft built a custom internal system for this that was never productized ([Games User Research](https://gamesuserresearch.com/a-simple-set-up-for-recording-mobile-games-playtests/), [running a study](https://gamesuserresearch.com/running-a-games-user-research-study/)).

### 2.2 Gaming clip tools — the closest hotkey-mark analog
- **Medal.tv**: continuous replay buffer with a default **F8** hotkey (or voice command "clip that"); "Pressing the clip hotkey will insert a bookmark into your session so you can easily mark points of interest during your gaming sessions" ([Medal](https://medal.tv/learn/instant-replay-pc), [Medal support](https://support.medal.tv/support/solutions/articles/48001157618-how-to-record-and-make-clips)). This is exactly your mark UX — but it produces gamer clips, not a research report, and has no STT, webcam dual-track, or condensed reviewer playback.
- **OBS replay buffer** and **NVIDIA ShadowPlay** offer hotkey-triggered clip saves but no structured mark list, transcript, or report ([OBS forum](https://obsproject.com/forum/resources/how-to-setup-instant-replay-in-obs-studio.613/), [XDA](https://www.xda-developers.com/how-turned-obs-shadowplay-replacement/)).

### 2.3 Screen-recorder / transcript tools
- **Cap** (cap.so): open-source, self-hostable Loom alternative recording screen and webcam as **separate tracks** up to 4K, with link-based playback and timestamp-linked comments — but marks are added by *viewers after the fact*, not by the recorder via hotkey ([Cap](https://cap.so/open-source-screen-recorder)).
- **SendRec**: open-source self-hosted recorder that auto-transcribes with whisper.cpp and supports AI chapters and timestamped viewer comments — same post-hoc limitation ([SendRec](https://sendrec.eu/)).
- **Descript / Reduct / tl;dv** offer transcript-based highlight-reel building ("select transcript text to build insight reels"), but driven by post-hoc editing, not live marks, and none capture gameplay + webcam natively ([Descript](https://www.descript.com/), [Reduct](https://reduct.video/blog/transcription-software-for-video/), [tl;dv](https://tldv.io/video-to-text-transcription/)).

### 2.4 The gap
No tool combines: (1) screen + mic gameplay capture (webcam optional, via the user's OBS scene), (2) a live hotkey mark with an attached spoken note, (3) in-game-time sync, and (4) an auto-generated condensed report that plays only marked segments. Every requested feature exists somewhere in isolation, which also means every piece is buildable with proven tech.

---

## 3. Capture Architecture (Windows Desktop)

### 3.1 The fullscreen problem, and why OBS (not Electron) must own capture
**We do not assume the capture target is borderless-windowed** — it can be a game in windowed, exclusive-fullscreen, or borderless-fullscreen mode, a video, any desktop app, a webcam, or a mobile device's screen. The capture layer must handle all of them. Browser-derived capture APIs (Electron `desktopCapturer`, `getDisplayMedia`) sit on DXGI Desktop Duplication and show a **black screen for true exclusive-fullscreen games** — a longstanding, unresolved Chromium/Windows limitation ([electron/electron#21063](https://github.com/electron/electron/issues/21063)). OBS solves it by injecting a graphics-hook DLL into the game's render pipeline, which is also why it can conflict with anti-cheat ([OBS game capture troubleshooting](https://obsproject.com/kb/game-capture-troubleshooting)). This is a core reason to delegate capture to OBS rather than Electron: OBS covers every target with its existing sources — **Game Capture** for games (the only reliable path for exclusive fullscreen), **Window/Display Capture** (WGC-based) for windowed/borderless games, videos, and any other software, and a **Video Capture Device** source for webcams, HDMI/USB capture cards, and mirrored mobile-device screens (e.g. a scrcpy/QuickTime mirror window or a capture dongle).

### 3.2 Recommended: drive OBS externally via obs-websocket
- obs-websocket provides `StartRecord`, `StopRecord`, and — critically — **`CreateRecordChapter`** (obs-websocket 5.4.0+, bundled with OBS 30.2.0+), which inserts a named chapter marker into the recording file in real time; it requires the **Hybrid MP4/MOV** output format ([protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md), [Hybrid MP4 KB](https://obsproject.com/kb/hybrid-mp4)).
- These chapters are standard MP4 chapter metadata, extractable downstream with `ffprobe -show_chapters` ([OBS forum](https://obsproject.com/forum/threads/obs-chapter-marker-creation-naming-via-websocket.179696/)). Caveat: chapters are written at file finalization, so they're lost if OBS crashes mid-session ([Hybrid MP4 KB](https://obsproject.com/kb/hybrid-mp4)) — keep your own sidecar mark log as the source of truth.
- **Licensing is clean this way.** OBS is GPLv2-or-later ([OBS COPYING](https://github.com/obsproject/obs-studio/blob/master/COPYING)), and embedding/linking libobs would force your whole product to GPL with no commercial alternative ([OBS forum](https://obsproject.com/forum/threads/permission-to-use-the-libobs-or-part-of-it-for-my-own-open-source-project.167514/)). But the FSF's GPL FAQ treats separate-process communication over sockets as "mere aggregation" — "if one of the programs is covered by the GPL, it has no effect on the other program" ([GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html)). Controlling a separately installed OBS over its documented JSON WebSocket API keeps your app license-free of copyleft. (FSF doctrine, not case law — get legal sign-off before shipping commercially.)

### 3.3 Desktop shell: Electron over Tauri
- Electron's `globalShortcut` works without focus and has a better real-world record with fullscreen games; Tauri's global-shortcut plugin has a documented bug failing in some titles (works in Elden Ring/Apex, fails in Dark Souls 2/3) ([Electron docs](https://www.electronjs.org/docs/latest/api/global-shortcut), [tauri#7318](https://github.com/tauri-apps/tauri/issues/7318)).
- **Key-swallow caveat:** `globalShortcut` maps to Win32 `RegisterHotKey` (verified at Chromium-source level), and a registered combo is consumed system-wide — the focused game never sees the key ([electron#11226](https://github.com/electron/electron/issues/11226)). Pick keys the game doesn't use (F8/F9 à la Medal). Where `RegisterHotKey` fails or the key must stay visible to the game, the fallback is Raw Input with `RIDEV_INPUTSINK` — Electron exposes no Raw Input API, so that fallback lives in the native capture helper (§3.6).
- Tauri is lighter (<10MB bundle vs ~100MB+; ~30-40MB idle memory) ([Better Stack comparison](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/)), but the resource savings don't fix the actual bottleneck (capture), which lives in OBS anyway. If you prefer Rust/Tauri, the MIT-licensed **scap** ([GitHub](https://github.com/CapSoftware/scap)) and **windows-capture** ([crates.io](https://crates.io/crates/windows-capture)) crates wrap Windows.Graphics.Capture as a direct-capture fallback.

### 3.4 Sync model
There is exactly **one video file per session** — OBS's recording. (Design change 2026-08-23: the earlier plan recorded a separate webcam track via the native helper, as Cap does ([Cap](https://cap.so/open-source-screen-recorder)); that is dropped. If the user wants a webcam they add it as a Video Capture Device source in their OBS scene and it is composited into the same file, so there is nothing to sync.) Timestamp everything — hotkey marks, STT notes, game telemetry — against a single **monotonic clock offset from a recording-start epoch** (wall clocks jump; monotonic clocks don't), mirroring how OBS chapter timecodes and LiveSplit's timing model work ([LiveSplit docs](https://deepwiki.com/LiveSplit/LiveSplit/1.1-features-and-capabilities)).

**Anchoring marks to recording time.** A monotonic offset alone cannot be mapped to a position in the video file: the `StartRecord` round-trip has latency jitter, OBS begins writing frames at an instant the app never observes, and `PauseRecord` makes wall/monotonic time diverge from output time entirely. The anchor is obs-websocket's `GetRecordStatus`, which returns `outputTimecode`/`outputDuration` — OBS's own notion of the current recording position, immune to start-latency and pause skew. On each mark: (1) stamp the monotonic clock immediately in the hotkey handler; (2) call `GetRecordStatus` and store `outputDuration` alongside the monotonic stamp; (3) call `CreateRecordChapter`. Maintain a single `GetRecordStatus`-vs-monotonic offset calibration (refreshed periodically) so marks stay accurate even when an individual status call is slow; when the file survives, cross-check sidecar marks against the extracted MP4 chapters.

### 3.5 In-game time (optional — only when the target is a game you can instrument)
In-game time is an **optional enrichment, not a core assumption** — it applies only when the capture target is a game whose source you control. In that case, add a **tiny telemetry SDK**: a small library the game links that serves current in-game time (and optional events like pause/level/death) over localhost HTTP or a named pipe. The recorder polls or receives events and stamps each mark with `{video_time, game_time}` — which is exactly what makes the "I pause the game while dictating" case work: video time advances, game time doesn't. For third-party games the alternatives are LiveSplit-style process-memory autosplitters ([LiveSplit.AutoSplitters](https://github.com/LiveSplit/LiveSplit.AutoSplitters)) or OCR — both fragile; treat them as out of scope. For every other target (a video, a mobile app, arbitrary software), marks simply carry `video_time` alone and the pipeline works unchanged.

### 3.6 Native capture helper (small required component)
One need requires a small native (Rust/C++) helper process that no other component in this architecture can cover:

1. **The Raw Input hotkey fallback** — where `RegisterHotKey` fails or would swallow a key the game needs (§3.3), the fallback is Raw Input `RIDEV_INPUTSINK`, which Electron does not expose.

*Removed 2026-08-23 — the separate webcam track.* The original second need was a webcam file recorded independently of OBS: Electron renderer `getUserMedia` is ruled out (the perf review closes all BrowserWindows during recording, and renderer capture is not session-critical-safe), Electron's main process has no media-capture API, and OBS's standard recording output writes one container — a webcam *source* is composited into the game video, not kept as a separate track. That analysis still holds; what changed is the requirement. Compositing in OBS is now the intended path: the user adds a Video Capture Device source to their scene and the app does nothing webcam-specific. The helper's MJPEG-passthrough / second-NVENC design (perf report §6.2) is retained there only as reference should a separate track ever be needed.

Optionally the helper also hosts the redundant standalone WASAPI mic capture (perf report risk 7). This promotes the perf report's "escape hatch" helper to a required — but still tiny — component; if Electron profiling ever disappoints, the hotkey/telemetry/sidecar block moves into the same helper.

---

## 4. Speech-to-Text & Audio Activity Pipeline

### 4.1 Batch post-session, not live
A Whisper-class model competes with the game for CPU/GPU. Batch processing after the session lets you use a bigger, more accurate model with zero frame-time impact: `small` runs ~real-time on a modern CPU; an RTX 3060-class GPU runs `small` at 8-10x and `medium` at 3-4x real-time ([smartscope](https://smartscope.blog/en/generative-ai/foundations/whisper-local-cpu-implementation/), [promptquorum benchmark](https://www.promptquorum.com/power-local-llm/local-whisper-stt-comparison-2026)). A 2-hour session transcribes in minutes. Keep live STT (whisper.cpp `--stream`, ~0.5-2s latency) as an optional stretch feature.

### 4.2 Recommended components
- **faster-whisper** (MIT): CTranslate2 reimplementation, ~4x faster than reference Whisper at same accuracy, half the VRAM ([PyPI](https://pypi.org/project/faster-whisper/)).
- **WhisperX** (BSD-2-Clause): wraps faster-whisper and adds wav2vec2 forced alignment for **true word-level timestamps** (Whisper alone is only segment-accurate) plus optional speaker diarization; up to 70x real-time on large models ([WhisperX guide](https://vexascribe.com/whisperx), [Forasoft](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/whisperx-diarization-word-level-timestamps)). Word-level timing is what lets each transcribed note snap precisely to its mark.
- **Silero VAD** (MIT): neural voice-activity detection — a 30ms chunk processes in <1ms on CPU, significantly more accurate than WebRTC VAD in noisy environments (relevant with game-audio bleed) ([Silero guide](https://onegen.ai/project/enhance-speech-detection-with-silero-vad-a-comprehensive-guide-to-tuning-and-implementation/), [PyPI](https://pypi.org/project/silero-vad)). This powers your "significant audio activity" auto-highlights: any speech burst without an explicit mark becomes a candidate segment.
- **Alternative all-in-one:** **sherpa-onnx** (Apache-2.0) bundles ASR + VAD + diarization via ONNX Runtime with native Windows/CUDA builds and bindings for C++, C#, Go, Python — attractive if you want to ship a desktop app without a Python runtime ([GitHub](https://github.com/k2-fsa/sherpa-onnx)). For an Electron-native path, **transformers.js** runs Whisper in-process via WebGPU/WASM ([overview](https://senoritadeveloper.medium.com/whisper-webgpu-2b1cadfab897)).
- Avoid NVIDIA Parakeet/Canary despite their leaderboard-topping speed (RTFx >2,000): they're CC-BY-4.0, workable commercially but with attribution friction versus MIT/BSD ([stt.ai](https://stt.ai/models/nvidia-parakeet/), [NVIDIA](https://perspectives.nvidia.com/nemotron-speech/task/faq/what-are-the-most-production-ready-open-speech-recognition-models-for-european-l/)). **Moonshine** (MIT, 245M params, matches Whisper large-v3 on English) is the pick if you later want low-footprint live STT ([onresonant](https://www.onresonant.com/resources/local-stt-models-2026)).
- **Optional paid cloud tier** for users without GPUs: AssemblyAI from $0.15/hr, OpenAI Whisper API $0.006/min, Deepgram Nova-3 from $0.46/hr ([futureagi](https://futureagi.com/blog/speech-to-text-apis-in-2026-benchmarks-pricing-developer-s-decision-guide/), [Deepgram](https://deepgram.com/learn/best-speech-to-text-apis-2026)). Verify word-timestamp fields in their JSON before integrating.

---

## 5. The Condensed Report — Desired End State: a Notion Page

### 5.0 What "done" looks like

The finished deliverable for a session is a **Notion page** with three things on it:

1. **The edited-down video** — the FFmpeg-condensed cut (§5.4) containing only the marked segments. This makes the condensed export a **core pipeline step, not an optional extra**: Notion cannot do "play only these ranges of a long file" natively, so the editing-down happens before publish.
2. **Your notes** — the chronological mark list (STT note text, video timestamp, in-game timestamp when available, mark type) as Notion blocks, so they're searchable, commentable, and editable in Notion like any other content.
3. **Seek ↔ notes sync** — scrubbing the video shows the note(s) relevant to the current timestamp, and clicking a note seeks the video to its moment.

**Decision 2026-08-23 — the video carrier is an *unlisted YouTube upload*, not a Notion file upload.** The M2 live test showed that Notion file uploads are the wrong carrier: the workspace is on the Free plan (5 MiB cap — a 6-second clip already fails), a paid plan still stores hundreds of MB per session inside Notion, and a native video block gives no deep links. YouTube gives all of it for free: Notion's `video` block accepts `https://www.youtube.com/watch?v=<id>` as an `external` URL and renders the real YouTube player ([Notion block reference](https://developers.notion.com/reference/block) → *Supported video types*; use the `video` block, **not** `embed` — YouTube is not on the `embed` allow-list), unlisted videos are embeddable and shareable by link but never appear in search/recommendations, `https://youtu.be/<id>?t=<s>` gives Tier-2 note→video deep links, and **chapters come from the description text** — first timestamp `0:00`, at least three timestamps in ascending order, every chapter ≥ 10 s, description ≤ 5 000 *bytes* ([Video chapters](https://support.google.com/youtube/answer/9884579), [videos resource](https://developers.google.com/youtube/v3/docs/videos#snippet.description)). Chapters render on public and unlisted videos (not private). The pipeline therefore emits, next to `condensed.mp4`, a ready-to-paste `youtube/description.txt` whose chapter list is built from the notes in **condensed time** (`originalToCondensedMs` over the cut map), with the STT note text as each chapter's title — "what is talked about, when" — folding any note that lands < 10 s after the previous chapter (or < 10 s before the end) into the previous chapter's title so the list always satisfies YouTube's rules. The Notion publisher takes `--youtube <url>`, places the video block, and turns every note timestamp into a `youtu.be/<id>?t=` link in condensed seconds.

*How the upload itself happens — two modes, and why the manual one comes first.* **(a) Manual (default):** drop `condensed.mp4` on YouTube Studio, pick *Unlisted*, paste `description.txt` — about a minute per session, and the video is unlisted immediately. **(b) API (`videos.insert`, resumable upload, `privacyStatus: unlisted`, `embeddable: true`, `selfDeclaredMadeForKids: false`):** technically simple — OAuth "installed app" client with the loopback redirect and the `youtube.upload` scope; quota is a non-issue since June 2026 (`videos.insert` costs 1 unit against its own 100-calls/day bucket, `videos.update` 50 units of the 10 000/day pool — [quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost)) — **but gated by policy**: every video uploaded through an API project created after 28 July 2020 that has *not* passed YouTube's API compliance audit is **locked to private, with no appeal** ([videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert), [locked as private](https://support.google.com/youtube/answer/7300965)), and developer reports say the lock overrides `unlisted` as well. The audit is free but wants an https website, a privacy-policy URL with a YouTube-data section, the OAuth client details and demo access, and takes weeks ([audit form](https://support.google.com/youtube/contact/yt_api_form)). Two further OAuth frictions: `youtube.upload` is a sensitive scope, so publishing the consent screen to *In production* needs Google verification, and while it stays in *Testing* every refresh token dies after 7 days (weekly re-consent — fine for a solo CLI). So the API uploader is an opt-in, post-audit convenience; the manual mode is the product path and is what the plan verifies first. The Notion file-upload path stays in the publisher only as the fallback for teams that refuse YouTube.

The self-hosted player page (§5.1–§5.2, `deploy/`) remains the **self-host-pure output** and the only route to *bidirectional* seek↔notes sync; the Notion embed of it (former "Tier 3") is now optional polish rather than the end state. The tier discussion that follows is kept for the reasoning; the shipped layering is: YouTube video block + timestamp links (Tier 1 + Tier 2) → notes as native blocks → transcript toggle.

**How to get the seek↔notes sync inside Notion.** Notion's native video block (uploaded file or external URL) exposes no playback API and no timestamp deep-linking, so the bidirectional sync cannot be built from native blocks alone. Three delivery tiers, in increasing fidelity:

- **Tier 1 — native-only page**: upload the condensed video as a Notion video block, notes as plain blocks below it with `[mm:ss]` prefixes. No sync; reviewer scrubs manually. Zero extra infrastructure. **Plan caveat (verified):** Notion's upload limits are **5 MiB per file on free workspaces, 5 GiB on paid**, with multi-part upload required above 20 MiB ([Notion files guide](https://developers.notion.com/guides/data-apis/working-with-files-and-media)). Even a few condensed minutes at CQP-18 1080p60 (~330 MB/min) exceeds the free cap by two orders of magnitude — Tier 1 is effectively **paid-workspace-only** (or the video must be hosted externally + embedded), and the publisher must implement the multi-part upload flow.
- **Tier 2 — timestamp links** *(shipped default, via YouTube — see the 2026-08-23 decision above)*: host the condensed video at a URL that supports time-fragment links (an unlisted YouTube upload with `youtu.be/<id>?t=`, or the self-hosted player page with `?t=`) and make each note's timestamp a clickable link. Note→video works; video→note doesn't — but YouTube chapters built from the notes give the reviewer a note-shaped timeline inside the player, which covers most of what video→note was for.
- **Tier 3 (recommended) — embedded player widget**: publish the Vidstack + Hyperaudio Lite player (below) as a small self-hosted page and place it in the Notion page as an **embed block**. The embed carries the full sync: the note list/transcript inside the iframe highlights and auto-scrolls to the notes at the current playhead, and clicking a note seeks. The same notes are *also* written as native Notion blocks under the embed (Tier 1 content) so the page degrades gracefully and stays Notion-searchable. Requirement: the embed URL must be reachable by whoever opens the page (public or intranet), since Notion renders embeds as plain iframes. **Framing caveat (verified):** embed blocks created via the API skip Notion's iFramely embeddability validation — the API accepts any URL and the block can silently fail to render for viewers (e.g. if the widget host sends `X-Frame-Options` or a CSP `frame-ancestors` that blocks notion.so). The widget page must be served with framing by notion.so explicitly allowed, and rendering verified once manually.

**Self-host-pure fallback (first-class output).** The Notion end state depends on two hosted services — Notion's SaaS plus a viewer-reachable widget URL — which sits in tension with the product's "self-hostable" positioning. The pipeline already emits everything a fully self-hosted report needs: the self-contained player-embed page + `chapters.vtt` + condensed MP4 (§5.2, §7 architecture). That standalone page is therefore a **first-class report output in its own right**, with Notion publishing as the premium/team layer on top. This also derisks Notion API or plan changes.

The page itself is generated by the post-session pipeline through the **Notion API** (official `@notionhq/client` SDK, MIT): create page → `video` block pointing at the unlisted YouTube upload (fallback: Notion file upload, or the self-hosted embed) → append the notes blocks with `youtu.be/<id>?t=` links → transcript toggle. Everything below (§5.1–§5.5) describes the player widget and export machinery that feed this page and the self-hosted report.

### 5.1 Segment playback inside the embedded player: build a ~30-line module
No off-the-shelf library plays "only these ranges of one file." Media Fragments URI (`video.mp4#t=20,45`) handles a single range and is great for share-this-moment deep links, but multi-range chaining is a UA feature that browsers don't reliably implement ([W3C Media Fragments](https://www.w3.org/TR/media-frags/)). The proven pattern (used by ad-tech "snapback" and chapter-skip implementations) is a `timeupdate` listener: keep an array of `{start, end, label}` ranges; when `currentTime` exits a marked range, set `video.currentTime` to the next range's start; handle `seeked` for manual scrubbing ([Google IMA snapback](https://developers.google.com/ad-manager/dynamic-ad-insertion/sdk/html5/snapback), [Adobe chapter-skip](https://experienceleague.adobe.com/en/docs/media-analytics/using/legacy-implementations/track-av-playback/tracking-scenarios/vod-skipped-chapter)). Add a "play everything" toggle so reviewers can expand into unmarked context — a genuine advantage over shipping a pre-cut highlight file.

With the Notion end state, the embedded player should serve the **full recording with this segment-skip module active by default** whenever the full file is hosted — the reviewer gets the edited-down experience *plus* the ability to expand into context — while the Notion-native video block above it holds the physically condensed cut for the no-iframe fallback. If hosting the full recording is undesirable (size, privacy), the embed simply plays the condensed file and the module maps condensed-time back to original timestamps for note lookup.

### 5.2 Player and transcript components
- **Vidstack** (MIT, "free to use without any limits"): the actively developed successor consolidating Plyr and Media Chrome (Video.js v10 is being rebuilt on similar foundations) — native WebVTT chapter rendering inside the time slider and a chapters menu ([merger discussion](https://github.com/vidstack/player/discussions/1747), [Vidstack](https://vidstack.io/)). Point-markers (vs chapter ranges) need a small custom overlay — an open feature request ([vidstack#1660](https://github.com/vidstack/player/issues/1660)).
- **Hyperaudio Lite** (MIT, ~10KB, zero dependencies): click-to-seek interactive transcript with search and shareable timestamped URLs ([GitHub](https://github.com/hyperaudio/hyperaudio-lite)) — pairs directly with WhisperX word timestamps. (Its *editor* sibling is AGPL/commercial-licensed — use only the lite viewer, or license the editor separately ([editor repo](https://github.com/hyperaudio/hyperaudio-lite-editor)).) **Able Player** is the alternative if WCAG accessibility is a requirement ([Able Player](https://ableplayer.github.io/ableplayer/)).
- Encode marks and notes as a **WebVTT `kind="chapters"` track** — cue start/end drive both the timeline markers and the skip ranges; the cue payload carries the note text or a JSON blob `{note, video_time, game_time}` ([Radiant chapters docs](https://www.radiantmediaplayer.com/docs/latest/chapters.html)).

### 5.3 Notion page layout
Each report = one Notion page: the video at top (a `video` block on the unlisted YouTube upload of the condensed cut, whose description carries the note-derived chapters; optional: the embedded synced player above it), below it the chronological mark list as native Notion blocks — for each mark: the note text (from STT), **video timestamp** (a `youtu.be/<id>?t=<condensed s>` seek link), **in-game timestamp**, mark type (manual hotkey vs VAD-detected) — then the full searchable transcript (toggle block, so it collapses). Because notes are real Notion blocks, teammates can comment on, tag, and edit them in place — the report is a living document, not a static export.

### 5.4 Physically condensed export (core: this *is* the edited-down video)
Previously framed as optional, this is now a required pipeline step — the condensed cut is the video that lands on the Notion page. FFmpeg cuts each marked segment and joins them with the concat demuxer using stream-copy — instant and lossless, but cuts snap to keyframes (up to ~2s drift on typical GOPs); re-encode only when frame-exact boundaries matter (~5-10x slower) ([Mux clipping](https://www.mux.com/articles/clip-sections-of-a-video-with-ffmpeg), [Mux concat](https://www.mux.com/articles/stitch-multiple-videos-together-with-ffmpeg)). Emit a **cut map** (`condensed_time ↔ original_time` per segment) alongside the file — the player widget and the notes need it to translate timestamps.

**Mark→segment policy (a mark is an instant; the export cuts ranges).** A manual hotkey mark carries a single timestamp — and is by nature pressed *after* the interesting moment happens (the replay-buffer premise of Medal/ShadowPlay, §2.2); only VAD-derived marks naturally have extents. Default segment window: **`[mark − 20s, mark + 10s]`** (configurable), extended to enclose any overlapping VAD speech segment so a dictated note is never cut mid-sentence, then merge overlapping windows. The same policy feeds the WebVTT chapter cues (§5.2).

**Cut-map correctness under keyframe snap.** Because stream-copy boundaries snap to keyframes, the cut map must be built from the **actual post-snap boundaries**: after cutting, `ffprobe` each emitted segment for its real start/duration and derive the map from those — never from the requested times, which would be silently wrong by up to a GOP per segment and corrupt every note lookup and the condensed→original translation in §5.1's fallback mode. Pad segment requests by ≥ one GOP beyond the policy window so snap direction never trims note audio; reserve re-encode mode for boundaries that must be frame-exact.

### 5.5 Serving video self-hosted
A faststart MP4 behind any server honoring HTTP Range requests (nginx static files) is sufficient; skip HLS unless you later need adaptive bitrate ([Bernat](https://vincent.bernat.ch/en/blog/2018-self-hosted-videos), [nginx mp4 module](https://nginx.org/en/docs/http/ngx_http_mp4_module.html)).

### 5.6 Web shell: greenfield vs forking Cap — two mutually exclusive strategy branches
Cap already solves record → transcribe → self-host (Docker Compose) → shareable link with comments. Its LICENSE is **AGPLv3 for the app, MIT for the `cap-camera*` and `scap-*` capture crates** ([Cap LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE)). Forking and even selling/hosting a fork is legal under AGPLv3 — but **a Cap fork is incompatible with §6.1's sole-copyright dual-licensing model**: with Cap Software holding copyright on the forked code you are no longer sole copyright holder of the combined work, so selling commercial licenses (monetization path #2 in §6.3) becomes impossible, and even your own hosted cloud version must offer full source under AGPL §13. Treat these as explicit branches, to be chosen before any code is written:

- **Branch A — greenfield, sole copyright (default):** slower start, but full Plausible-style dual-license optionality per §6.1 (free self-host + paid cloud + commercial licenses).
- **Branch B — Cap fork:** faster start, but locked into pure-AGPL monetization (hosting convenience, support) unless Cap Software grants a commercial license. If this branch is ever attractive, get that commercial-license answer from Cap Software *before* building on the fork.

The MIT-licensed capture crates (`cap-camera*`, `scap-*`) are usable under either branch.

---

## 6. Licensing & Business Model

### 6.1 The proven pattern: AGPLv3 + sole copyright + hosted cloud
- **Plausible** (AGPLv3): "the change to AGPLv3 makes no difference to any of you who subscribe to Plausible Cloud or who self-host Plausible, but it may upset a few corporations who tried to use our software to directly compete with us without contributing back" ([Plausible blog](https://plausible.io/blog/open-source-licenses)).
- **Cal.com** moved MIT → AGPLv3 for the same reason, selling hosting + enterprise ([Cal.com blog](https://cal.com/blog/changing-to-agplv3-and-introducing-enterprise-edition)).
- AGPLv3's §13 network clause means anyone hosting a *modified* copy as a service must offer source — self-hosters and personal users are completely free; competitors can't fork-and-host proprietary ([AGPL for SaaS explained](https://fastcrw.com/blog/agpl-3-for-saas-explained), [HN](https://news.ycombinator.com/item?id=17453008)).
- As **sole copyright holder** you aren't bound by your own AGPL grant: you can sell a hosted cloud version *and* sell commercial licenses to businesses that can't accept AGPL (classic dual licensing) ([architecture-weekly](https://www.architecture-weekly.com/p/why-open-source-isnt-always-fair)). **This entire model requires §5.6 Branch A (greenfield)** — a Cap fork forfeits sole copyright and with it the dual-license path. Stricter alternatives if AGPL feels too permissive later: Sentry's FSL (converts to Apache/MIT after 2 years) or n8n's Sustainable Use License — both "source-available," not OSI-open-source ([TechCrunch on FSL](https://techcrunch.com/2023/11/20/with-functional-source-license-sentry-wants-to-grant-developers-freedom-without-harmful-free-riding/), [n8n SUL](https://docs.n8n.io/sustainable-use-license/)).
- Desktop precedent: **Joplin** — free open client, users self-sync free via their own storage, or pay for Joplin Cloud from €2.99/mo; note its split-license architecture (permissive client, separately-licensed server) ([Joplin](https://github.com/laurent22/joplin), [FOSS Force](https://fossforce.com/2026/01/try-joplin-your-open-source-evernote-alternative/)).

### 6.2 Dependency hygiene
- **OBS**: never link libobs (GPL contamination, no commercial license available ([OBS forum](https://obsproject.com/forum/threads/permission-to-use-the-libobs-or-part-of-it-for-my-own-open-source-project.167514/))); control it over obs-websocket as a separate installed program (mere aggregation per [GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html)). OBS being GPLv2-**or-later** ([COPYING](https://github.com/obsproject/obs-studio/blob/master/COPYING)) also means it can be taken under GPLv3, which is one-way compatible with AGPLv3 if you ever did need deeper integration ([FSF license list](https://www.gnu.org/licenses/license-list.en.html)).
- **FFmpeg**: use an **LGPL-only build** (no `--enable-gpl`, no `--enable-nonfree`), dynamically linked; **x264 is GPL** and flips the whole build ([FFmpeg legal](https://www.ffmpeg.org/legal.html), [x264](https://en.wikipedia.org/wiki/X264), [BtbN builds issue](https://github.com/BtbN/FFmpeg-Builds/issues/29)). Prefer OS/hardware H.264/HEVC encoders (NVENC/AMF/QSV via OBS handles encoding anyway).
- All recommended STT/player/transcript components are MIT/BSD/Apache — no constraints on selling.

### 6.3 Monetization paths (in order of effort)
1. Free AGPL self-host (your personal use) + paid hosted cloud for teams (Plausible model).
2. Dual license: commercial license for studios that won't touch AGPL.
3. Open-core feature gating: e.g., cloud STT tier, team dashboards, SSO as paid (Supabase/GitLab pattern ([open-core](https://en.wikipedia.org/wiki/Open-core_model))).

---

## 7. Proposed System Architecture

```
┌────────────── Recording session (Windows) ──────────────┐
│  Capture target (any): game in windowed / fullscreen /   │
│  borderless mode · video · any app · webcam ·            │
│  mobile-device screen (mirror or capture card)           │
│                                                          │
│  [optional] Own game ──telemetry SDK──► localhost pipe   │
│                                      │ game_time         │
│  Electron recorder app ◄─────────────┘                   │
│   ├─ globalShortcut: MARK hotkey                         │
│   ├─ obs-websocket client ──► OBS Studio (Hybrid MP4)    │
│   │    StartRecord / StopRecord / CreateRecordChapter    │
│   │    GetRecordStatus at each mark (video_t anchor)     │
│   │    (Game / Window / Display / Device capture source  │
│   │     chosen per target; optional user-added webcam    │
│   │     source composited by OBS — not app-managed)      │
│   ├─ native helper: Raw Input hotkey fallback            │
│   └─ session.json sidecar (source of truth):             │
│        marks[]: {mono_offset, video_t, game_t?, label}   │
└──────────────────────────────────────────────────────────┘
                          ▼  stop
┌────────────── Post-session pipeline ─────────────────────┐
│  Silero VAD ► speech segments ("significant audio")      │
│  faster-whisper + WhisperX ► word-timestamped transcript │
│  Merge: marks + VAD segments + transcript + game_time    │
│  FFmpeg ► condensed.mp4 (edited-down video) + cut map    │
│  Emit: player-embed page + chapters.vtt                  │
│        + youtube/description.txt (note-derived chapters) │
└──────────────────────────────────────────────────────────┘
          ▼  upload condensed.mp4 → YouTube, UNLISTED
          │  (manual Studio upload; API uploader after audit)
          ▼  publish (Notion API)
┌────────── END STATE: Notion page per session ────────────┐
│  ├─ edited-down video: `video` block on the unlisted     │
│  │   YouTube upload, chapters = the notes  (fallbacks:   │
│  │   Notion file upload; embed of the synced player)     │
│  ├─ notes as native Notion blocks (note text, video_t as │
│  │   youtu.be/<id>?t= link, game_t, mark type) —         │
│  │   commentable/editable in Notion                      │
│  └─ optional seek ↔ notes sync via the embedded player   │
│      widget (Vidstack + segment-skip/note-sync module +  │
│       Hyperaudio Lite)  [self-hosted, nginx Range reqs]  │
└──────────────────────────────────────────────────────────┘
```

**Build-order suggestion:** (1) Electron + obs-websocket + hotkey + sidecar JSON — usable day one with raw OBS output; (2) native capture helper (Raw Input fallback, §3.6 — the webcam track was dropped 2026-08-23); (3) post-session STT/VAD pipeline; (4) FFmpeg condensed export + standalone player-embed page (the first-class self-hosted report) + YouTube kit (`youtube/description.txt` with note-derived chapters) + Notion publisher (YouTube `video` block + `youtu.be?t=` note links; Notion file upload as fallback); (5) *optional:* API uploader once the YouTube compliance audit passes, and the embedded synced player widget (Tier 3 seek↔notes sync) for teams that self-host; (6) game telemetry SDK (optional, own-game targets only); (7) hosted/multi-user shell (greenfield, or — Branch B only, §5.6 — a Cap fork).

---

## 8. Risks & Open Items

1. **OBS crash loses Hybrid MP4 chapters** (written at finalization) — mitigated by the sidecar JSON as source of truth ([Hybrid MP4 KB](https://obsproject.com/kb/hybrid-mp4)).
2. **obs-websocket GPL boundary** rests on FSF FAQ doctrine, not case law — get one legal review before commercial launch ([GPL FAQ](https://www.gnu.org/licenses/gpl-faq.en.html)).
3. **Exclusive-fullscreen capture** without OBS's hook is impossible via DXGI-based APIs ([electron#21063](https://github.com/electron/electron/issues/21063)) — since we do not assume borderless-windowed targets, exclusive-fullscreen games must go through OBS Game Capture (never Electron capture APIs); anti-cheat conflicts with the hook remain a risk for third-party titles ([OBS game capture troubleshooting](https://obsproject.com/kb/game-capture-troubleshooting)).
4. **Vidstack point-markers** need a custom overlay (open issue [#1660](https://github.com/vidstack/player/issues/1660)).
5. **Cloud STT word-timestamp fields** (Deepgram/AssemblyAI) unverified against current API docs — check before building that tier.
6. If considering §5.6 **Branch B** (Cap fork), get Cap Software's commercial-licensing answer *before any code is written on the fork* — the fork forecloses the §6.1 dual-license model — and audit the AGPL/MIT boundary per directory ([Cap LICENSE](https://github.com/CapSoftware/Cap/blob/main/LICENSE)).
7. **Notion end-state caveats:** (a) **verified live 2026-08-23:** per-file upload limits are **5 MiB on free workspaces / 5 GiB on paid**, with multi-part upload required above 20 MiB ([Notion files guide](https://developers.notion.com/guides/data-apis/working-with-files-and-media)); the single-part path, the free-plan fallback and >100-block batching all work, and file-upload creation must declare `content_type` or the part is rejected — this is why the video carrier moved to YouTube (§5.0 decision) and the Notion upload is now only a fallback; (b) Notion's native video block has no playback API and no timestamp deep-links, so Tier 3 sync depends entirely on the embedded widget; (c) embed blocks are iframes of a URL the *viewer* must be able to reach — a purely local pipeline needs at least one small hosted endpoint for the widget (or accept Tier 1/2, or the standalone self-hosted report, §5.0) — and API-created embed blocks skip Notion's embeddability validation, so the widget page must explicitly allow framing by notion.so and be render-verified once manually; (d) Notion API rate limits (~3 req/s) matter if a session emits hundreds of note blocks — batch with `children` arrays on page creation.
9. **YouTube as the video carrier (§5.0 decision):** (a) **policy, verified in docs:** uploads from an API project that has not passed the compliance audit are locked private with no appeal ([videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert), [help 7300965](https://support.google.com/youtube/answer/7300965)); whether the lock also overrides `unlisted` is only community-reported (assume yes) — hence manual Studio upload first, API uploader only after the audit; (b) OAuth: `youtube.upload` is a sensitive scope (verification to go *In production*); in *Testing* refresh tokens expire after 7 days; (c) **verified live 2026-08-24:** an API-created Notion `video` block rendered and played the unlisted upload, note `?t=` links opened at the expected time, and note-derived chapters appeared in both YouTube and the embedded player (`verification/evidence/m2/m2.3-result.txt`); the checked remote resources were later removed or unshared, so the committed result is the durable evidence; (d) chapters need ≥ 3 timestamps, `0:00` first, ≥ 10 s each — sessions with fewer/closer notes get plain clickable timestamps but no chapter bar; (e) the data leaves the studio for Google's servers — teams with NDA footage need the self-hosted output or the Notion-upload fallback instead; (f) YouTube may transcode/age-gate/Content-ID-claim game footage; unlisted + `selfDeclaredMadeForKids: false` + `embeddable: true` is the setting that keeps embeds working.
8. **OBS distribution/onboarding for the sellable product:** the mere-aggregation licensing argument (§3.2) assumes a *separately installed* OBS, and getting a paying customer to OBS 30.2+, with obs-websocket enabled, a password set, and the Hybrid MP4 profile selected is nontrivial first-run friction. Ship a guided preflight/first-run wizard that detects and validates the OBS install and configures the websocket + Hybrid MP4 profile; include "may we bundle or auto-download the OBS installer?" in the legal review's question list (risk 2), since bundling edges closer to distribution-of-a-combined-work.

---

## 9. Bibliography

1. https://www.playtestcloud.com/resources/recording-technology
2. https://help.playtestcloud.com/en/articles/1148747-everything-you-need-to-know-about-playtestcloud
3. https://www.lookback.com/all-lookbacks-features
4. http://help.lookback.io/recording-editing-and-sharing-research/common-questions-about-recording-editing-and-sharing-research/how-can-i-create-a-highlight-save-part-of-a-recording
5. https://testersupport.usertesting.com/hc/en-us/articles/115003700531-FAQ-UserTesting-Screen-Recorder-
6. https://gamesuserresearch.com/a-simple-set-up-for-recording-mobile-games-playtests/
7. https://gamesuserresearch.com/running-a-games-user-research-study/
8. https://medal.tv/learn/instant-replay-pc
9. https://support.medal.tv/support/solutions/articles/48001157618-how-to-record-and-make-clips
10. https://www.xda-developers.com/how-turned-obs-shadowplay-replacement/
11. https://obsproject.com/forum/resources/how-to-setup-instant-replay-in-obs-studio.613/
12. https://cap.so/open-source-screen-recorder
13. https://sendrec.eu/
14. https://www.descript.com/
15. https://reduct.video/blog/transcription-software-for-video/
16. https://tldv.io/video-to-text-transcription/
17. https://github.com/electron/electron/issues/21063
18. https://www.electronjs.org/docs/latest/api/global-shortcut
19. https://github.com/tauri-apps/tauri/issues/7318
20. https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/
21. https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
22. https://obsproject.com/kb/hybrid-mp4
23. https://obsproject.com/forum/threads/obs-chapter-marker-creation-naming-via-websocket.179696/
24. https://obsproject.com/kb/game-capture-troubleshooting
25. https://obsproject.com/forum/threads/permission-to-use-the-libobs-or-part-of-it-for-my-own-open-source-project.167514/
26. https://github.com/obsproject/obs-studio/blob/master/COPYING
27. https://www.gnu.org/licenses/gpl-faq.en.html
28. https://www.gnu.org/licenses/license-list.en.html
29. https://crates.io/crates/windows-capture
30. https://github.com/CapSoftware/scap
31. https://deepwiki.com/LiveSplit/LiveSplit/1.1-features-and-capabilities
32. https://github.com/LiveSplit/LiveSplit.AutoSplitters
33. https://pypi.org/project/faster-whisper/
34. https://vexascribe.com/whisperx
35. https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/whisperx-diarization-word-level-timestamps
36. https://www.promptquorum.com/power-local-llm/local-whisper-stt-comparison-2026
37. https://smartscope.blog/en/generative-ai/foundations/whisper-local-cpu-implementation/
38. https://onegen.ai/project/enhance-speech-detection-with-silero-vad-a-comprehensive-guide-to-tuning-and-implementation/
39. https://pypi.org/project/silero-vad
40. https://github.com/k2-fsa/sherpa-onnx
41. https://senoritadeveloper.medium.com/whisper-webgpu-2b1cadfab897
42. https://www.onresonant.com/resources/local-stt-models-2026
43. https://stt.ai/models/nvidia-parakeet/
44. https://perspectives.nvidia.com/nemotron-speech/task/faq/what-are-the-most-production-ready-open-speech-recognition-models-for-european-l/
45. https://futureagi.com/blog/speech-to-text-apis-in-2026-benchmarks-pricing-developer-s-decision-guide/
46. https://deepgram.com/learn/best-speech-to-text-apis-2026
47. https://www.w3.org/TR/media-frags/
48. https://developers.google.com/ad-manager/dynamic-ad-insertion/sdk/html5/snapback
49. https://experienceleague.adobe.com/en/docs/media-analytics/using/legacy-implementations/track-av-playback/tracking-scenarios/vod-skipped-chapter
50. https://github.com/vidstack/player/discussions/1747
51. https://vidstack.io/
52. https://github.com/vidstack/player/issues/1660
53. https://github.com/hyperaudio/hyperaudio-lite
54. https://github.com/hyperaudio/hyperaudio-lite-editor
55. https://ableplayer.github.io/ableplayer/
56. https://www.radiantmediaplayer.com/docs/latest/chapters.html
57. https://www.mux.com/articles/clip-sections-of-a-video-with-ffmpeg
58. https://www.mux.com/articles/stitch-multiple-videos-together-with-ffmpeg
59. https://vincent.bernat.ch/en/blog/2018-self-hosted-videos
60. https://nginx.org/en/docs/http/ngx_http_mp4_module.html
61. https://github.com/CapSoftware/Cap/blob/main/LICENSE
62. https://plausible.io/blog/open-source-licenses
63. https://cal.com/blog/changing-to-agplv3-and-introducing-enterprise-edition
64. https://fastcrw.com/blog/agpl-3-for-saas-explained
65. https://news.ycombinator.com/item?id=17453008
66. https://www.architecture-weekly.com/p/why-open-source-isnt-always-fair
67. https://techcrunch.com/2023/11/20/with-functional-source-license-sentry-wants-to-grant-developers-freedom-without-harmful-free-riding/
68. https://docs.n8n.io/sustainable-use-license/
69. https://www.ffmpeg.org/legal.html
70. https://en.wikipedia.org/wiki/X264
71. https://github.com/BtbN/FFmpeg-Builds/issues/29
72. https://github.com/laurent22/joplin
73. https://fossforce.com/2026/01/try-joplin-your-open-source-evernote-alternative/
74. https://en.wikipedia.org/wiki/Open-core_model
75. https://developers.notion.com/guides/data-apis/working-with-files-and-media
76. https://github.com/electron/electron/issues/11226
77. https://developers.notion.com/reference/block — `video` block: supported external URL types (YouTube watch/embed); `embed` block allow-list
78. https://support.google.com/youtube/answer/9884579 — video chapters: `0:00` first, ≥3 timestamps, ≥10 s each
79. https://developers.google.com/youtube/v3/docs/videos — `snippet.description` ≤ 5000 bytes; `status.privacyStatus/embeddable/selfDeclaredMadeForKids`
80. https://developers.google.com/youtube/v3/docs/videos/insert — unverified API projects (created after 2020-07-28) → uploads locked private; 256 GB max
81. https://support.google.com/youtube/answer/7300965 — "locked as private" (unverified API service), no appeal
82. https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits + https://support.google.com/youtube/contact/yt_api_form — compliance audit / quota form
83. https://developers.google.com/youtube/v3/determine_quota_cost — `videos.insert` 1 unit (own 100/day bucket), `videos.update` 50 units (docs as of 2026-06)
84. https://developers.google.com/youtube/v3/guides/auth/installed-apps — installed-app OAuth, loopback redirect, `youtube.upload` scope
85. https://support.google.com/cloud/answer/15549945 — OAuth *Testing* status: consents/refresh tokens expire after 7 days
86. https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol — resumable upload, 256 KiB chunk multiples
87. https://developers.google.com/youtube/player_parameters — `embed/<id>?start=<s>`; watch links use `t=<s>`
