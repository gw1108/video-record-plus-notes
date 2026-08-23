# PLAN — next steps

State as of 2026-08-22: build-order steps 1, 3, 4, 6 (tech-stack report §7)
are scaffolded and verified on synthetic data; nothing has been proven against
a **live OBS session** or the **live Notion API** yet, and the webcam track
(step 2), hosted widget (step 5), and hosted shell (step 7) are unbuilt.
Milestones below are ordered by risk retired per unit of work — M1 and M2
validate everything already written before new surface is added.

---

## M0 — Repo hygiene (minutes)

- [ ] Initial git commit (repo currently has zero commits).
- [ ] Add a `LICENSE` file (AGPL-3.0-only, sole copyright — §6.1 requires
      greenfield Branch A, which this is).

## M1 — First real recording session (validate Phase 1 end-to-end)

The recorder boots and compiles but has never driven a real recording. Run a
real session and fix what breaks:

- [ ] `npm run recorder` → connect to OBS → preflight. **Verify the profile
      parameter names/values against OBS 32.2** (`Output/Mode=Advanced`,
      `AdvOut/RecFormat2=hybrid_mp4`, `AdvOut/RecTracks`) — these were written
      from docs, not tested; confirm "Apply recommended settings" actually
      flips the OBS UI after restart.
- [ ] Route mic to track 2 in OBS Advanced Audio Properties; record ~2 min of
      anything with several F8/F9 presses + dictated notes.
- [ ] Verify the sidecar: marks have `anchor.method: "direct"`, sane `videoMs`,
      small `rttMs`. Cross-check against the Hybrid MP4 chapters
      (`ffprobe -show_chapters`) — expect ≤ ~100 ms disagreement.
- [ ] `playtest-pipeline process <session dir>` → open `report/report.html`,
      confirm notes text (faster-whisper is installed), seek↔notes sync, and
      that dictated sentences are not cut (needs M5's VAD for full behavior).
- [ ] Pause/resume in OBS mid-session → confirm `record-paused/resumed` events,
      calibration reset, and correct mark anchors after resume.
- [ ] Kill OBS mid-session (Task Manager) → confirm journal-based recovery:
      pipeline rebuilds from `session.journal.jsonl`, Hybrid MP4 file is
      salvageable, chapters absent (expected).
- [ ] Stop the recording from OBS's own UI (not the app) → session finalizes.
- [ ] Real game test (exclusive fullscreen if possible): does `globalShortcut`
      F8 fire? Is the key swallowed (expected)? Then switch hotkey mode to
      `raw-input` and verify marks flow from `capture-helper` (key NOT
      swallowed; wall-clock mapping accuracy acceptable).

**Exit criterion:** one real session produces a correct report.html with no
hand-editing. File bugs found as TODOs in code or fix inline.

## M2 — Notion publisher live test (finish Phase 4)

`packages/notion-publisher` is written from API docs and has never run:

- [ ] Create a Notion integration, share a parent page with it, set
      `NOTION_TOKEN`.
- [ ] Publish the M1 session's report. Verify: page creation, summary callout,
      note blocks (timestamps, game time, labels), transcript toggle.
- [ ] Video upload: test a **<20 MiB** condensed file (single_part) and a
      **>20 MiB** one (multi_part + complete). The File Upload API version
      header (`2022-06-28`) may need bumping — check the error body if it 400s.
- [ ] Confirm behavior on a free workspace (5 MiB cap): the graceful-failure
      paragraph path.
- [ ] Batching >100 blocks (session with many marks) and the 350 ms pacing
      under Notion's ~3 req/s limit.

**Exit criterion:** `playtest-notion publish` produces a complete page from a
real report bundle.

## M3 — Webcam track in the native helper (build-order step 2)

The headline "separate webcam track" feature (§3.6, perf §6.2). In
`helper/capture-helper`, replace the `webcam` stub:

- [ ] Media Foundation `IMFSourceReader` on the selected capture device,
      native **MJPEG passthrough** written untouched to disk (AVI or raw
      MJPEG container) — zero live decode/encode. Second-NVENC variant later.
- [ ] Emit a start-stamp line on stdout (`wall_ms` at first sample) so the
      recorder can log the webcam↔recording offset into the sidecar; add a
      `webcam` section to the sidecar schema (shared TS + JSON Schema + Python).
- [ ] Recorder: spawn/stop the helper with the session; device picker in the
      settings UI (helper gains a `list-devices` subcommand).
- [ ] MMCSS registration for the capture thread ("Capture" class, perf §8).
- [ ] Pipeline: transcode the MJPEG post-session (H.264) and place
      `webcam.mp4` in the report bundle.
- [ ] Report page: picture-in-picture corner video, synced via the recorded
      offset (stretch: toggleable).

## M4 — Hosted widget + Notion Tier 3 (build-order step 5)

- [ ] Add `?t=<seconds>` deep-link support to the report page (Tier 2 —
      note-block timestamp links in the publisher already emit `?t=`).
- [ ] Minimal hosting recipe: nginx (or Caddy) static config serving the
      report dir with HTTP Range enabled, **no `X-Frame-Options`**, CSP
      `frame-ancestors 'self' https://*.notion.so` (§5.0 framing caveat).
- [ ] Publish with `--embed-url`, verify the embed **renders inside Notion
      manually once** (API-created embeds skip iFramely validation).
- [ ] Document the self-host-pure path (report.html + nginx, no Notion) as the
      first-class alternative it is.

## M5 — STT/VAD completeness (finish Phase 3)

- [ ] `pip install -e "pipeline[vad]"` (silero-vad + torch) and validate the
      speech-enclosure behavior on the M1 session (dictated notes never cut
      mid-sentence; VAD-only speech becomes candidate segments).
- [ ] Decide default model size by timing `small` vs `medium` on this
      machine's GPU; surface `--model` guidance in the recorder's post-stop
      summary text.
- [ ] Stretch: WhisperX forced alignment behind a `[align]` extra for tighter
      word timing (§4.2); keep faster-whisper as the default path.

## M6 — Recorder UX hardening (pre-release polish)

- [ ] Pause/Resume in the tray menu (`PauseRecord`/`ResumeRecord` — anchor
      service already handles the boundaries).
- [ ] Session browser in the idle window: list past sessions from
      `sessionsDir`, buttons to open report / re-run pipeline.
- [ ] Optional "run pipeline automatically after stop" toggle (spawn
      `playtest-pipeline` from the app; stream progress into the log pane).
- [ ] Configurable segment policy (pre/post seconds) and mark labels in
      settings; persist into the pipeline command.
- [ ] Packaging: electron-builder NSIS installer; bundle the built
      `capture-helper.exe`; app icon; `npm run dist`.
- [ ] First-run wizard skeleton (§8 risk 8): detect OBS install + websocket
      enabled + password, guide through Hybrid MP4/track-2 setup — the
      preflight panel already does the checks; wizard is sequencing + copy.
- [ ] Playtest-rig advisory check panel (perf §8): Game DVR, HAGS, power plan
      — read-only advisories, never forced.

## M7 — Product track (build-order step 7 + business, later)

- [ ] Legal review before anything commercial: obs-websocket mere-aggregation
      position, and whether bundling/auto-downloading the OBS installer is
      acceptable (§3.2, risk 2/8).
- [ ] LGPL FFmpeg build for distribution (current dev machine uses a GPL gyan
      build — fine locally, not shippable; §6.2).
- [ ] Decide hosted/multi-user shell approach (greenfield per §5.6 Branch A).
- [ ] Telemetry SDK for a second engine (Godot/Unreal snippet) once the Unity
      one has been used in anger.

---

## Standing risks to keep retiring (from the research docs)

| Risk | Mitigation status |
|---|---|
| OBS crash loses MP4 chapters (§ risk 1) | Sidecar journal implemented; **test in M1** |
| GPL boundary is FSF doctrine, not case law (risk 2) | Deferred to M7 legal review |
| Exclusive-fullscreen hotkey failures (risk 3 / tauri#7318) | Raw Input fallback built; **verify per title in M1** |
| Notion upload caps / embed validation (risk 7) | Handled in publisher; **verify in M2/M4** |
| AMD/Intel encoder parity unknown (perf risk 4) | Untested — needs a non-NVIDIA rig eventually |
| Preflight profile-parameter names unverified against OBS 32 | **M1 first item** |
