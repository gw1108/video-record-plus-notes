# Manual golden-path test

Use this guide to test Playtest Recorder as a user would. The main run covers setup, OBS control, recording, marks, dictated notes, pause and resume, processing, and report playback. Later sections cover the optional input, telemetry, publishing, hosting, and recovery paths.

This is a manual acceptance test, not a performance benchmark. Keep the main recording after the test. It is useful evidence when a later change breaks timestamps, audio routing, or report generation.

Plan on 45 to 90 minutes for the required path. Optional device and publishing checks take longer and can be split across testers. Run the numbered sections in order. Run the optional paths only after the main session passes.

## Test result

Record the outcome here.

| Field | Value |
|---|---|
| Tester | |
| Date | |
| App version or Git commit | |
| Windows version | |
| OBS version | |
| Capture target | |
| Result | PASS / FAIL |
| Main session folder | |
| Report path | |
| Notion page, if tested | |
| Notes or bug links | |

The core test passes only when every item marked **Required** passes. Optional feature paths can be recorded as PASS, FAIL, or NOT TESTED.

## What you need ready

Do every item in this list before you start section 1. If an item is already true on your machine, move to the next one.

1. Install Playtest Recorder if it is not installed. Check first: press the Windows key, type `Playtest Recorder`, and look for an app named **Playtest Recorder** in the results. If it is there, skip to item 2. If it is not there, do one of the following:
   - Installer route: double-click `apps\recorder\release\Playtest Recorder Setup 0.1.0.exe` and click through the installer with its default choices. When it finishes, the Start menu contains **Playtest Recorder**.
   - Source route (only if the installer does not exist): open PowerShell in the repository folder and run `npm install`, then `npm run build`. You will launch with `npm run recorder` in section 1.
2. Install the pipeline. Open PowerShell in the repository folder and run `playtest-pipeline --help`. If it prints usage text, skip to item 3. If it says the command is not recognized, run `py -m pip install .\pipeline\dist\playtest_pipeline-0.1.0-py3-none-win_amd64.whl`, close PowerShell, open a new PowerShell, and run `playtest-pipeline --help` again until it prints usage text.
3. Start OBS Studio.
4. In OBS, select a scene that captures something that moves and is easy to recognize. Use a game, a playing video, or a drawing app.
5. Add a visible clock or stopwatch to that scene, for example the Windows Clock app in stopwatch mode placed next to the captured target. Keep it visible for the whole test. It makes a bad seek, a missing pause, or timestamp drift obvious in the report.
6. In OBS, open **Settings > Output > Recording** and set **Audio Track** so that track 1 and track 2 are both checked.
7. In OBS, open **Edit > Advanced Audio Properties**. For the desktop or game audio source, check **Tracks** 1 only. For your microphone source, check **Tracks** 2 only. Close the dialog.
8. Speak into your microphone and confirm its level meter moves in the OBS **Audio Mixer** panel.
9. In OBS, open **Settings > Output > Recording** and set **Video Encoder** to a dedicated hardware encoder (an entry containing NVENC, AMF, or QSV). Do not choose **(Use stream encoder)**; OBS cannot pause a recording that uses it. Click **OK**.
10. Confirm the drive holding the OBS recording folder (**Settings > Output > Recording > Recording Path**) has at least 5 GB free.
11. Close or mute every app that could show passwords, private messages, or notifications on screen during the recording.
12. Only if you will test Notion: put `NOTION_TOKEN` and `PARENT_ID` in the `.env` file in the repository folder, and connect the integration to the parent page in Notion.
13. Only if you will test YouTube: sign in to a YouTube channel on which you are allowed to upload an Unlisted video.

## 1. Open the app and check setup

**Required**

1. Launch Playtest Recorder. Installer route: press the Windows key, type `Playtest Recorder`, and press Enter. Source route: open PowerShell in the repository folder and run `npm run recorder`. A window titled **Playtest Recorder** opens.
2. Look for a dialog titled **Setup wizard** inside that window. If it is not open, click the **Setup wizard** button.
3. Walk through all six wizard steps.
4. On **OBS**, click **Detect OBS**.
5. On **WebSocket**, click **Auto-detect & connect**.
6. On **Profile**, click **Run preflight & apply**.
7. Read the face-cam step. If the OBS scene has a camera, confirm its preview is positioned correctly.
8. On **Rig**, click **Check rig**.
9. Finish the wizard.

Expected result:

- OBS is detected at the installed location.
- The WebSocket step reports **Connected to OBS**. If OBS was closed and its server was disabled, auto-detect may enable it and ask you to start OBS before connecting.
- Preflight shows the installed OBS and obs-websocket versions.
- Hybrid MP4 and audio track 2 pass.
- The recording encoder is a dedicated hardware encoder. A shared stream encoder is a failure for the pause test.
- Rig checks appear in the **Playtest rig advisories** panel. A warning is not an app failure, but record it in the result table.
- **Start recording** becomes enabled after OBS connects.

If **Run preflight & apply** changes the OBS profile, restart OBS, reconnect, and run preflight again. The app can select Advanced output, Hybrid MP4, and recording tracks. It cannot route the microphone or choose and tune the encoder for you.

## 2. Save deterministic test settings

**Required**

Set the following values under **Hotkeys & options**:

| Setting | Test value |
|---|---|
| Mark key | F8 |
| Mark label | observation |
| Issue key | F9 |
| Issue label | issue |
| Capture mode | Global shortcut |
| Game telemetry | Off |
| Run pipeline automatically after stop | Off |
| Command | `playtest-pipeline` |
| STT model | small |
| Seconds before mark | 5 |
| Seconds after mark | 5 |
| Merge gap | 2 |

1. Use the reset button beside each binding if F8 and F9 are not already selected.
2. Confirm the sessions folder points to a location where this test may create files.
3. Click **Save settings**.
4. Close the recorder window with its normal window close button.
5. Confirm the app remains in the Windows notification area.
6. Double-click the tray icon, or use **Show window**, to reopen it.

Expected result:

- Closing the idle window does not quit the app.
- The saved labels, keys, sessions folder, and pipeline settings remain after reopening the window.
- The OBS password field does not reveal the saved password. If a password is stored, its placeholder says it is saved.
- The status says OBS is connected and ready. Reconnect if OBS disconnected while the window was closed.

## 3. Record the main session

**Required**

Enter these session values:

| Field | Value |
|---|---|
| Title | `Golden Path - <tester initials> - <YYYY-MM-DD>` |
| Target | Match the source you are capturing |
| Target name | A short name for the captured game, video, app, or device |

Click **Start recording**. Then follow this script. The times are wall-clock estimates; a few seconds of variation is fine.

| Elapsed time | Action |
|---:|---|
| 0:00 | Start moving or interacting with the captured target. Confirm the recorder window closes. |
| 0:08 | Press F8 once, then say clearly: `Observation alpha. The opening screen is correct.` |
| 0:18 | Stay silent and continue a visibly different action. This gap should be cut from the report. |
| 0:28 | Press F9 once, then say clearly: `Issue bravo. The red object is in the wrong place.` Point at or create a red object if possible. |
| 0:36 | Right-click the tray icon and choose **Pause recording**. Keep the target moving for about five wall-clock seconds. |
| 0:41 | Confirm the tray says **Paused**, then choose **Resume recording**. |
| 0:48 | Right-click the tray icon and choose **Mark (F8)**, then say clearly: `Observation charlie. Playback resumed after the pause.` |
| 0:58 | Right-click the tray icon and choose **Quit**. Confirm the app refuses to quit while recording. |
| 1:03 | Choose **Stop recording** from the tray. |

Expected result while recording:

- The setup window closes completely. Recording continues from the tray.
- The tray icon is red while recording and changes when paused.
- Its tooltip updates about every five seconds with `REC`, elapsed recording time, the mark count, and the session title.
- F8 creates one `observation` mark and F9 creates one `issue` mark even while another app has focus.
- **Mark (F8)** in the tray creates the third mark.
- Recorded time stops advancing while paused. The five seconds of target activity during the pause are absent from the video.
- Choosing **Quit** during the session shows a notification and leaves the app running.
- Stopping opens the recorder window and shows a **Recording stopped** notification.

If pause reports that OBS ignored the request, set a dedicated recording encoder in OBS, restart OBS, and repeat the session. Do not pass the core test with an unverified pause.

## 4. Check the session summary and files

**Required**

After stopping, inspect **Last session** and the first row under **Sessions**.

Expected result:

- The summary title matches the title you entered.
- The summary contains exactly three marks in this order: `observation`, `issue`, `observation`.
- Every mark has a video time. `direct` is the usual anchor method while OBS is connected.
- The summary duration is close to the full wall-clock session, including the pause. The OBS recording and generated report should be shorter by about five seconds because recorded media time stops while paused.
- The recording path is present and points to an existing Hybrid MP4.
- The generated pipeline command contains the session path plus `--pre 5 --post 5 --merge-gap 2`.
- Clicking **Copy** places that full command on the clipboard.
- The newest Sessions row shows the same title, duration, and three marks.
- **Open report** is disabled because the pipeline has not run yet.

Click **Folder** and inspect the session folder without editing it.

Expected files:

```text
session.json
session.journal.jsonl
```

Open `session.json` in a text viewer and confirm:

- `session.title` and the capture target match the UI.
- `session.recordingFile` points to the OBS recording.
- `marks` has three entries with increasing `seq` and `videoMs` values.
- The labels match `observation`, `issue`, `observation`.
- Events include recording start, pause, resume, and stop.

The journal and sidecar are the source of truth for marks. Do not treat MP4 chapters as the only evidence.

## 5. Run the post-session pipeline

**Required**

1. In the main session row, click **Run pipeline**.
2. Watch the session row and the **Log** panel until processing finishes.
3. Do not start another recording while the pipeline is running.

Expected result:

- The row shows a `pipeline running` badge and its action changes to **Cancel**.
- Log output covers session loading, microphone extraction, voice activity detection, speech-to-text, segment planning, condensed export, the report bundle, and the YouTube kit.
- FFmpeg reports a valid bundled, configured, or PATH origin.
- Voice activity detection and speech-to-text do not say `SKIPPED` in this full test.
- Segment planning keeps more than one segment and less than the full recording. The exact number can vary because speech can extend or add windows.
- The command finishes with exit code 0 and reports a `report.html` path.
- The row changes from `pipeline running` to `report`.
- **Open report** becomes enabled.

Click **Folder** again. The folder should now contain:

```text
pipeline/
  mic.wav
  vad.json
  transcript.json
  segments.json
report/
  condensed.mp4
  cutmap.json
  notes.json
  chapters.vtt
  report_data.json
  report.html
  youtube/
    title.txt
    description.txt
```

Listen to a few seconds of `pipeline/mic.wav`. It should contain the microphone and not the desktop or game mix. A wrong track here can still produce a video, but dictated notes will be unreliable.

## 6. Test the generated report

**Required**

Click **Open report**.

Check all of the following:

- [ ] The page title is the session title.
- [ ] The header shows the original duration, a shorter condensed duration, and the note count.
- [ ] The video loads from disk and has picture plus the intended program audio.
- [ ] The paused wall-clock interval is absent.
- [ ] The long silent gaps between alpha, bravo, and charlie are absent or shortened to the configured windows.
- [ ] All three marked moments are present. No marked moment was cut away.
- [ ] The note list shows `OBSERVATION`, `ISSUE`, `OBSERVATION` in order.
- [ ] Each note has recognizable text from its dictated sentence. Punctuation and minor word choices may differ.
- [ ] Note timestamps use original-recording time and increase in the same order as the session summary.
- [ ] Clicking each note seeks to the matching visible moment and starts playback.
- [ ] The active note highlights and scrolls into view as playback reaches its window.
- [ ] The marker strip has a tick for each note. Clicking the strip seeks the video.
- [ ] The `original m:ss` readout advances correctly across condensed segment boundaries.
- [ ] Expanding **Full transcript** shows the spoken phrases.
- [ ] Clicking a transcript timestamp or word seeks to the matching speech.
- [ ] The current transcript word highlights during playback when word timestamps are available.

The **Condensed playback (skip unmarked parts)** checkbox is normally hidden for `condensed.mp4`, because the file has already had unmarked time removed. Its absence is expected in this path.

Test an original-time deep link:

1. Read the original timestamp of the second note.
2. Add `?t=<seconds>` to the end of the `report.html` URL. Use whole seconds, such as `?t=28`.
3. Reload the page.

Expected result:

- The playhead seeks to the corresponding place in the condensed video.
- The matching note highlights.
- If the browser blocks autoplay, the seek still occurs.

Inspect `report/youtube/title.txt` and `description.txt`.

Expected result:

- The title is ready to paste into YouTube Studio.
- The description has readable note-derived chapters in condensed-video time.
- The first YouTube chapter begins at `0:00`.

## 7. Test a cached re-run and cancellation

**Required for re-run. Optional for cancellation if processing finishes too quickly.**

1. Click **Re-run pipeline** for the main session.
2. Let this run finish.

Expected result:

- Existing microphone, VAD, and transcript work is reported as cached.
- The pipeline still rebuilds a usable report and finishes with exit code 0.
- **Open report** still opens the correct report.

To test cancellation, start **Re-run pipeline** again and click **Cancel** while the row still says `pipeline running`.

Expected result:

- The child process stops.
- The app clears the running state and reports a non-success result in the log.
- You can run the pipeline again successfully afterward.

If cached processing finishes before you can click **Cancel**, record cancellation as NOT TESTED. Do not slow or damage the main session merely to make the button clickable.

## 8. Test automatic processing and session deletion

**Required**

This section uses a disposable session so the main evidence remains intact.

1. Turn on **Run pipeline automatically after stop** and click **Save settings**.
2. Record a 20 to 30 second session titled `Golden Path - disposable`.
3. Add one F8 mark and dictate: `Disposable note for automatic processing.`
4. Stop from the tray.

Expected result:

- The window opens after stop.
- The new session immediately shows `pipeline running` without a click.
- A report-ready notification appears after a successful run.
- The disposable row receives the `report` badge.

Now test deletion:

1. Click **Delete** on the disposable row.
2. In the native confirmation dialog, click **Cancel**.
3. Confirm the session remains in the list and on disk.
4. Click **Delete** again.
5. Leave **Also delete the OBS recording** unchecked.
6. Click **Move to Recycle Bin**.

Expected result:

- Cancel causes no deletion.
- Confirming removes the session row.
- The session folder is in the Windows Recycle Bin and can be restored.
- The OBS recording remains in the OBS recording folder.
- The log says the session moved to the Recycle Bin.

If policy allows, restore the disposable session folder from the Recycle Bin, refresh the Sessions list, and confirm it reappears. Otherwise leave it in the bin.

Turn automatic processing off again if it is not the tester's normal preference.

## 9. Check relaunch and clean exit

**Required**

1. Close the idle recorder window.
2. Reopen it from the tray and confirm the main session remains in the Sessions list with a `report` badge.
3. Close the window again.
4. Right-click the tray icon and choose **Quit**.
5. Launch Playtest Recorder again the same way you did in section 1, step 1.

Expected result:

- Quit removes the tray icon when no recording is active.
- Relaunch shows the saved settings and past sessions.
- The main session report still opens.

## Optional feature paths

Run each path that the release claims to support. Record NOT TESTED when the required device, account, instrumented game, or server is unavailable.

### Alternate keyboard binding and Raw Input

1. Click the Mark key button, then press a harmless chord such as Ctrl+Shift+F8.
2. Confirm the button displays the chord.
3. Click the Issue key button and press Escape. Confirm the old binding remains.
4. Select **Raw Input helper (passes key through)** and save.
5. Record a short session while a different app has focus.
6. Press the new mark chord and confirm both that the target app receives it and that the session records one mark.

Pass criteria:

- Binding capture displays and persists the exact chord.
- Escape cancels capture.
- Raw Input records the mark without swallowing the key.
- The log does not report a missing `capture-helper.exe`.

Reset the bindings and capture mode after this test.

### Mouse, controller, HID device, or foot pedal

Repeat this test for every supported input type available on the test machine.

1. Click a binding button.
2. Press the desired mouse, Xbox controller, HID controller, or pedal input.
3. Save settings.
4. Record a short session and press the bound input once.
5. Stop and inspect the summary.

Pass criteria:

- The binding button names the captured input.
- Exactly one mark with the correct label appears.
- Mouse and controller inputs work even if the keyboard capture mode is set to Global shortcut.
- A plain left or right mouse binding warns that every click will create a mark.

Avoid a frequently used mouse button for anything except a short test. It can create hundreds of marks.

### Game telemetry

This test needs a game that implements `docs/telemetry-protocol.md`, such as a Unity scene using `sdk/unity/PlaytestTelemetry.cs`.

1. Start the instrumented game.
2. Confirm this URL returns JSON with `gameTimeMs` and `paused`:

   ```text
   http://127.0.0.1:46333/playtest/time
   ```

3. In the recorder, turn on **Game telemetry**, verify the URL, and save.
4. Start a short game session.
5. Add one mark while the game timer is advancing.
6. Pause the game itself, wait a few seconds, and add another mark while `paused` is true.
7. Resume the game, add a third mark, then stop and process the session.

Pass criteria:

- The sidecar contains `telemetry-connected` and periodic telemetry samples.
- All three marks have `gameTimeMs`.
- Game time advances between the first and third marks.
- Game time stays frozen while the game reports `paused: true`.
- The report shows `game m:ss` beside telemetry-backed notes.
- If the endpoint is stopped for more than about 2.5 seconds, the sidecar records `telemetry-lost` and later marks fall back to no game time without breaking recording.

Turn telemetry off after this test unless the next target supports it.

### YouTube and Notion publishing

Do not publish sensitive playtest footage. Unlisted videos are not private. Anyone with the URL can view them.

1. In YouTube Studio, upload the main session's `report/condensed.mp4`.
2. Paste `report/youtube/title.txt` into the title.
3. Paste `report/youtube/description.txt` into the description.
4. Set the audience correctly and choose **Unlisted** visibility.
5. Copy the resulting `https://youtu.be/<id>` URL.
6. Run:

   ```powershell
   playtest-notion publish "<main session folder>\report" --youtube https://youtu.be/<id>
   ```

7. Open the published Notion page.

Pass criteria:

- The command prints a Notion page URL and exits successfully.
- The page title contains the session title and date.
- The summary lists the note count, original duration, condensed duration, and `video: YouTube (unlisted)`.
- The YouTube player renders and plays. A Private upload will show as unavailable and fails this test.
- The page has a **Notes** heading followed by all notes in order.
- Clicking each note timestamp opens the matching condensed-video time on YouTube.
- The transcript is present inside a collapsed **Full transcript** toggle.
- The source `report.html` still works. Publishing does not alter the local report.

For a paid Notion workspace, you may separately test direct upload by omitting `--youtube`. On a free workspace, a video above 5 MiB is expected to fail upload and produce a fallback message. Treat that limit as expected behavior, not a recorder failure.

### Self-hosted report and Notion embed

1. Serve the main session's `report` directory using the nginx or Caddy recipe in `deploy/README.md`.
2. Open the public HTTPS `report.html` URL in a browser that is not signed into the server.
3. Repeat the report checks from section 6.
4. Publish a Notion page with the hosted URL:

   ```powershell
   playtest-notion publish "<main session folder>\report" --youtube https://youtu.be/<id> --embed-url https://<host>/<path>/report.html
   ```

Pass criteria:

- Video seeking works over HTTP, including after a page reload.
- The server supports byte-range requests, so the browser does not download the entire video before seeking.
- The Notion embed renders the synced report rather than a blank frame.
- The server does not send `X-Frame-Options`.
- Its content security policy allows Notion in `frame-ancestors`.
- Note timestamps on the Notion page open the hosted report at the correct original time. The red play link opens YouTube at the corresponding condensed time.

### Missing recording state

Use the disposable session or another session you can safely manipulate.

1. Close the recorder window.
2. Move the session's OBS recording to a temporary folder on the same drive.
3. Reopen the recorder and click **Refresh**.

Pass criteria:

- The row shows `recording missing`.
- **Run pipeline** is disabled.
- **Folder** still opens the sidecar and report folder.
- An existing report still opens.

Move the recording back to its exact original path and refresh. The badge should disappear and pipeline processing should become available again.

### OBS disconnect and reconnect

Use a disposable recording for this test.

1. Start a session and add one mark.
2. In OBS, disable its WebSocket server without stopping the recording.
3. Add another mark during the connection loss.
4. Re-enable the WebSocket server and wait at least five seconds.
5. Add a third mark and stop from the recorder tray.

Pass criteria:

- OBS continues recording during the WebSocket outage.
- Marks continue through the calibrated fallback.
- The sidecar contains `obs-disconnected` and `obs-reconnected` events.
- The outage mark has a video time and usually reports the `calibrated` anchor method.
- The final report contains all three marked moments.

### OBS-side stop

1. Start a disposable session.
2. Add one mark.
3. Stop recording from OBS instead of the recorder tray.

Pass criteria:

- Playtest Recorder notices the OBS stop and finalizes the session.
- The recorder window opens with a one-mark summary.
- The session is not marked `unfinished`.
- The pipeline can process it normally.

### App crash and journal fallback

This deliberately terminates the recorder. Use a disposable session and do not run it while collecting irreplaceable footage.

1. Start a disposable session and add one mark.
2. Open Windows Task Manager and end the Playtest Recorder process. Do not stop OBS first.
3. Stop the recording from OBS.
4. Start Playtest Recorder again and reconnect to OBS.

Pass criteria:

- OBS continues recording after the recorder process ends.
- The disposable row appears with an `unfinished` badge because the app could not write a normal end event.
- **Folder** opens the session directory and `session.journal.jsonl` contains the session start and mark.
- The recording path is available and the pipeline can process the stopped OBS file.
- The resulting report contains the mark made before the crash.

Now test the journal as the list fallback:

1. Close the recorder window.
2. Rename `session.json` in the disposable session to `session.json.saved`.
3. Reopen the recorder and click **Refresh**.
4. Confirm the row still appears from `session.journal.jsonl` with the correct title and mark count.
5. Rename `session.json.saved` back to `session.json`.

Do not leave the sidecar renamed after the test.

### OBS crash and Hybrid MP4 recovery

This deliberately terminates OBS. Save the current OBS scene and profile first, and use a disposable session.

1. Start a disposable session and add one mark.
2. Use Task Manager to end OBS Studio while it is recording.
3. Start OBS again and dismiss any **OBS Studio Crash Detected** dialog.
4. Wait for Playtest Recorder to reconnect and finalize the interrupted session.
5. Process the session.

Pass criteria:

- The Hybrid MP4 exists and is playable through the last data OBS salvaged.
- The sidecar keeps the pre-crash mark even if the MP4 chapter copy was lost.
- After reconnecting, Playtest Recorder detects that OBS is no longer recording and finalizes the session.
- The pipeline handles a shortened salvaged recording without crashing.
- A mark whose timestamp is beyond the salvaged file is listed as lost footage instead of silently disappearing.

The last criterion needs a mark near the crash boundary and may not occur on every run. Record it as NOT OBSERVED when all marks fit inside the salvaged file.

## Failure rules

Mark the test FAIL if any of these occur in the required path:

- Recording starts without closing the setup window, or recording stops when the window closes.
- A hotkey press creates no mark, creates duplicate marks, or has no video timestamp.
- Quit succeeds while a recording is active.
- Pause appears to succeed but paused content remains in the recording.
- The sidecar loses a mark that the tester created.
- The pipeline skips installed STT or VAD components, exits nonzero, or omits `report.html`.
- A marked moment is missing from `condensed.mp4`.
- A report note seeks to the wrong moment.
- Original-time timestamps go backward or disagree materially with the recorded action.
- Session deletion bypasses confirmation, deletes the OBS recording when its checkbox is clear, or does not use the Recycle Bin.

When something fails, keep the session folder, the OBS recording, and the visible app log. Record the exact step, local time, expected result, actual result, and any notification or error text. Those files are far more useful than a screenshot alone.
