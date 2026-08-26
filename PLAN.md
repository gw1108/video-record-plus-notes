# PLAN — next steps

State as of 2026-08-26: Phase 1 (recorder ↔ OBS ↔ pipeline) is
validated against a **live OBS session** (M1, `verification/evidence/m1/`), the recorder
UX round is live-verified (M5, `verification/evidence/m5/`), and the **default sharing
path is proven live** (M2, `verification/evidence/m2/`). The Notion publisher's page
creation, single-part upload + attach, Free-plan fallback, 150-note batching
and transcript toggle ran against the live API on 2026-08-23; a missing
`content_type` on upload creation was found and fixed. That test established
that George's Free workspace has a 5 MiB cap and that Notion-hosted video is
the wrong default carrier. The selected path is an **unlisted YouTube upload
of the condensed cut**, with note-derived chapters in its description. On
2026-08-24 that path passed its end-to-end human check: YouTube showed the
chapter bar, an API-created Notion `video` block rendered and played the
unlisted video, note `?t=` links opened at the expected time, and chapters
appeared in the embedded player (`verification/evidence/m2/m2.3-result.txt`). The checked
YouTube and Notion resources have since been removed or unshared, so the
committed result artifact—not the old URLs—is the durable evidence. The
pipeline kit and publisher behavior also remain covered by automated tests.
The LGPL FFmpeg implementation route is settled and verified (M6,
`verification/evidence/m6/`), but the release wheel does not yet contain the binaries.

Research facts that shape M2 (sources in the tech-stack report §9, 77–87):

- Notion renders a `video` block whose `external.url` is a YouTube
  `watch?v=` link as the real YouTube player (documented); use `video`,
  not `embed`. Unlisted videos are embeddable; private ones are not.
- Chapters = timestamps in the description: first must be `0:00`, ≥ 3
  timestamps, ascending, each chapter ≥ 10 s; description ≤ 5 000 **bytes**,
  no `<`/`>`. They render on unlisted videos.
- Deep links: `https://youtu.be/<id>?t=<seconds>` (`&t=` on `watch?v=`).
- **API uploads from a Google Cloud project that has not passed YouTube's
  compliance audit are locked to private, no appeal** (projects created
  after 2020-07-28); the lock is reported to override `unlisted` too. The
  audit is free but wants an https site + privacy-policy URL and takes
  weeks. `youtube.upload` is a sensitive OAuth scope; while the consent
  screen is in *Testing*, refresh tokens expire after 7 days. Quota is a
  non-issue (`videos.insert` = 1 unit of its own 100/day bucket).
- Verified live 2026-08-24: an API-created Notion `video` block rendered
  and played an **unlisted** video, note `?t=` links opened at the expected
  time, and note-derived chapters appeared in both YouTube and the embedded
  player (`verification/evidence/m2/m2.3-result.txt`).

Consequence: **manual Studio upload of the pipeline's output is the product
path** (unlisted immediately, ~1 min per session); the API uploader is an
opt-in after the audit. Milestones are ordered by risk retired per unit of
work. Completed items are deleted from this file, not checked off.

Paths used below (all exist today):

- `REPORT_SMALL` = `C:\Users\George\Videos\PlaytestSessions\2026-08-23_172859_m5-live\report`
  (6 s, 3 notes, no speech — too short for chapters; the *graceful* case)
- `REPORT_BIG` = `C:\Users\George\Videos\PlaytestSessions\2026-08-23_114134_m1-live\report`
  (1:30, 6 dictated notes + transcript; notes at 0:08, 0:19, 0:24, 0:49,
  0:59, 1:21 in condensed time — the chapter-folding case: 0:08 is < 10 s
  after `0:00`, 0:24 is < 10 s after 0:19, 1:21 is < 10 s before the end;
  its `youtube/description.txt` has the expected 4 chapters `0:00 / 0:19 /
  0:49 / 0:59`). NB: the original OBS recording of this session is no longer
  on disk, so `process` cannot re-run there — `report/` (incl.
  `condensed.mp4`) is intact and remains the main regression fixture.

---

## M2 — API uploader (opt-in, gated on Google's audit — later)

**Wizard:** `bash verification/wizards/wizard-m2.4-youtube-api.sh` covers the first two items
(privacy page → Cloud project → API → consent screen → Desktop client JSON →
audit form; ids to `.env`, client JSON to `%APPDATA%\playtest-recorder\`).
The uploader CLI itself (item 3) is code, written after the audit passes.

- [ ] **Compliance audit first** (George; free; weeks): the tool needs a
      public https page with a privacy policy that has a YouTube-data
      section (the repo's GitHub Pages is enough), then
      <https://support.google.com/youtube/contact/yt_api_form>. Until it
      passes, every API upload is locked private, so do **not** build the
      uploader as the default path.
- [ ] **Google Cloud setup** (≈10 min): project → enable *YouTube Data API
      v3* → OAuth consent screen (External, *Testing*, add your Google
      account as test user) → Credentials → OAuth client ID, type
      **Desktop app**; download the JSON to
      `%APPDATA%\playtest-recorder\youtube-client.json` (gitignored path).
- [ ] **`playtest-youtube upload <reportDir>`** (`packages/youtube-uploader`,
      or a `youtube` subcommand of the publisher): installed-app OAuth with
      loopback redirect (`http://127.0.0.1:<port>`), scope
      `https://www.googleapis.com/auth/youtube.upload`, tokens cached in
      `%APPDATA%\playtest-recorder\youtube-token.json`; resumable upload
      (`uploadType=resumable`, 8 MiB chunks = multiple of 256 KiB, resume on
      308 via `Content-Range: bytes */total`); body: `snippet.title/description`
      from the kit, `status: { privacyStatus: 'unlisted', embeddable: true,
      selfDeclaredMadeForKids: false }`; prints the `youtu.be` URL and
      writes it to `report/youtube/url.txt` so `playtest-notion publish`
      can pick it up without `--youtube`. Expect weekly re-consent while
      the consent screen is in *Testing*.
- [ ] Recorder: *Publish* button in the Sessions card = upload (if
      configured) → publish; otherwise open the kit folder + YouTube
      Studio.

## M3 — Self-hosted embed in Notion (optional now)

The YouTube carrier removes the need for a hosted URL. `deploy/` stays the
**self-host-pure** output (Path A) and the only route to bidirectional
seek↔notes sync. If a team ever wants that *inside* Notion: Caddy +
cloudflared are installed, `deploy/README.md` Path C has the tunnel recipe,
`verification/evidence/m3/local-headers.txt` proves the headers, and the two remaining
steps are: run the tunnel, `npx playtest-notion publish "$REPORT_BIG"
--embed-url https://<random>.trycloudflare.com/report.html --no-upload`,
verify the iframe renders and a `[0:19]` link opens `report.html?t=19`.

## M4 — STT stretch (Phase 3)

- [ ] Stretch: WhisperX forced alignment behind a `[align]` extra for tighter
      word timing (§4.2); keep faster-whisper as the default path. Deferred by
      choice (medium/small already transcribe the M1 notes word-perfectly)
      **and blocked on this rig**: every WhisperX release ≤3.8.x requires
      Python <3.14, and the only 3.14-tagged one (3.2.0) pins
      `ctranslate2==4.4.0`, which has no 3.14 wheel (checked with
      `pip install --dry-run whisperx`, 2026-08-23; this machine runs 3.14.4).
      To pursue it: a Python 3.12 venv (`py -3.12 -m venv .venv-align`),
      `pip install whisperx`, then add `align = ["whisperx>=3.8"]` to
      `pipeline/pyproject.toml` and an `align_words(wav, segments)` step in
      `transcribe.py` that runs `whisperx.load_align_model` + `whisperx.align`
      over the faster-whisper segments and rewrites `words[].startMs/endMs`.

## M5 — Release leftovers

- [ ] **Clean-machine installer run** (needs a Windows PC/VM without
      Node/Rust/Python — a fresh Windows Sandbox works:
      *Turn Windows features on or off → Windows Sandbox*):
      1. Copy `apps\recorder\release\Playtest Recorder Setup 0.1.0.exe` in
         and run it. Expect the SmartScreen "Windows protected your PC"
         dialog (unsigned) → *More info → Run anyway*; installer offers an
         install dir; a Start-menu shortcut *Playtest Recorder* appears.
      2. Launch it: the **setup wizard** must open (fresh config). *Detect
         OBS* should report not found on a bare machine — that is the
         expected copy path, not a bug.
      3. Confirm `<install dir>\resources\capture-helper.exe` exists (default
         install dir: `C:\Users\<you>\AppData\Local\Programs\Playtest Recorder`),
         then in *Hotkeys & options* click the Mark key button and
         press a controller/HID button (or just check the log does **not**
         say `capture-helper.exe not found`).
      4. In the Sessions card press *Run pipeline* on any copied session dir
         (copy one from `PlaytestSessions`): the log must show a clear
         "`playtest-pipeline` is not recognized…" line and *Pipeline exited
         with code 1* — the packaged app does not bundle Python by design.
      5. **Release exit run:** install OBS 32 + Python 3.11+ in the sandbox,
         install `playtest-pipeline` from the selected release wheel, walk the
         wizard to the end, record and mark a 10 s session, stop, run the
         pipeline, and open the emitted report. The first usable release is
         not proven by the expected missing-pipeline error alone.
- [ ] **Code signing** (removes the SmartScreen warning; costs money):
      1. Buy an OV code-signing certificate (cheapest sane route in 2026:
         **Azure Trusted Signing**, ~US$10/month, or an OV cert from
         SSL.com/Sectigo — those ship on a USB token/cloud HSM since 2023).
      2. For a PFX-style cert: set `CSC_LINK` (path to the `.pfx`) and
         `CSC_KEY_PASSWORD` as user env vars and run `npm run dist -w
         playtest-recorder` — electron-builder signs the exe, the
         uninstaller and the installer automatically.
         For Azure Trusted Signing: add to `apps/recorder/package.json`
         `"build.win.azureSignOptions": { "endpoint", "certificateProfileName",
         "codeSigningAccountName" }` and log in with `az login` before `dist`.
      3. Verify: right-click the Setup exe → Properties → *Digital
         Signatures* tab lists the cert; a fresh machine no longer shows
         "Unknown publisher".
- [ ] **Exclusive-fullscreen hotkey check** (manual; M1's injected keys
      cannot reproduce the real input stack):
      1. Pick a game that offers *Exclusive fullscreen* (not borderless) in
         its video settings (e.g. an older DirectX 11 title) and set it.
      2. Recorder: capture mode **Global shortcut**, start a session, alt-tab
         into the game, press F8 three times over ~30 s, F9 once, stop from
         the tray. Sessions card → *Folder* → `session.json`: expect 4 marks
         with `anchor.method: "direct"`; also note whether the game reacted
         to F8 (it should not — the key is swallowed).
      3. Repeat with capture mode **Raw Input helper**: same 4 marks
         expected, and this time the game *does* see the key.
      4. Record the title, DX version and both outcomes in the risk table
         below (risk 3). If a mode misses presses, that title is the
         reproduction case for tauri#7318 — file it in the table, don't fix
         blind.

## M6 — Product track (build-order step 7 + business, later)

- [ ] **Ship the LGPL FFmpeg** (the *decision* half is done: `media.py`
      resolves `$PLAYTEST_FFMPEG_DIR` → `playtest_pipeline/bin/` → PATH,
      `pyproject` ships `bin/*` as package data, `--reencode` prefers
      `h264_nvenc/amf/qsv` → `libopenh264` and never needs libx264 — all
      verified against BtbN `ffmpeg-n8.1-latest-win64-lgpl-8.1.zip`,
      `verification/evidence/m6/`). Remaining, for a release build:
      1. Download that zip again (it is in this session's scratchpad only),
         copy `bin\ffmpeg.exe`, `bin\ffprobe.exe` and `LICENSE.txt` into
         `pipeline\playtest_pipeline\bin\` (gitignored), `python -m build
         pipeline`, and check the wheel lists `playtest_pipeline/bin/ffmpeg.exe`
         (`python -m zipfile -l dist\playtest_pipeline-*.whl | findstr bin/`).
      2. Decide whether the recorder's installer README says "install the
         pipeline wheel (FFmpeg included)" or "install FFmpeg (LGPL build) on
         PATH" — the code supports both; the wheel route is the one that
         needs no user action.
      3. Legal review question list (risk 2): add "LGPL dynamic vs. static" —
         we ship an unmodified static binary as a separate process, which is
         the mere-aggregation case, but confirm. Add: YouTube API Services
         Terms + privacy-policy wording for the uploader (M2.4).
- [ ] **Decide hosted/multi-user shell approach** (§5.6 Branch A vs. B —
      George's call): write a one-page decision note in
      `thoughts/shared/claude-code-design/` covering auth, storage of
      report bundles (S3-style object store + signed URLs vs. self-host
      only), whether Notion stays the collaboration surface, and whether
      YouTube stays the video carrier for a multi-tenant product (NDA
      footage → self-host or Notion upload fallback). Until then the
      self-host path (`deploy/`) is the product.
- [ ] Telemetry SDK for a second engine (Godot/Unreal snippet) — gated on the
      Unity one (`sdk/unity/PlaytestTelemetry.cs`) having been used in a real
      playtest: enable *Game telemetry* in the recorder, run a session with
      the Unity game serving `docs/telemetry-protocol.md`, confirm marks carry
      `gameTimeMs`. Only then port the ~60-line snippet.

---

## Standing risks to keep retiring (from the research docs)

| Risk | Mitigation status |
|---|---|
| GPL boundary is FSF doctrine, not case law (risk 2) | FFmpeg side settled in code (LGPL build verified, separate process, bundled-binary path); legal review still M6 |
| Exclusive-fullscreen hotkey failures (risk 3 / tauri#7318) | Raw Input fallback verified live (injected input); **per-title fullscreen check still manual** (M5, steps above) |
| Notion upload caps / embed validation (risk 7) | Upload path, Free-plan fallback and batching **verified live 2026-08-23**; `content_type` bug fixed; **carrier moved to YouTube** — Notion upload is the fallback only |
| YouTube as carrier (risk 9) | **Default manual path verified live 2026-08-24**: chapter bar rendered, API-created Notion block played the unlisted video, `?t=` links opened at the expected moment, and chapters appeared in the embedded player (`verification/evidence/m2/m2.3-result.txt`). API uploads remain locked private until the compliance audit; sessions with < 3 chapters get plain timestamps, no chapter bar (by design) |
| Notion domain drift | The API returns `app.notion.com` page URLs (2026); `deploy/` CSP allows `*.notion.so`, `*.notion.com`, `*.notion.site` — only matters for the optional M3 embed |
| AMD/Intel encoder parity unknown (perf risk 4) | Untested — on any non-NVIDIA PC: install OBS, run the recorder's preflight (expects `amf`/`qsv` in the encoder label, no "shared with streaming" warning), then `npx electron verification/harnesses/live-m5.mjs session` and check `verification/evidence/m5/session.json` `checks` are all true. Pipeline side: `--reencode` now has `h264_amf`/`h264_qsv` in its chain (args untested on real hardware) |
| Mark anchor ≠ media timeline (found in M1) | outputDuration ~0.5 s early, chapters 0.7–1.3 s late; sidecar wins; TODO in `marks.ts` if tighter sync ever needed |
| OBS pause needs dedicated rec encoder + restart (found in M1) | Preflight warns; tray Pause detects the silent no-op and logs `record-pause-ignored` instead of faking a pause (live-verified with a dedicated encoder in M5) |
| torchaudio ≥ 2.9 needs torchcodec for audio I/O (found in M4) | Pipeline reads `mic.wav` with the stdlib instead of `silero_vad.read_audio`; the `[vad]` extra installs clean |
| Python 3.14 on the dev rig | faster-whisper 1.2.1 + silero-vad + torch 2.13 cu126 all fine; **WhisperX has no 3.14-compatible release** (M4) — use a 3.12 venv for anything that needs it |
| Installer built and smoke-run only on the dev rig | Unsigned; monorepo hoisting handled by electron-builder 26's workspace detection — **clean-machine end-to-end run pending** (M5). Signing is optional for the first usable release but remains desirable |
| Live recording overhead | Research estimates the tuned OBS path at ~2–5% FPS plus negligible app overhead, but there is **no repository artifact measuring this app end to end under a GPU/CPU-intensive game**; release confidence remains benchmark-derived rather than rig-proven |
