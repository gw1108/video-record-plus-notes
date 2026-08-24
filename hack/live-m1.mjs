/**
 * M1 live-test harness (PLAN.md M1): drives the REAL compiled recorder
 * modules under Electron against a LIVE OBS instance. No renderer — this
 * exercises exactly the main-process path the app uses (ObsClient,
 * runPreflight/applyRecommended, SessionController incl. globalShortcut
 * hotkey registration, SidecarWriter, MarkAnchorService).
 *
 * Run:  npx electron hack/live-m1.mjs <phase>
 * Phases: preflight | routing | session | obs-stop | kill | raw-input
 *
 * Hotkeys are injected via WScript.Shell SendKeys (goes through the real OS
 * input queue, so RegisterHotKey / Raw Input both see it). Dictated notes are
 * SAPI text-to-speech through the default output device, captured on audio
 * track 2 via a wasapi_output_capture loopback input (created by the
 * `routing` phase alongside routing the real mic to track 2).
 */
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OBSWebSocket from 'obs-websocket-js';
import { ObsClient } from '../apps/recorder/dist/main/obs.js';
import { runPreflight, applyRecommended } from '../apps/recorder/dist/main/preflight.js';
import { SessionController } from '../apps/recorder/dist/main/recording.js';
import { monoMs } from '../apps/recorder/dist/main/util.js';

const REPO = 'C:\\GameDev\\video-record-plus-notes';
const OUT_DIR = join(REPO, 'hack', 'out-m1');
const PASSWORD = process.env.OBS_WS_PASSWORD ?? '';
const LOOPBACK_INPUT = 'TTS Loopback (m1 test)';

const phase = process.argv.find((a) =>
  ['preflight', 'routing', 'session', 'obs-stop', 'kill', 'raw-input'].includes(a),
);

const config = {
  obs: { host: '127.0.0.1', port: 4455, password: PASSWORD },
  hotkeys: { mark: 'F8', issue: 'F9', mode: phase === 'raw-input' ? 'raw-input' : 'global-shortcut' },
  telemetry: { enabled: false, url: 'http://127.0.0.1:46333/playtest/time', pollIntervalMs: 500 },
  sessionsDir: 'C:\\Users\\George\\Videos\\PlaytestSessions',
  helperPath: join(REPO, 'helper', 'capture-helper', 'target', 'release', 'capture-helper.exe'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => `[t=${((monoMs() - t0) / 1000).toFixed(1)}s]`;
let t0 = 0;

function ps(cmd) {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', () => resolve(out.trim()));
  });
}

/**
 * Speak on the Yeti monitor output (lands on track 2 via the loopback input
 * pointed at that endpoint — the default device carries unrelated desktop
 * audio on this machine). Waits for completion.
 */
async function speak(text) {
  console.log(`${stamp()} SPEAK: ${text}`);
  await ps(
    `$v = New-Object -ComObject SAPI.SpVoice; ` +
      `$v.AudioOutput = $v.GetAudioOutputs() | Where-Object { $_.GetDescription() -like '*Yeti*' } | Select-Object -First 1; ` +
      `$null = $v.Speak('${text.replace(/'/g, "''")}')`,
  );
  console.log(`${stamp()} speak done`);
}

/** Inject a key press through the OS input queue. */
async function pressKey(key) {
  const before = monoMs();
  await ps(`(New-Object -ComObject WScript.Shell).SendKeys('{${key}}')`);
  console.log(`${stamp()} PRESSED ${key} (injected between mono ${before.toFixed(0)} and ${monoMs().toFixed(0)})`);
}

function record(obj, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), JSON.stringify(obj, null, 2), 'utf8');
  console.log(`wrote ${join(OUT_DIR, name)}`);
}

async function externalObs() {
  const ext = new OBSWebSocket();
  await ext.connect(`ws://127.0.0.1:4455`, PASSWORD || undefined);
  return ext;
}

function wireController(controller) {
  const marks = [];
  controller.on('log', (level, message) => console.log(`${stamp()} [${level}] ${message}`));
  controller.on('mark-added', (m) => {
    marks.push(m);
    console.log(`${stamp()} MARK #${m.seq} ${m.label} videoMs=${m.videoMs} anchor=${m.anchor.method} rtt=${m.anchor.rttMs ?? '-'}`);
  });
  return marks;
}

async function phasePreflight(obs) {
  const initial = await runPreflight(obs);
  console.log('--- initial preflight ---');
  for (const c of initial) console.log(`  [${c.status}] ${c.label} :: ${c.detail}`);
  const needsFix = initial.some((c) => c.fixable && c.status !== 'pass');
  let after = null;
  if (needsFix) {
    console.log('--- applying recommended settings ---');
    after = await applyRecommended(obs);
    for (const c of after) console.log(`  [${c.status}] ${c.label} :: ${c.detail}`);
  }
  record({ initial, after }, 'preflight.json');
}

/** Mic → track 2 only, Desktop Audio → track 1 only, TTS loopback → track 2 only. */
async function phaseRouting() {
  const ext = await externalObs();
  const setTracks = (inputName, tracks) =>
    ext.call('SetInputAudioTracks', {
      inputName,
      inputAudioTracks: { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false, ...tracks },
    });
  await setTracks('Mic/Aux', { 2: true });
  await setTracks('Desktop Audio', { 1: true });
  const scene = (await ext.call('GetCurrentProgramScene')).sceneName;
  let created = false;
  try {
    await ext.call('CreateInput', {
      sceneName: scene,
      inputName: LOOPBACK_INPUT,
      inputKind: 'wasapi_output_capture',
      inputSettings: { device_id: 'default' },
      sceneItemEnabled: true,
    });
    created = true;
  } catch (e) {
    console.log(`loopback input: ${e.message} (already exists?)`);
  }
  await setTracks(LOOPBACK_INPUT, { 2: true });
  const verify = {};
  for (const name of ['Mic/Aux', 'Desktop Audio', LOOPBACK_INPUT]) {
    verify[name] = (await ext.call('GetInputAudioTracks', { inputName: name })).inputAudioTracks;
  }
  console.log(`scene=${scene} loopbackCreated=${created}`);
  console.log(JSON.stringify(verify, null, 2));
  record({ scene, created, verify }, 'routing.json');
  await ext.disconnect();
}

async function startSession(controller, title) {
  t0 = monoMs();
  await controller.start(config, { title, targetKind: 'app', targetName: 'desktop (m1 live test)' });
  console.log(`${stamp()} session started`);
}

async function phaseSession(obs) {
  const controller = new SessionController(obs);
  controller.setConfigForReconnect(config);
  wireController(controller);
  const stopped = new Promise((r) => controller.on('stopped', r));

  await startSession(controller, 'm1-live');
  await sleep(3000);

  await speak('First note. The lighting in the tutorial room is too dark to read the signs.');
  await pressKey('F8');
  await sleep(5000);

  await speak('Second note. The door collision feels sticky when strafing left.');
  await pressKey('F8');
  await sleep(5000);

  await pressKey('F9');
  await speak('Issue found. The enemy pathfinding gets stuck on the staircase corner.');
  await sleep(8000);

  // Pause/resume from "OBS's UI" — an independent websocket client, exactly
  // what the OBS front end does as far as our app can observe.
  const ext = await externalObs();
  console.log(`${stamp()} external PauseRecord`);
  await ext.call('PauseRecord');
  await sleep(8000);
  console.log(`${stamp()} external ResumeRecord`);
  await ext.call('ResumeRecord');
  await ext.disconnect();
  await sleep(3000);

  await speak('Note after the pause. The boss music is far too loud compared to the dialogue.');
  await pressKey('F8');
  await sleep(10000);

  await pressKey('F8'); // silent mark, no dictation
  await sleep(15000);

  await speak('Final note. Overall the difficulty curve felt fair for a first playthrough.');
  await pressKey('F8');
  await sleep(8000);

  const status = await controller.statusSnapshot();
  console.log(`${stamp()} status: ${JSON.stringify(status)}`);

  const summary = await controller.stop();
  await stopped;
  console.log(`${stamp()} stopped: dir=${summary.sessionDir} marks=${summary.markCount} durationMs=${summary.durationMs}`);
  console.log(`recording: ${summary.recordingFile}`);
  record(summary, 'session.json');
}

async function phaseObsStop(obs) {
  const controller = new SessionController(obs);
  controller.setConfigForReconnect(config);
  wireController(controller);
  const stopped = new Promise((r) => controller.on('stopped', r));
  await startSession(controller, 'm1-obs-ui-stop');
  await sleep(5000);
  await pressKey('F8');
  await sleep(5000);
  // Stop from "OBS's own UI": an external client, not the app.
  const ext = await externalObs();
  console.log(`${stamp()} external StopRecord (simulating OBS UI stop button)`);
  await ext.call('StopRecord');
  await ext.disconnect();
  const summary = await Promise.race([stopped, sleep(15000).then(() => null)]);
  if (!summary) throw new Error('controller did not finalize after external stop');
  console.log(`${stamp()} finalized externally-stopped session: ${summary.sessionDir}`);
  record(summary, 'obs-stop.json');
}

async function phaseKill(obs) {
  const controller = new SessionController(obs);
  controller.setConfigForReconnect(config);
  wireController(controller);
  const stopped = new Promise((r) => controller.on('stopped', r));
  await startSession(controller, 'm1-obs-crash');
  await sleep(3000);
  await speak('Crash test note. This mark must survive the OBS crash via the journal.');
  await pressKey('F8');
  await sleep(4000);
  await pressKey('F9');
  await sleep(3000);
  console.log(`${stamp()} FORCE-KILLING OBS (Task Manager equivalent)`);
  await ps('Stop-Process -Name obs64 -Force');
  await sleep(6000);
  // Marks while OBS is dead: must fall back to the calibrated anchor.
  await pressKey('F8');
  await sleep(4000);
  console.log(`${stamp()} relaunching OBS`);
  await ps(
    `Start-Process 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe' -WorkingDirectory 'C:\\Program Files\\obs-studio\\bin\\64bit' -ArgumentList '--disable-shutdown-check'`,
  );
  // A force-killed OBS shows a "Crash Detected" modal on next launch that
  // blocks startup (websocket refuses connections until dismissed) —
  // --disable-shutdown-check does NOT cover it. Dismiss it so the app's
  // reconnect loop can do its job.
  const dismisser = setInterval(() => {
    void ps(
      `$ws = New-Object -ComObject WScript.Shell; if ($ws.AppActivate('OBS Studio Crash Detected')) { Start-Sleep -Milliseconds 300; $ws.SendKeys('{ESC}'); 'dismissed' }`,
    ).then((out) => {
      if (out) console.log(`${stamp()} crash dialog ${out}`);
    });
  }, 5000);
  const summary = await Promise.race([stopped, sleep(90000).then(() => null)]);
  clearInterval(dismisser);
  if (!summary) throw new Error('controller did not finalize after OBS restart');
  console.log(`${stamp()} finalized crashed session: ${summary.sessionDir}`);
  record(summary, 'kill.json');
}

async function phaseRawInput(obs) {
  const controller = new SessionController(obs);
  controller.setConfigForReconnect(config);
  wireController(controller);
  const stopped = new Promise((r) => controller.on('stopped', r));
  await startSession(controller, 'm1-raw-input');
  await sleep(4000);
  await pressKey('F8');
  await sleep(4000);
  await pressKey('F9');
  await sleep(4000);
  const summary = await controller.stop();
  await stopped;
  console.log(`${stamp()} raw-input session: marks=${summary.markCount} dir=${summary.sessionDir}`);
  record(summary, 'raw-input.json');
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    if (!phase) throw new Error('usage: electron hack/live-m1.mjs <preflight|routing|session|obs-stop|kill|raw-input>');
    console.log(`=== phase: ${phase} ===`);
    if (phase === 'routing') {
      await phaseRouting();
    } else {
      const obs = new ObsClient();
      await obs.connect(config.obs);
      const version = await obs.getVersion();
      console.log(`connected: OBS ${version.obsVersion}, ws ${version.obsWebSocketVersion}`);
      if (phase === 'preflight') await phasePreflight(obs);
      else if (phase === 'session') await phaseSession(obs);
      else if (phase === 'obs-stop') await phaseObsStop(obs);
      else if (phase === 'kill') await phaseKill(obs);
      else if (phase === 'raw-input') await phaseRawInput(obs);
      if (obs.connected) await obs.disconnect();
    }
    console.log(`=== phase ${phase} OK ===`);
  } catch (err) {
    console.error(`=== phase ${phase} FAILED: ${err?.stack ?? err} ===`);
    code = 1;
  }
  app.exit(code);
});
