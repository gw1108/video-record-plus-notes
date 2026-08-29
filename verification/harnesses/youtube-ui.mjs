/**
 * M2.4 UI harness: proves the in-app Publish flow, both halves.
 *
 *   npx electron verification/harnesses/youtube-ui.mjs cli
 *   npx electron verification/harnesses/youtube-ui.mjs ui
 *
 * `cli` drives the REAL main-process class (apps/recorder/dist/main/youtube.js)
 * — real spawn, real NDJSON parsing, real kit read/write — against the real
 * `playtest-youtube status --json` and against fake-playtest-youtube.mjs for
 * the paths that would otherwise put a video on a live channel.
 *
 * `ui` boots the REAL renderer bundle and preload in a BrowserWindow, stubs the
 * IPC handlers with canned data, opens the Publish dialog by clicking its
 * button in the DOM (no OS-level synthetic input — see tasks/lessons.md), and
 * captures a screenshot of every state. It is a renderer test: the main-side
 * behaviour it stubs is what the `cli` phase covers for real.
 *
 * Evidence (screenshots + report) lands in verification/evidence/m2.4/.
 * Electron's stdout is dropped on Windows, so the verdict is a file; the exit
 * code is the only reliable signal in a terminal.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasCondensed,
  readKit,
  writeKit,
  YouTubeUploader,
  youtubeUrlOf,
} from '../../apps/recorder/dist/main/youtube.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const OUT_DIR = join(REPO, 'verification', 'evidence', 'm2.4');
const RENDERER = join(REPO, 'apps', 'recorder', 'dist', 'renderer', 'index.html');
const PRELOAD = join(REPO, 'apps', 'recorder', 'dist', 'preload', 'preload.cjs');
const FAKE_CLI = `node "${join(__dirname, 'fake-playtest-youtube.mjs')}"`;
const REAL_SESSION = 'C:\\Users\\George\\Videos\\PlaytestSessions\\2026-08-27_161319_golden-path-gw-2026-08-27';

const phase = process.argv.find((a) => a === 'cli' || a === 'ui') ?? 'cli';
const lines = [];
let failed = 0;

function record(ok, label, detail = '') {
  if (!ok) failed++;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

function finish(name) {
  mkdirSync(OUT_DIR, { recursive: true });
  const report = [`# M2.4 ${name} — ${new Date().toISOString()}`, '', ...lines, '', failed ? `${failed} FAILED` : 'all checks passed', ''].join('\n');
  writeFileSync(join(OUT_DIR, `${name}.txt`), report, 'utf8');
  app.exit(failed ? 1 : 0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Phase `cli`: the real uploader class against the real and the fake CLI.
// ---------------------------------------------------------------------------

async function runCliPhase() {
  const uploader = new YouTubeUploader();

  // 1. The real CLI, real credentials on this machine.
  const real = await uploader.status({ command: 'playtest-youtube', privacy: 'unlisted' });
  record(real.ok === true, 'status: the real playtest-youtube --json parses', `ready=${real.ready} libraries=${real.libraries} client=${real.client?.ok}`);
  record(typeof real.client?.clientId === 'string', 'status: carries the OAuth client id from the real client JSON');

  // 2. A command that does not exist must be a clean answer, not a crash.
  const missing = await uploader.status({ command: 'playtest-youtube-does-not-exist', privacy: 'unlisted' });
  record(missing.ok === false && Boolean(missing.error), 'status: a missing command resolves ok:false with a message', missing.error?.slice(0, 90));

  // 3. Kit read/write against the real golden-path bundle (copied, not edited in place).
  const tmp = mkdtempSync(join(tmpdir(), 'yt-kit-'));
  try {
    const kitDir = join(tmp, 'report', 'youtube');
    mkdirSync(kitDir, { recursive: true });
    writeFileSync(join(tmp, 'report', 'condensed.mp4'), Buffer.alloc(2048));
    writeKit(tmp, 'Edited title', '0:00 Session start\n0:21 MARK — one\n0:59 ISSUE — two');
    const kit = readKit(tmp);
    record(kit.ok && kit.title === 'Edited title', 'kit: writeKit → readKit round-trips the title');
    record(kit.chapters === 3, `kit: counts the timestamp lines (got ${kit.chapters}, want 3)`);
    record(kit.hasVideo && kit.videoBytes === 2048, 'kit: reports the video size');
    record(kit.previousUrl === null, 'kit: no previousUrl before an upload');
    record(hasCondensed(tmp) === true, 'kit: hasCondensed sees report/condensed.mp4');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 4. The real golden-path bundle, read-only.
  const realKit = readKit(REAL_SESSION);
  record(realKit.ok && realKit.chapters === 8, `kit: the golden-path bundle reads 8 chapters (got ${realKit.chapters})`);
  record(realKit.videoBytes > 200 * 1024 * 1024, `kit: golden-path video is ${(realKit.videoBytes / 1024 / 1024).toFixed(1)} MiB`);

  // 5. A whole upload through the real event pipeline, against the fake CLI.
  const uploadDir = mkdtempSync(join(tmpdir(), 'yt-upload-'));
  try {
    mkdirSync(join(uploadDir, 'report'), { recursive: true });
    writeFileSync(join(uploadDir, 'report', 'condensed.mp4'), Buffer.alloc(1024));
    const seen = { started: 0, authWaiting: 0, authDone: 0, progress: [], done: null };
    uploader.on('started', () => seen.started++);
    uploader.on('authWaiting', () => seen.authWaiting++);
    uploader.on('authDone', () => seen.authDone++);
    uploader.on('progress', (_dir, sent, total) => seen.progress.push({ sent, total }));
    const done = new Promise((resolve) => uploader.on('done', (_dir, result) => {
      seen.done = result;
      resolve();
    }));
    uploader.upload(
      { command: FAKE_CLI, privacy: 'unlisted' },
      { sessionDir: uploadDir, title: 'Harness upload', description: '0:00 Session start\n0:30 MARK — two\n1:10 ISSUE — three', privacy: 'unlisted', force: false },
    );
    await done;
    record(seen.started === 1, 'upload: emitted started');
    record(seen.authWaiting === 1 && seen.authDone === 1, 'upload: emitted the auth handshake');
    record(seen.progress.length >= 20, `upload: streamed ${seen.progress.length} progress events`);
    const last = seen.progress.at(-1);
    record(last?.sent === last?.total, 'upload: progress ends at 100%');
    record(seen.done?.ok === true && seen.done.url === 'https://youtu.be/FAKEvideoId1', 'upload: done carries the watch URL', seen.done?.url);
    record(seen.done?.privacyStatus === 'private' && seen.done?.requestedPrivacy === 'unlisted', 'upload: reports the audit-locked visibility separately from the requested one');
    const saved = readKit(uploadDir);
    record(saved.title === 'Harness upload', 'upload: the dialog text was saved to report/youtube/title.txt first');
  } finally {
    rmSync(uploadDir, { recursive: true, force: true });
  }

  // 6. The failure path: an API error must surface with its hint, not a bare exit code.
  const failDir = mkdtempSync(join(tmpdir(), 'yt-fail-'));
  try {
    mkdirSync(join(failDir, 'report'), { recursive: true });
    const uploader2 = new YouTubeUploader();
    process.env.FAKE_YT = 'error';
    const result = await new Promise((resolve) => {
      uploader2.on('done', (_dir, r) => resolve(r));
      uploader2.upload({ command: FAKE_CLI, privacy: 'unlisted' }, { sessionDir: failDir, title: 't', description: 'd', privacy: 'unlisted', force: false });
    });
    record(result.ok === false && /quota|exceeded/i.test(result.error ?? ''), 'upload: an API error surfaces its message', result.error?.slice(0, 90));
    record(Boolean(result.hint), 'upload: and its hint', result.hint?.slice(0, 90));
  } finally {
    delete process.env.FAKE_YT;
    rmSync(failDir, { recursive: true, force: true });
  }

  record(youtubeUrlOf(REAL_SESSION) === undefined, 'kit: the golden-path bundle has not been uploaded (no url.txt)');
  finish('ui-harness-cli');
}

// ---------------------------------------------------------------------------
// Phase `ui`: the real renderer, stubbed IPC, a screenshot per state.
// ---------------------------------------------------------------------------

const SESSIONS = [
  {
    id: 'golden', title: 'Golden Path - GW - 2026-08-27', sessionDir: REAL_SESSION,
    startedAtWall: '2026-08-27T16:13:19.000Z', endedAtWall: '2026-08-27T16:20:27.000Z',
    durationMs: 428_000, markCount: 10, recordingFile: 'C:\\Videos\\golden.mkv', recordingExists: true,
    hasReport: true, hasCondensed: true, youtubeUrl: undefined, unfinished: false,
  },
  {
    id: 'nopipe', title: 'Boss fight pass 2', sessionDir: 'C:\\Videos\\PlaytestSessions\\2026-08-28_boss',
    startedAtWall: '2026-08-28T09:02:00.000Z', endedAtWall: '2026-08-28T09:41:00.000Z',
    durationMs: 2_340_000, markCount: 4, recordingFile: 'C:\\Videos\\boss.mkv', recordingExists: true,
    hasReport: false, hasCondensed: false, youtubeUrl: undefined, unfinished: false,
  },
  {
    id: 'done', title: 'Tutorial flow - playtest 3', sessionDir: 'C:\\Videos\\PlaytestSessions\\2026-08-26_tutorial',
    startedAtWall: '2026-08-26T14:00:00.000Z', endedAtWall: '2026-08-26T14:35:00.000Z',
    durationMs: 2_100_000, markCount: 7, recordingFile: 'C:\\Videos\\tut.mkv', recordingExists: true,
    hasReport: true, hasCondensed: true, youtubeUrl: 'https://youtu.be/EXAMPLE1234', unfinished: false,
  },
];

const KIT = {
  ok: true,
  title: 'Golden Path - GW - 2026-08-27 — playtest 2026-08-27',
  description: [
    '10 notes · original 7:08 · condensed 3:08 · recorded 2026-08-27',
    '',
    '0:00 Session start',
    '0:21 MARK — Okay, I\u2019m going to start recording and press F8 around the 10 second mar…',
    '0:59 ISSUE — Okay, it\u2019s been about a minute, so that whole part should have been cut…',
    '1:32 SPEECH — I swear, chatGPT is so dumb.',
    '1:53 SPEECH — Time to pause the recording. · SPEECH — What am I pausing at?',
    '2:07 SPEECH — So we started resuming around 440-ish, a little bit past that.',
    '2:25 SPEECH — Okay, so we\u2019re going to hit this mark FA, I think around 6 minute mark…',
    '2:57 MARK — 603, so that\u2019s a mark.',
    '',
    'Generated by Playtest Recorder',
  ].join('\n'),
  chapters: 8,
  hasVideo: true,
  videoBytes: 239_463_709,
  previousUrl: null,
};

/** What `youtube:status` answers; the phases below swap this out. */
let statusAnswer = {
  ok: true,
  configDir: 'C:\\Users\\George\\AppData\\Roaming\\playtest-recorder',
  client: { path: 'C:\\…\\youtube-client.json', ok: true, clientId: '5248…apps.googleusercontent.com', project: 'videorecorderplusnotes' },
  token: { path: 'C:\\…\\youtube-token.json', exists: true, expiry: new Date(Date.now() + 6 * 86_400_000).toISOString(), expired: false, scopesOk: true, hasRefreshToken: true },
  libraries: true,
  audit: null,
  auditWarning:
    'the compliance audit has not passed (YOUTUBE_AUDIT_STATUS is unset) — YouTube will lock this upload to PRIVATE regardless of privacyStatus, and it stays uploadable/editable in Studio',
  ready: true,
};

function stubIpc(win) {
  const config = {
    obs: { host: '127.0.0.1', port: 4455, password: '', passwordSet: true },
    hotkeys: {
      mark: { type: 'keyboard', vk: 0x77, modifiers: { ctrl: false, shift: false, alt: false }, accelerator: 'F8', label: 'F8' },
      issue: { type: 'keyboard', vk: 0x78, modifiers: { ctrl: false, shift: false, alt: false }, accelerator: 'F9', label: 'F9' },
      labels: { mark: 'mark', issue: 'issue' },
      mode: 'global-shortcut',
    },
    telemetry: { enabled: false, url: 'http://127.0.0.1:46333/playtest/time', pollIntervalMs: 500 },
    pipeline: { autoRun: false, command: 'playtest-pipeline', model: 'small', preSeconds: 20, postSeconds: 10, mergeGapSeconds: 1 },
    youtube: { command: 'playtest-youtube', privacy: 'unlisted' },
    sessionsDir: 'C:\\Users\\George\\Videos\\PlaytestSessions',
    helperPath: '',
    setupDone: true,
  };
  const send = (event) => win.webContents.send('recorder:event', event);

  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:set', () => config);
  ipcMain.handle('session:status', () => ({ state: 'idle', obsConnected: false }));
  ipcMain.handle('sessions:list', () => SESSIONS);
  ipcMain.handle('rig:advisories', () => []);
  ipcMain.handle('obs:preflight', () => []);
  ipcMain.handle('youtube:status', async () => statusAnswer);
  ipcMain.handle('youtube:kit', () => KIT);
  ipcMain.handle('youtube:sign-in', async () => {
    await sleep(300);
    statusAnswer = { ...statusAnswer, token: { ...statusAnswer.token, exists: true, scopesOk: true }, ready: true };
    return { ok: true };
  });
  ipcMain.handle('youtube:sign-out', () => ({ ok: true }));
  ipcMain.handle('shell:open-external', () => ({ ok: true }));
  // A scripted upload: the same push events main broadcasts for a real one.
  ipcMain.handle('youtube:upload', async (_e, req) => {
    const total = KIT.videoBytes;
    send({ type: 'youtube-started', sessionDir: req.sessionDir, command: 'playtest-youtube upload …' });
    setTimeout(() => send({ type: 'youtube-auth-done', sessionDir: req.sessionDir, how: 'cached' }), 200);
    let sent = 0;
    const chunk = 8 * 1024 * 1024;
    const timer = setInterval(() => {
      sent = Math.min(total, sent + chunk * 3);
      send({ type: 'youtube-progress', sessionDir: req.sessionDir, sent, total });
      if (sent >= total) {
        clearInterval(timer);
        setTimeout(() => send({
          type: 'youtube-done', sessionDir: req.sessionDir, ok: true,
          url: 'https://youtu.be/FAKEvideoId1',
          studioUrl: 'https://studio.youtube.com/video/FAKEvideoId1/edit',
          privacyStatus: 'private', requestedPrivacy: req.privacy,
        }), 400);
      }
    }, 120);
    return { ok: true };
  });
}

async function shot(win, name) {
  // An offscreen (show:false) window composites lazily: capturePage right
  // after a DOM change hands back the PREVIOUS frame. Let it paint first.
  await sleep(700);
  const image = await win.webContents.capturePage();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.png`), image.toPNG());
}

/** Click a button by its visible text — a DOM click, never OS-level input. */
const clickByText = (selector, text) => `
  (() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return 'not found';
    if (el.disabled) return 'disabled';
    el.click();
    return 'clicked';
  })()`;

async function runUiPhase() {
  const win = new BrowserWindow({
    width: 1100,
    height: 1000,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    const { level, message } = event;
    if (String(level) === 'error' || Number(level) >= 3) errors.push(message);
  });
  stubIpc(win);
  await win.loadFile(RENDERER);
  await sleep(1200);

  record(errors.length === 0, 'renderer: loaded with no console errors', errors.join(' | ').slice(0, 200));
  await shot(win, '01-sessions-card');

  const rowButtons = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.session-row')].map((row) => ({
      title: row.querySelector('.title').textContent.trim(),
      buttons: [...row.querySelectorAll('.actions button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })),
    }))`);
  const golden = rowButtons[0];
  const publishBtn = golden.buttons.find((b) => b.text === 'Publish');
  record(Boolean(publishBtn), 'sessions: the row with a condensed cut has a Publish button');
  record(publishBtn?.disabled === false, 'sessions: it is enabled when report/condensed.mp4 exists');
  const noCut = rowButtons[1].buttons.find((b) => b.text === 'Publish');
  record(noCut?.disabled === true, 'sessions: it is disabled for a session with no condensed cut');
  const already = rowButtons[2].buttons.find((b) => b.text === 'Published');
  record(Boolean(already), 'sessions: an already-uploaded session says "Published"');
  record(golden.title.includes('on YouTube') === false && rowButtons[2].title.includes('on YouTube'), 'sessions: the uploaded session carries the "on YouTube" badge');

  // Open the dialog.
  const opened = await win.webContents.executeJavaScript(clickByText('.session-row .actions button', 'Publish'));
  record(opened === 'clicked', 'dialog: the Publish button opens it', String(opened));
  await sleep(700);
  const dialog = await win.webContents.executeJavaScript(`
    (() => {
      const d = document.getElementById('publish-dialog');
      return {
        open: d.open,
        title: document.getElementById('publish-title').value,
        chapters: document.getElementById('publish-counts').textContent,
        account: document.getElementById('publish-account-text').textContent,
        audit: !document.getElementById('publish-audit').classList.contains('hidden'),
        uploadLabel: document.getElementById('publish-start').textContent,
      };
    })()`);
  record(dialog.open === true, 'dialog: it is modal and open');
  record(dialog.title === KIT.title, 'dialog: the title field is pre-filled from the kit');
  record(/8 chapters/.test(dialog.chapters), 'dialog: it counts the chapters in the description', dialog.chapters);
  record(/Signed in/.test(dialog.account), 'dialog: the account line reflects the cached token', dialog.account);
  record(dialog.audit === true, 'dialog: the pending-audit warning is shown');
  await shot(win, '02-publish-dialog');

  // Edit the description and confirm the counter follows.
  const edited = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.getElementById('publish-description');
      el.value = '0:00 Session start\\n0:30 MARK — edited';
      el.dispatchEvent(new Event('input'));
      return document.getElementById('publish-counts').textContent;
    })()`);
  record(/2 chapters \(under 3 — no chapter bar\)/.test(edited), 'dialog: editing the description updates the chapter count and warns under 3', edited);

  // Put it back, then upload.
  await win.webContents.executeJavaScript(`
    (() => {
      const el = document.getElementById('publish-description');
      el.value = ${JSON.stringify(KIT.description)};
      el.dispatchEvent(new Event('input'));
    })()`);
  const started = await win.webContents.executeJavaScript(clickByText('#publish-dialog button', 'Upload'));
  record(started === 'clicked', 'upload: the Upload button starts it', String(started));
  await sleep(900);
  const uploading = await win.webContents.executeJavaScript(`
    (() => ({
      progressShown: !document.getElementById('publish-progress').classList.contains('hidden'),
      text: document.getElementById('publish-progress-text').textContent,
      width: document.getElementById('publish-progress-fill').style.width,
      cancelShown: !document.getElementById('publish-cancel').classList.contains('hidden'),
      titleDisabled: document.getElementById('publish-title').disabled,
    }))()`);
  record(uploading.progressShown && /Uploading/.test(uploading.text), 'upload: the progress bar shows a percentage', uploading.text);
  record(uploading.cancelShown === true, 'upload: Cancel replaces Upload while it runs');
  record(uploading.titleDisabled === true, 'upload: the fields lock while it runs');
  await shot(win, '03-uploading');

  // Wait for the scripted upload to finish.
  for (let i = 0; i < 60; i++) {
    const done = await win.webContents.executeJavaScript(
      `!document.getElementById('publish-result').classList.contains('hidden')`,
    );
    if (done) break;
    await sleep(250);
  }
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const el = document.getElementById('publish-result');
      return {
        shown: !el.classList.contains('hidden'),
        text: el.textContent,
        link: el.querySelector('[data-external]')?.dataset.external ?? '',
        uploadShown: !document.getElementById('publish-start').classList.contains('hidden'),
      };
    })()`);
  record(result.shown === true, 'done: the result notice replaces the progress bar');
  record(result.link === 'https://youtu.be/FAKEvideoId1', 'done: it links the uploaded video', result.link);
  record(/visibility to private/i.test(result.text), 'done: it explains the audit-locked visibility', result.text.slice(0, 140));
  record(/url\.txt/.test(result.text), 'done: it points at url.txt for the Notion publish');
  const afterLabel = await win.webContents.executeJavaScript(`document.getElementById('publish-start').textContent`);
  record(afterLabel === 'Upload again', 'done: the button now offers a second (forced) upload', afterLabel);
  await shot(win, '04-uploaded');

  // The not-installed state: the dialog must say what to install, not just fail.
  await win.webContents.executeJavaScript(`document.getElementById('publish-close').click()`);
  statusAnswer = { ok: false, error: 'Could not run "playtest-youtube". Install the uploader with: pip install -e "pipeline[youtube]"' };
  await win.webContents.executeJavaScript(clickByText('.session-row .actions button', 'Publish'));
  await sleep(700);
  const blocked = await win.webContents.executeJavaScript(`
    (() => ({
      account: document.getElementById('publish-account-text').textContent,
      uploadDisabled: document.getElementById('publish-start').disabled,
    }))()`);
  record(/pip install/.test(blocked.account), 'not installed: the dialog names the fix', blocked.account);
  record(blocked.uploadDisabled === true, 'not installed: Upload is disabled');
  await shot(win, '05-uploader-missing');

  record(errors.length === 0, 'renderer: still no console errors at the end', errors.join(' | ').slice(0, 200));
  lines.push('', `screenshots: ${OUT_DIR}`);
  finish('ui-harness-ui');
}

app.whenReady().then(() => {
  const run = phase === 'ui' ? runUiPhase : runCliPhase;
  run().catch((err) => {
    record(false, `${phase} phase threw`, String(err && err.stack ? err.stack : err));
    finish(`ui-harness-${phase}`);
  });
});
