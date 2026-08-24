/**
 * M5 live-test harness: drives the REAL compiled recorder modules under
 * Electron against a LIVE OBS instance, exercising the M5 additions —
 * tray-style Pause/Resume (SessionController.pause/resume incl. the
 * shared-encoder no-op detection), configurable mark labels, the segment
 * policy baked into the pipeline command, and the in-app PipelineRunner.
 *
 * Run:  npx electron hack/live-m5.mjs <phase>
 * Phases:
 *   session   — start → mark(issue) → pause → mark while paused → resume →
 *               mark → stop; asserts sidecar labels/events and the command.
 *   pipeline  — runs PipelineRunner on the newest session in sessionsDir
 *               (or the dir given as the next argument) and waits for done.
 *
 * Reads the OBS websocket password from OBS's own plugin config (same file
 * the app's Auto-detect uses). Evidence JSON lands in hack/out-m5/.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ObsClient } from '../apps/recorder/dist/main/obs.js';
import { PipelineRunner } from '../apps/recorder/dist/main/pipeline.js';
import { SessionController, buildPipelineCommand } from '../apps/recorder/dist/main/recording.js';
import { listSessions } from '../apps/recorder/dist/main/sessions.js';
import { fKeyBinding, DEFAULT_PIPELINE } from '../apps/recorder/dist/main/config.js';

const REPO = 'C:\\GameDev\\video-record-plus-notes';
const OUT_DIR = join(REPO, 'hack', 'out-m5');
const SESSIONS_DIR = 'C:\\Users\\George\\Videos\\PlaytestSessions';
const phase = process.argv.find((a) => ['session', 'pipeline'].includes(a)) ?? 'session';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function obsPassword() {
  const path = join(process.env.APPDATA, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return raw.auth_required === false ? '' : raw.server_password ?? '';
}

const config = {
  obs: { host: '127.0.0.1', port: 4455, password: obsPassword() },
  hotkeys: {
    mark: fKeyBinding(8),
    issue: fKeyBinding(9),
    labels: { mark: 'fun', issue: 'bug' }, // non-default labels on purpose
    mode: 'global-shortcut',
  },
  telemetry: { enabled: false, url: 'http://127.0.0.1:46333/playtest/time', pollIntervalMs: 500 },
  pipeline: { ...DEFAULT_PIPELINE, preSeconds: 5, postSeconds: 3, model: 'small' },
  sessionsDir: SESSIONS_DIR,
  helperPath: '',
  setupDone: true,
};

function save(name, data) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

async function runSession() {
  const obs = new ObsClient();
  const controller = new SessionController(obs);
  const log = [];
  controller.on('log', (level, message) => {
    console.log(`  [${level}] ${message}`);
    log.push({ level, message });
  });
  controller.on('status', (s) => console.log(`  status → ${s.state}`));
  await obs.connect(config.obs);
  console.log('connected to OBS', await obs.getVersion());

  controller.setConfigForReconnect(config);
  await controller.start(config, { title: 'm5-live', targetKind: 'other', targetName: 'harness' });
  console.log('session started');
  await sleep(2500);

  const m1 = await controller.mark('issue', 'F9');
  console.log('mark #1 (issue slot) →', m1.label, m1.videoMs, m1.anchor.method);

  let pauseError = null;
  const tPause = Date.now();
  try {
    await controller.pause();
  } catch (err) {
    pauseError = String(err.message ?? err);
  }
  const afterPause = await controller.statusSnapshot();
  console.log(`pause: ${pauseError ?? 'ok'} (${Date.now() - tPause} ms) → state=${afterPause.state}`);
  await sleep(2000);

  const m2 = await controller.mark('mark', 'F8');
  console.log('mark #2 during pause →', m2.label, m2.videoMs, m2.anchor.method);

  let resumeError = null;
  try {
    await controller.resume();
  } catch (err) {
    resumeError = String(err.message ?? err);
  }
  const afterResume = await controller.statusSnapshot();
  console.log(`resume: ${resumeError ?? 'ok'} → state=${afterResume.state}`);
  await sleep(2000);

  const m3 = await controller.mark('mark', 'F8');
  console.log('mark #3 after resume →', m3.label, m3.videoMs, m3.anchor.method);
  await sleep(1500);

  const summary = await controller.stop();
  console.log('stopped:', summary.recordingFile);
  console.log('pipelineCommand:', summary.pipelineCommand);

  const sidecar = JSON.parse(readFileSync(join(summary.sessionDir, 'session.json'), 'utf8'));
  const labels = sidecar.marks.map((m) => m.label);
  const events = sidecar.events.map((e) => e.type);
  const checks = {
    labelsFromConfig: JSON.stringify(labels) === JSON.stringify(['bug', 'fun', 'fun']),
    pauseEventOrIgnored:
      (events.includes('record-paused') && events.includes('record-resumed')) ||
      events.includes('record-pause-ignored'),
    pausedStateReported: afterPause.state === 'paused' || pauseError !== null,
    resumedState: afterResume.state === 'recording',
    commandHasPolicy:
      summary.pipelineCommand.includes('--pre 5') &&
      summary.pipelineCommand.includes('--post 3') &&
      !summary.pipelineCommand.includes('--model'),
    commandMatchesBuilder: summary.pipelineCommand === buildPipelineCommand(config.pipeline, summary.sessionDir),
    recordingExists: Boolean(summary.recordingFile && existsSync(summary.recordingFile)),
    markDuringPauseAnchored: m2.videoMs !== null,
  };
  const evidence = {
    sessionDir: summary.sessionDir,
    recordingFile: summary.recordingFile,
    pipelineCommand: summary.pipelineCommand,
    pauseError,
    resumeError,
    afterPause,
    afterResume,
    marks: sidecar.marks,
    events: sidecar.events,
    log,
    checks,
  };
  save('session', evidence);
  console.log('\nchecks:', checks);
  await obs.disconnect();
  return Object.values(checks).every(Boolean) ? 0 : 1;
}

async function runPipeline() {
  const given = process.argv[process.argv.indexOf('pipeline') + 1];
  const sessionDir = given && existsSync(given) ? given : listSessions(SESSIONS_DIR)[0]?.sessionDir;
  if (!sessionDir) throw new Error('no session to process');
  const runner = new PipelineRunner();
  const lines = [];
  runner.on('started', (dir, command) => console.log('started:', command));
  runner.on('line', (dir, line) => {
    lines.push(line);
    console.log('  |', line);
  });
  const t0 = Date.now();
  const done = new Promise((resolve) => runner.on('done', (dir, code, reportPath) => resolve({ code, reportPath })));
  runner.run(config.pipeline, sessionDir);
  const result = await done;
  const elapsedMs = Date.now() - t0;
  const entry = listSessions(SESSIONS_DIR).find((e) => e.sessionDir === sessionDir);
  const checks = {
    exitZero: result.code === 0,
    reportPathReturned: Boolean(result.reportPath && existsSync(result.reportPath)),
    listingSeesReport: entry?.hasReport === true,
    outputStreamed: lines.length > 5,
  };
  save('pipeline', { sessionDir, ...result, elapsedMs, lineCount: lines.length, lines, checks });
  console.log(`\ndone in ${(elapsedMs / 1000).toFixed(1)} s, exit ${result.code}; checks:`, checks);
  return Object.values(checks).every(Boolean) ? 0 : 1;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = phase === 'pipeline' ? await runPipeline() : await runSession();
  } catch (err) {
    console.error('harness failed:', err);
  }
  app.exit(code);
});
