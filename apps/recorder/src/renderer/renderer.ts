/** Renderer for the setup/review window. Talks to main via window.playtest. */
import type {
  PlaytestApi,
  PreflightCheck,
  RecorderConfig,
  SessionSummary,
  StatusSnapshot,
} from '../common/ipc-contract.js';

declare global {
  interface Window {
    playtest: PlaytestApi;
  }
}

const api = window.playtest;

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
}

const statusPill = $<HTMLSpanElement>('status-pill');
const obsInfo = $<HTMLDivElement>('obs-info');
const preflightEl = $<HTMLDivElement>('preflight');
const logEl = $<HTMLPreElement>('log');
const startBtn = $<HTMLButtonElement>('start-session');
const preflightBtn = $<HTMLButtonElement>('run-preflight');
const applyBtn = $<HTMLButtonElement>('apply-recommended');

let config: RecorderConfig;

function formatTimecode(ms: number): string {
  const t = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const line = document.createElement('span');
  line.className = level;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function fillConfigForm(): void {
  $<HTMLInputElement>('obs-host').value = config.obs.host;
  $<HTMLInputElement>('obs-port').value = String(config.obs.port);
  // The password never reaches the renderer (write-only across IPC); a blank
  // field on save means "keep the stored password".
  const password = $<HTMLInputElement>('obs-password');
  password.value = '';
  password.placeholder = config.obs.passwordSet ? '(saved — leave blank to keep)' : '';
  $<HTMLInputElement>('hotkey-mark').value = config.hotkeys.mark;
  $<HTMLInputElement>('hotkey-issue').value = config.hotkeys.issue;
  $<HTMLSelectElement>('hotkey-mode').value = config.hotkeys.mode;
  $<HTMLInputElement>('telemetry-enabled').checked = config.telemetry.enabled;
  $<HTMLInputElement>('telemetry-url').value = config.telemetry.url;
  $<HTMLInputElement>('sessions-dir').value = config.sessionsDir;
}

function readConfigForm(): RecorderConfig {
  return {
    ...config,
    obs: {
      host: $<HTMLInputElement>('obs-host').value.trim() || '127.0.0.1',
      port: Number($<HTMLInputElement>('obs-port').value) || 4455,
      password: $<HTMLInputElement>('obs-password').value,
    },
    hotkeys: {
      mark: $<HTMLInputElement>('hotkey-mark').value.trim() || 'F8',
      issue: $<HTMLInputElement>('hotkey-issue').value.trim() || 'F9',
      mode: $<HTMLSelectElement>('hotkey-mode').value as RecorderConfig['hotkeys']['mode'],
    },
    telemetry: {
      ...config.telemetry,
      enabled: $<HTMLInputElement>('telemetry-enabled').checked,
      url: $<HTMLInputElement>('telemetry-url').value.trim(),
    },
    sessionsDir: $<HTMLInputElement>('sessions-dir').value.trim(),
  };
}

function renderPreflight(checks: PreflightCheck[]): void {
  preflightEl.replaceChildren();
  const glyph = { pass: '●', warn: '▲', fail: '✕' } as const;
  for (const check of checks) {
    const row = document.createElement('div');
    row.className = `check-item ${check.status}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.textContent = glyph[check.status];
    const label = document.createElement('span');
    label.textContent = check.label;
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = `— ${check.detail}`;
    row.append(dot, label, detail);
    preflightEl.appendChild(row);
  }
  applyBtn.disabled = !checks.some((c) => c.fixable && c.status !== 'pass');
}

function renderStatus(status: StatusSnapshot): void {
  statusPill.className = `pill ${status.state === 'idle' ? (status.obsConnected ? 'connected' : 'idle') : status.state}`;
  statusPill.textContent =
    status.state === 'idle'
      ? status.obsConnected
        ? 'OBS connected'
        : 'idle'
      : `${status.state} ${formatTimecode(status.recordingMs ?? 0)} · ${status.markCount ?? 0} marks`;
  startBtn.disabled = !status.obsConnected || status.state !== 'idle';
  preflightBtn.disabled = !status.obsConnected;
}

function renderSummary(summary: SessionSummary): void {
  $('summary-section').classList.remove('hidden');
  $<HTMLDivElement>('summary-meta').innerHTML = '';
  const meta = $<HTMLDivElement>('summary-meta');
  const lines = [
    `${summary.title} — ${formatTimecode(summary.durationMs)} — ${summary.markCount} marks`,
    `Session folder: ${summary.sessionDir}`,
    summary.recordingFile ? `Recording: ${summary.recordingFile}` : 'Recording path unknown (check OBS output folder)',
  ];
  for (const text of lines) {
    const div = document.createElement('div');
    div.textContent = text;
    meta.appendChild(div);
  }
  const tbody = $<HTMLTableElement>('summary-marks').querySelector('tbody')!;
  tbody.replaceChildren();
  for (const mark of summary.marks) {
    const tr = document.createElement('tr');
    const cells = [
      String(mark.seq),
      mark.label,
      mark.videoMs !== null ? formatTimecode(mark.videoMs) : '—',
      mark.gameTimeMs != null ? formatTimecode(mark.gameTimeMs) : '—',
      mark.anchor?.method ?? '—',
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  $<HTMLElement>('pipeline-command').textContent = summary.pipelineCommand;
}

async function connectObs(): Promise<void> {
  config = await api.setConfig(readConfigForm());
  obsInfo.textContent = 'Connecting…';
  const result = await api.obsConnect();
  if (result.connected) {
    obsInfo.textContent = `OBS ${result.obsVersion} · obs-websocket ${result.obsWebSocketVersion}` +
      (result.recordDirectory ? ` · records to ${result.recordDirectory}` : '');
    log('info', 'Connected to OBS.');
    renderPreflight(await api.obsPreflight());
  } else {
    obsInfo.textContent = '';
    log('error', `OBS connection failed: ${result.error ?? 'unknown error'}. Enable Tools → WebSocket Server Settings in OBS.`);
  }
  renderStatus(await api.getStatus());
}

async function init(): Promise<void> {
  config = await api.getConfig();
  fillConfigForm();
  renderStatus(await api.getStatus());

  $<HTMLButtonElement>('obs-connect').addEventListener('click', () => void connectObs());
  preflightBtn.addEventListener('click', async () => renderPreflight(await api.obsPreflight()));
  applyBtn.addEventListener('click', async () => {
    renderPreflight(await api.obsApplyRecommended());
    log('info', 'Applied recommended profile settings. Restart OBS to be safe; settings apply to the next recording.');
  });

  $<HTMLButtonElement>('save-config').addEventListener('click', async () => {
    config = await api.setConfig(readConfigForm());
    fillConfigForm(); // refresh the password placeholder ("saved" state)
    log('info', 'Settings saved.');
  });

  startBtn.addEventListener('click', async () => {
    config = await api.setConfig(readConfigForm());
    const title = $<HTMLInputElement>('session-title').value.trim();
    const result = await api.startSession({
      title: title || 'playtest',
      targetKind: $<HTMLSelectElement>('target-kind').value as never,
      targetName: $<HTMLInputElement>('target-name').value.trim() || undefined,
    });
    if (!result.ok) log('error', `Could not start: ${result.error ?? 'unknown error'}`);
    // On success the window closes; nothing else to do here.
  });

  $<HTMLButtonElement>('copy-pipeline').addEventListener('click', () => {
    const cmd = $<HTMLElement>('pipeline-command').textContent ?? '';
    void navigator.clipboard.writeText(cmd);
    log('info', 'Pipeline command copied.');
  });

  api.onEvent((event) => {
    switch (event.type) {
      case 'status':
        renderStatus(event.status);
        break;
      case 'mark-added':
        log('info', `Mark #${event.mark.seq} (${event.mark.label}) at ${event.mark.videoMs !== null ? formatTimecode(event.mark.videoMs) : '?'}`);
        break;
      case 'session-stopped':
        renderSummary(event.summary);
        void api.getStatus().then(renderStatus);
        break;
      case 'obs-connection':
        log(event.connected ? 'info' : 'warn', event.connected ? 'OBS connected.' : 'OBS connection lost.');
        void api.getStatus().then(renderStatus);
        break;
      case 'log':
        log(event.level, event.message);
        break;
    }
  });
}

void init();
