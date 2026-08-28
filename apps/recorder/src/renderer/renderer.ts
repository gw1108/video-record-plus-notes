/** Renderer for the setup/review window. Talks to main via window.playtest. */
import type {
  HotkeyBinding,
  KeyModifiers,
  PlaytestApi,
  PreflightCheck,
  RecorderConfig,
  SessionListEntry,
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
const statusDot = $<HTMLSpanElement>('status-dot');
const statusText = $<HTMLSpanElement>('status-text');
const progressFill = $<HTMLDivElement>('progress-fill');
const obsInfo = $<HTMLDivElement>('obs-info');
const preflightEl = $<HTMLDivElement>('preflight');
const logEl = $<HTMLPreElement>('log');
const logSearchEl = $<HTMLInputElement>('log-search');
const logMatchesEl = $<HTMLSpanElement>('log-matches');
const startBtn = $<HTMLButtonElement>('start-session');
const preflightBtn = $<HTMLButtonElement>('run-preflight');
const applyBtn = $<HTMLButtonElement>('apply-recommended');
const sessionsEl = $<HTMLDivElement>('sessions');
const advisoriesEl = $<HTMLDivElement>('advisories');

let config: RecorderConfig;

/**
 * STT model guidance shown with the pipeline command (PLAN M4). Measured on
 * the dev rig (RTX 2060 6 GB) — see pipeline/README.md "Model choice".
 */
const MODEL_TIP = 'Tip: --model medium for better accuracy (~2x slower on a GPU); --model small on CPU.';

// ---------------------------------------------------------------------------
// Binding capture: each mark action shows a keycap-style button. Clicking it
// arms capture — the next keyboard key (with Ctrl/Shift/Alt), mouse button, or
// controller/HID button (via the helper's capture mode) becomes the binding.
// Esc or losing window focus cancels.
// ---------------------------------------------------------------------------

type BindSlot = 'mark' | 'issue';

const NO_MODS: KeyModifiers = { ctrl: false, shift: false, alt: false };

function defaultBinding(slot: BindSlot): HotkeyBinding {
  const n = slot === 'mark' ? 8 : 9;
  return { type: 'keyboard', vk: 0x70 + n - 1, modifiers: { ...NO_MODS }, accelerator: `F${n}`, label: `F${n}` };
}

const bindings: Record<BindSlot, HotkeyBinding> = { mark: defaultBinding('mark'), issue: defaultBinding('issue') };
let capturing: BindSlot | null = null;
/** Swallow the mouseup/click that trails a mouse-button capture. */
let suppressMouseUntil = 0;

function bindButton(slot: BindSlot): HTMLButtonElement {
  return $<HTMLButtonElement>(`bind-${slot}`);
}

function renderBindButtons(previewMods?: KeyModifiers): void {
  for (const slot of ['mark', 'issue'] as const) {
    const btn = bindButton(slot);
    btn.classList.toggle('listening', capturing === slot);
    if (capturing === slot) {
      const held = previewMods ? modifierPrefix(previewMods) : '';
      btn.textContent = held ? `${held}…` : 'press input…';
    } else {
      btn.textContent = bindings[slot].label;
    }
  }
}

function modsFrom(e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): KeyModifiers {
  return { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
}

function modifierPrefix(m: KeyModifiers): string {
  return [m.ctrl && 'Ctrl+', m.shift && 'Shift+', m.alt && 'Alt+'].filter(Boolean).join('');
}

/**
 * Electron accelerator name for a physical key, or null for keys
 * globalShortcut can't register (those still work via the Raw Input helper,
 * which matches on the virtual-key code instead).
 */
function acceleratorKeyName(e: KeyboardEvent): string | null {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  if (/^Numpad\d$/.test(code)) return `num${code.slice(6)}`;
  const named: Record<string, string> = {
    Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Enter: 'Enter', NumpadEnter: 'Enter', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv', NumpadDecimal: 'numdec', PrintScreen: 'PrintScreen',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  return named[code] ?? null;
}

function displayKeyName(e: KeyboardEvent): string {
  const accel = acceleratorKeyName(e);
  if (accel) return accel;
  if (e.key.length === 1 && e.key !== ' ') return e.key.toUpperCase();
  return e.key || e.code;
}

const MOUSE_BUTTONS: Record<number, { button: 'left' | 'right' | 'middle' | 'x1' | 'x2'; name: string }> = {
  0: { button: 'left', name: 'Left Click' },
  1: { button: 'middle', name: 'Middle Click' },
  2: { button: 'right', name: 'Right Click' },
  3: { button: 'x1', name: 'Mouse 4' },
  4: { button: 'x2', name: 'Mouse 5' },
};

function startCapture(slot: BindSlot): void {
  if (capturing === slot) return;
  capturing = slot;
  renderBindButtons();
  // Ask the helper (via main) to watch controllers too. Optional: keyboard and
  // mouse capture keep working when the helper binary isn't built.
  void api.gamepadCaptureStart().then((r) => {
    if (!r.ok && r.error) log('info', r.error);
  });
}

function stopCapture(): void {
  capturing = null;
  void api.gamepadCaptureStop();
  renderBindButtons();
}

function finishCapture(binding: HotkeyBinding): void {
  const slot = capturing;
  if (!slot) return;
  bindings[slot] = binding;
  stopCapture();
  log('info', `${slot === 'mark' ? 'Mark' : 'Issue'} key bound to ${binding.label}. Save settings to keep it.`);
  if (bindings.mark.label === bindings.issue.label) {
    log('warn', 'Mark and Issue are bound to the same input — every press will record both. Rebind one of them.');
  }
  if (binding.type === 'mouse' && (binding.button === 'left' || binding.button === 'right') && !modifierPrefix(binding.modifiers)) {
    log('warn', `${binding.label} fires on EVERY ${binding.button} click during the session — expect a lot of marks.`);
  }
  if (binding.type === 'keyboard' && !binding.accelerator) {
    log('info', `${binding.label} has no global-shortcut name; it will be captured via the Raw Input helper.`);
  }
}

function onCaptureKeydown(e: KeyboardEvent): void {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  if (e.key === 'Escape') {
    stopCapture();
    return;
  }
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
    renderBindButtons(modsFrom(e)); // preview the chord being held
    return;
  }
  const modifiers = modsFrom(e);
  const keyName = acceleratorKeyName(e);
  const label = `${modifierPrefix(modifiers)}${displayKeyName(e)}`;
  finishCapture({
    type: 'keyboard',
    vk: e.keyCode,
    modifiers,
    accelerator: keyName ? `${modifierPrefix(modifiers)}${keyName}` : null,
    label,
  });
}

function onCaptureMousedown(e: MouseEvent): void {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  const mapped = MOUSE_BUTTONS[e.button];
  if (!mapped) return;
  suppressMouseUntil = performance.now() + 400;
  const modifiers = modsFrom(e);
  finishCapture({
    type: 'mouse',
    button: mapped.button,
    modifiers,
    label: `${modifierPrefix(modifiers)}${mapped.name}`,
  });
}

function onCaptureSuppress(e: Event): void {
  if (capturing || performance.now() < suppressMouseUntil) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function initBindingCapture(): void {
  // Capture-phase listeners so an armed capture wins over every other control.
  window.addEventListener('keydown', onCaptureKeydown, true);
  window.addEventListener('mousedown', onCaptureMousedown, true);
  for (const type of ['mouseup', 'click', 'auxclick', 'contextmenu'] as const) {
    window.addEventListener(type, onCaptureSuppress, true);
  }
  window.addEventListener('blur', () => {
    if (capturing) stopCapture();
  });
  for (const slot of ['mark', 'issue'] as const) {
    bindButton(slot).addEventListener('click', () => startCapture(slot));
    $<HTMLButtonElement>(`bind-${slot}-reset`).addEventListener('click', () => {
      if (capturing === slot) stopCapture();
      bindings[slot] = defaultBinding(slot);
      renderBindButtons();
    });
  }
}

function formatTimecode(ms: number): string {
  const t = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

// ---------------------------------------------------------------------------
// Log pane. Every line is kept as an entry so the search box can re-render it:
// non-matching lines are hidden, matching text gets wrapped in <mark>, and
// prev/next walks the matching lines. Streaming output only auto-scrolls while
// the view is parked at the bottom, so reading history isn't yanked away.
// ---------------------------------------------------------------------------

type LogLevel = 'info' | 'warn' | 'error' | 'pipeline';

interface LogEntry {
  text: string;
  el: HTMLSpanElement;
}

const logEntries: LogEntry[] = [];
let logQuery = '';
let logMatches: HTMLSpanElement[] = [];
let logMatchIndex = -1;
let logPinned = true;

/** Repaints one line for the current query; returns whether it matches. */
function paintLogLine(entry: LogEntry): boolean {
  const { el, text } = entry;
  el.classList.remove('current');
  el.textContent = '';
  if (!logQuery) {
    el.textContent = text;
    el.hidden = false;
    return false;
  }
  const needle = logQuery.toLowerCase();
  const hay = text.toLowerCase();
  let at = hay.indexOf(needle);
  if (at === -1) {
    el.textContent = text;
    el.hidden = true;
    return false;
  }
  // Build the highlight with DOM nodes, never innerHTML — log lines carry
  // arbitrary pipeline/OBS output.
  let from = 0;
  while (at !== -1) {
    if (at > from) el.appendChild(document.createTextNode(text.slice(from, at)));
    const hit = document.createElement('mark');
    hit.textContent = text.slice(at, at + needle.length);
    el.appendChild(hit);
    from = at + needle.length;
    at = hay.indexOf(needle, from);
  }
  if (from < text.length) el.appendChild(document.createTextNode(text.slice(from)));
  el.hidden = false;
  return true;
}

/** Re-applies the query to every line, keeping the current match if it survives. */
function refreshLogMatches(): void {
  const previous = logMatchIndex >= 0 ? logMatches[logMatchIndex] ?? null : null;
  logMatches = logEntries.filter((entry) => paintLogLine(entry)).map((entry) => entry.el);
  logMatchIndex = previous ? logMatches.indexOf(previous) : -1;
  logMatches[logMatchIndex]?.classList.add('current');
  renderLogCount();
}

function renderLogCount(): void {
  logMatchesEl.classList.toggle('none', logQuery !== '' && logMatches.length === 0);
  if (!logQuery) {
    logMatchesEl.textContent = logEntries.length > 0 ? `${logEntries.length} lines` : '';
    return;
  }
  if (logMatches.length === 0) {
    logMatchesEl.textContent = 'no matches';
    return;
  }
  const at = logMatchIndex >= 0 ? `${logMatchIndex + 1}/` : '';
  logMatchesEl.textContent = `${at}${logMatches.length} of ${logEntries.length}`;
}

/** Jumps to the next (delta 1) or previous (delta -1) matching line. */
function stepLogMatch(delta: number): void {
  if (logMatches.length === 0) return;
  logMatches[logMatchIndex]?.classList.remove('current');
  const n = logMatches.length;
  logMatchIndex = logMatchIndex < 0 ? (delta > 0 ? 0 : n - 1) : (logMatchIndex + delta + n) % n;
  const el = logMatches[logMatchIndex];
  if (!el) return;
  el.classList.add('current');
  el.scrollIntoView({ block: 'center' });
  renderLogCount();
}

function appendLog(level: LogLevel, text: string): void {
  const el = document.createElement('span');
  el.className = `line ${level}`;
  const entry: LogEntry = { text, el };
  logEntries.push(entry);
  logEl.appendChild(el);
  if (logQuery) {
    // A new match shifts the indices after it, so recount rather than guess.
    refreshLogMatches();
  } else {
    paintLogLine(entry);
    renderLogCount();
  }
  if (logPinned) logEl.scrollTop = logEl.scrollHeight;
}

function clearLog(): void {
  logEntries.length = 0;
  logMatches = [];
  logMatchIndex = -1;
  logEl.textContent = '';
  logPinned = true;
  renderLogCount();
}

function setLogQuery(query: string): void {
  logQuery = query;
  logMatchIndex = -1;
  logMatches = [];
  refreshLogMatches();
  if (logMatches.length > 0) stepLogMatch(1);
}

function initLogPane(): void {
  logEl.addEventListener('scroll', () => {
    // 24px of slack, so a part-scrolled last line still counts as "at bottom".
    logPinned = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  });
  logSearchEl.addEventListener('input', () => setLogQuery(logSearchEl.value));
  logSearchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepLogMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape' && logSearchEl.value !== '') {
      e.preventDefault();
      logSearchEl.value = '';
      setLogQuery('');
    }
  });
  $<HTMLButtonElement>('log-prev').addEventListener('click', () => stepLogMatch(-1));
  $<HTMLButtonElement>('log-next').addEventListener('click', () => stepLogMatch(1));
  $<HTMLButtonElement>('log-clear').addEventListener('click', clearLog);
  // Ctrl+F anywhere in the window focuses the log search. Binding capture runs
  // on capture-phase listeners that stop propagation while armed, so this can
  // never steal a key that is being bound to a mark.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      logSearchEl.focus();
      logSearchEl.select();
    }
  });
  renderLogCount();
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  appendLog(level, `[${new Date().toLocaleTimeString()}] ${message}\n`);
}

function fillConfigForm(): void {
  $<HTMLInputElement>('obs-host').value = config.obs.host;
  $<HTMLInputElement>('obs-port').value = String(config.obs.port);
  // The password never reaches the renderer (write-only across IPC); a blank
  // field on save means "keep the stored password".
  const password = $<HTMLInputElement>('obs-password');
  password.value = '';
  password.placeholder = config.obs.passwordSet ? '(saved — leave blank to keep)' : '';
  bindings.mark = config.hotkeys.mark;
  bindings.issue = config.hotkeys.issue;
  renderBindButtons();
  $<HTMLInputElement>('label-mark').value = config.hotkeys.labels.mark;
  $<HTMLInputElement>('label-issue').value = config.hotkeys.labels.issue;
  $<HTMLSelectElement>('hotkey-mode').value = config.hotkeys.mode;
  $<HTMLInputElement>('telemetry-enabled').checked = config.telemetry.enabled;
  $<HTMLInputElement>('telemetry-url').value = config.telemetry.url;
  $<HTMLInputElement>('sessions-dir').value = config.sessionsDir;
  const pipeline = config.pipeline;
  $<HTMLInputElement>('pipeline-autorun').checked = pipeline.autoRun;
  $<HTMLInputElement>('pipeline-command').value = pipeline.command;
  const model = $<HTMLSelectElement>('pipeline-model');
  if (![...model.options].some((o) => o.value === pipeline.model)) {
    model.add(new Option(pipeline.model, pipeline.model)); // custom size from config.json
  }
  model.value = pipeline.model;
  $<HTMLInputElement>('pipeline-pre').value = String(pipeline.preSeconds);
  $<HTMLInputElement>('pipeline-post').value = String(pipeline.postSeconds);
  $<HTMLInputElement>('pipeline-merge').value = String(pipeline.mergeGapSeconds);
}

function numberField(id: string, fallback: number): number {
  const n = Number($<HTMLInputElement>(id).value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
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
      mark: bindings.mark,
      issue: bindings.issue,
      labels: {
        mark: $<HTMLInputElement>('label-mark').value.trim() || 'mark',
        issue: $<HTMLInputElement>('label-issue').value.trim() || 'issue',
      },
      mode: $<HTMLSelectElement>('hotkey-mode').value as RecorderConfig['hotkeys']['mode'],
    },
    telemetry: {
      ...config.telemetry,
      enabled: $<HTMLInputElement>('telemetry-enabled').checked,
      url: $<HTMLInputElement>('telemetry-url').value.trim(),
    },
    pipeline: {
      autoRun: $<HTMLInputElement>('pipeline-autorun').checked,
      command: $<HTMLInputElement>('pipeline-command').value.trim() || 'playtest-pipeline',
      model: $<HTMLSelectElement>('pipeline-model').value || 'small',
      preSeconds: numberField('pipeline-pre', config.pipeline.preSeconds),
      postSeconds: numberField('pipeline-post', config.pipeline.postSeconds),
      mergeGapSeconds: numberField('pipeline-merge', config.pipeline.mergeGapSeconds),
    },
    sessionsDir: $<HTMLInputElement>('sessions-dir').value.trim(),
  };
}

function renderChecks(container: HTMLElement, checks: PreflightCheck[]): void {
  container.replaceChildren();
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
    container.appendChild(row);
  }
}

/** Last preflight result — the wizard reads it to decide what to say. */
let lastPreflight: PreflightCheck[] = [];

function renderPreflight(checks: PreflightCheck[]): void {
  lastPreflight = checks;
  renderChecks(preflightEl, checks);
  applyBtn.disabled = !checks.some((c) => c.fixable && c.status !== 'pass');
}

async function checkRig(): Promise<PreflightCheck[]> {
  const checks = await api.rigAdvisories();
  renderChecks(advisoriesEl, checks);
  if (checks.length === 0) {
    advisoriesEl.textContent = 'No advisories on this platform.';
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Session browser: past sessions from sessionsDir, with open / run actions.
// Pipeline output streams into the log pane; one pipeline runs at a time.
// ---------------------------------------------------------------------------

let runningPipelineDir: string | null = null;
let sessionsCache: SessionListEntry[] = [];

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function badge(text: string, kind: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `badge ${kind}`;
  el.textContent = text;
  return el;
}

function renderSessions(entries: SessionListEntry[]): void {
  sessionsCache = entries;
  sessionsEl.replaceChildren();
  $<HTMLSpanElement>('sessions-summary').textContent = entries.length
    ? `${entries.length} session${entries.length === 1 ? '' : 's'} in ${config.sessionsDir}`
    : '';
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = `No sessions yet in ${config.sessionsDir}.`;
    sessionsEl.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const running = runningPipelineDir === entry.sessionDir;
    const row = document.createElement('div');
    row.className = `session-row${running ? ' running' : ''}`;

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = entry.title;
    title.title = entry.sessionDir;
    if (running) title.appendChild(badge('pipeline running', 'running'));
    else if (entry.hasReport) title.appendChild(badge('report', 'report'));
    if (entry.unfinished) title.appendChild(badge('unfinished', 'unfinished'));
    if (entry.recordingFile && !entry.recordingExists) title.appendChild(badge('recording missing', 'missing'));

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      `${shortDate(entry.startedAtWall)} · ` +
      `${entry.durationMs !== null ? formatTimecode(entry.durationMs) : '—'} · ` +
      `${entry.markCount} mark${entry.markCount === 1 ? '' : 's'}`;

    const actions = document.createElement('div');
    actions.className = 'actions';
    const openReport = document.createElement('button');
    openReport.type = 'button';
    openReport.textContent = 'Open report';
    openReport.disabled = !entry.hasReport || running;
    openReport.addEventListener('click', () => void openSessionReport(entry));
    const openFolder = document.createElement('button');
    openFolder.type = 'button';
    openFolder.textContent = 'Folder';
    openFolder.addEventListener('click', () => void api.openSessionFolder(entry.sessionDir).then(reportIpcError));
    const run = document.createElement('button');
    run.type = 'button';
    if (running) {
      run.textContent = 'Cancel';
      run.addEventListener('click', () => void api.cancelPipeline());
    } else {
      run.textContent = entry.hasReport ? 'Re-run pipeline' : 'Run pipeline';
      run.disabled = runningPipelineDir !== null || !entry.recordingExists;
      run.title = entry.recordingExists ? '' : 'The OBS recording named in the sidecar is missing.';
      run.addEventListener('click', () => void runPipeline(entry));
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = 'Delete';
    del.disabled = running;
    del.title = running
      ? 'Cancel the running pipeline first.'
      : 'Move this session folder to the Recycle Bin (asks first).';
    del.addEventListener('click', () => void deleteSession(entry));
    actions.append(openReport, openFolder, run, del);
    row.append(title, meta, actions);
    sessionsEl.appendChild(row);
  }
}

function reportIpcError(result: { ok: boolean; error?: string }): void {
  if (!result.ok) log('error', result.error ?? 'unknown error');
}

async function openSessionReport(entry: SessionListEntry): Promise<void> {
  reportIpcError(await api.openSessionReport(entry.sessionDir));
}

/** Main shows the confirm dialog; the folder goes to the Recycle Bin, not away. */
async function deleteSession(entry: SessionListEntry): Promise<void> {
  const result = await api.deleteSession(entry.sessionDir);
  if (result.error) log(result.deleted ? 'warn' : 'error', `Delete: ${result.error}`);
  if (!result.deleted) return; // dialog dismissed, or the error above
  log(
    'info',
    `Moved "${entry.title}" to the Recycle Bin${result.recordingDeleted ? ' (with its recording)' : ''}.`,
  );
  await loadSessions();
}

async function runPipeline(entry: SessionListEntry): Promise<void> {
  config = await api.setConfig(readConfigForm()); // the run uses the settings as shown
  const result = await api.runPipeline(entry.sessionDir);
  if (!result.ok) log('error', `Pipeline: ${result.error ?? 'unknown error'}`);
}

async function loadSessions(): Promise<void> {
  try {
    renderSessions(await api.listSessions());
  } catch (err) {
    log('error', `Could not list sessions: ${String(err)}`);
  }
}

function logPipeline(line: string): void {
  appendLog('pipeline', `  ${line}\n`);
}

// ---------------------------------------------------------------------------
// First-run wizard (tech-stack risk 8): sequencing + copy over the checks the
// rest of this window already performs. Nothing here touches OBS beyond what
// the OBS-connection card can do; several steps are deliberately copy-only.
// ---------------------------------------------------------------------------

interface WizardStep {
  short: string;
  title: string;
  /** HTML body (static copy authored here, never user data). */
  body: string;
  action?: { label: string; run: () => Promise<string> };
}

const WIZARD_STEPS: WizardStep[] = [
  {
    short: 'OBS',
    title: 'OBS Studio installed?',
    body:
      '<p>The recorder drives a <strong>separately installed OBS Studio 30.2 or newer</strong> over its WebSocket API — it never bundles or links OBS.</p>' +
      '<p>If it is missing, install it from <strong>obsproject.com</strong>, run it once, then come back and press <em>Detect</em>.</p>',
    action: {
      label: 'Detect OBS',
      run: async () => {
        const info = await api.obsDetectInstall();
        if (!info.installed) return 'OBS not found. Install OBS Studio 30.2+, run it once, then press Detect again.';
        return `OBS found${info.path ? ` at ${info.path}` : ''}${info.running ? ' (running)' : ' (not running — start it before the next step)'}.`;
      },
    },
  },
  {
    short: 'WebSocket',
    title: 'Enable the WebSocket server and connect',
    body:
      '<p><em>Auto-detect</em> reads the port and password from OBS\'s own plugin config. If the server is off and OBS is closed it is switched on for you; if OBS is running, flip it in <strong>OBS → Tools → WebSocket Server Settings → Enable</strong> and press the button again.</p>' +
      '<p>Then start OBS (if it is not running) — the step connects automatically once the server is reachable.</p>',
    action: {
      label: 'Auto-detect & connect',
      run: async () => {
        await autoDetectObs();
        const status = await api.getStatus();
        return status.obsConnected
          ? 'Connected to OBS.'
          : 'Not connected yet — see the log at the bottom for what to do, then retry.';
      },
    },
  },
  {
    short: 'Profile',
    title: 'Recording profile: Hybrid MP4 + mic on track 2',
    body:
      '<p>Preflight checks the OBS profile; <em>Apply</em> sets Advanced output, <strong>Hybrid MP4</strong> (chapters + crash recovery) and enables audio track 2.</p>' +
      '<ul>' +
      '<li>Route your <strong>mic to track 2 only</strong> (game/desktop audio on track 1): OBS → Audio Mixer ⚙ → Advanced Audio Properties.</li>' +
      '<li>Pick a <strong>dedicated recording encoder</strong> (NVENC/AMF/QSV) under Settings → Output → Recording — with "(use stream encoder)" OBS cannot pause the recording.</li>' +
      '<li>For a YouTube-ready 1080p recording, select <strong>H.264 High Profile</strong> and <strong>VBR</strong>: 8 Mbps at 24/25/30 fps or 12 Mbps at 48/50/60 fps. Use 2 B-frames and NV12 (4:2:0), and keep the recording frame rate equal to the source.</li>' +
      '<li><strong>Restart OBS</strong> after applying; profile changes made over WebSocket take effect on restart.</li>' +
      '</ul>',
    action: {
      label: 'Run preflight & apply',
      run: async () => {
        const status = await api.getStatus();
        if (!status.obsConnected) return 'Connect to OBS first (previous step).';
        renderPreflight(await api.obsApplyRecommended());
        const bad = lastPreflight.filter((c) => c.status !== 'pass');
        return bad.length === 0
          ? 'Profile looks good.'
          : `Applied what WebSocket can set. Still needs you: ${bad.map((c) => c.label).join('; ')}.`;
      },
    },
  },
  {
    short: 'Face cam',
    title: 'Want a face cam? (optional)',
    body:
      '<p>The app records whatever OBS records and never touches the webcam. For a picture-in-picture face cam, add a <strong>Video Capture Device</strong> source to your OBS scene and position it — OBS composites it into the single recording, and the condensed cut and Notion upload include it automatically.</p>',
  },
  {
    short: 'Rig',
    title: 'Playtest rig checklist',
    body:
      '<p>Read-only advisories from the performance research: Game DVR off, HAGS off, High Performance power plan. Also: record to an internal SSD that is not the game drive, cap the game\'s FPS at the monitor refresh, OBS process priority Above Normal.</p>',
    action: {
      label: 'Check rig',
      run: async () => {
        const checks = await checkRig();
        const warn = checks.filter((c) => c.status !== 'pass');
        return warn.length === 0 ? 'Rig looks good.' : `${warn.length} advisory item(s) — see the rig panel below.`;
      },
    },
  },
  {
    short: 'Go',
    title: 'You are set',
    body:
      '<ul>' +
      '<li>Pick a session title and press <strong>Start recording</strong>; the window closes and the recorder lives in the tray.</li>' +
      '<li>Press the mark key (default F8; F9 = issue) when something happens and say your note out loud — that speech becomes the note text.</li>' +
      '<li>Stop (or pause) from the tray icon. The pipeline command appears here afterwards; turn on <em>Run pipeline automatically</em> in settings to skip the terminal.</li>' +
      '<li>If OBS was ever force-killed, its <strong>"OBS Studio Crash Detected"</strong> dialog blocks the WebSocket server until you dismiss it.</li>' +
      '</ul>',
  },
];

let wizardIndex = 0;

function wizardVisible(): boolean {
  return !$('wizard-section').classList.contains('hidden');
}

function renderWizard(): void {
  const step = WIZARD_STEPS[wizardIndex]!;
  $<HTMLSpanElement>('wizard-step-label').textContent = `step ${wizardIndex + 1} of ${WIZARD_STEPS.length}`;
  const list = $<HTMLOListElement>('wizard-steps');
  list.replaceChildren();
  WIZARD_STEPS.forEach((s, i) => {
    const li = document.createElement('li');
    li.textContent = s.short;
    li.className = i === wizardIndex ? 'current' : i < wizardIndex ? 'done' : '';
    list.appendChild(li);
  });
  $('wizard-title').textContent = step.title;
  $('wizard-body').innerHTML = step.body;
  $('wizard-status').textContent = '';
  const action = $<HTMLButtonElement>('wizard-action');
  action.style.display = step.action ? '' : 'none';
  action.textContent = step.action?.label ?? '';
  action.disabled = false;
  $<HTMLButtonElement>('wizard-back').disabled = wizardIndex === 0;
  $<HTMLButtonElement>('wizard-next').textContent = wizardIndex === WIZARD_STEPS.length - 1 ? 'Finish' : 'Next';
}

function openWizard(index = 0): void {
  wizardIndex = index;
  $('wizard-section').classList.remove('hidden');
  renderWizard();
  $('wizard-section').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function closeWizard(): Promise<void> {
  $('wizard-section').classList.add('hidden');
  if (!config.setupDone) {
    config = await api.setConfig({ ...readConfigForm(), setupDone: true });
  }
}

function initWizard(): void {
  $<HTMLButtonElement>('open-wizard').addEventListener('click', () => openWizard(0));
  $<HTMLButtonElement>('wizard-skip').addEventListener('click', () => void closeWizard());
  $<HTMLButtonElement>('wizard-back').addEventListener('click', () => {
    if (wizardIndex > 0) {
      wizardIndex -= 1;
      renderWizard();
    }
  });
  $<HTMLButtonElement>('wizard-next').addEventListener('click', () => {
    if (wizardIndex < WIZARD_STEPS.length - 1) {
      wizardIndex += 1;
      renderWizard();
    } else {
      void closeWizard();
    }
  });
  $<HTMLButtonElement>('wizard-action').addEventListener('click', async () => {
    const step = WIZARD_STEPS[wizardIndex];
    if (!step?.action) return;
    const button = $<HTMLButtonElement>('wizard-action');
    const status = $('wizard-status');
    button.disabled = true;
    status.textContent = 'Working…';
    try {
      status.textContent = await step.action.run();
    } catch (err) {
      status.textContent = `Failed: ${String(err)}`;
    } finally {
      button.disabled = false;
    }
  });
}

/** Summary of the session that just finished, shown until a new one starts. */
let finishedSummary: SessionSummary | null = null;
/** Live-updates the elapsed time while a session runs with the window open. */
let statusPollTimer: number | null = null;

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
  renderProgress(status);
  if (status.state !== 'idle' && statusPollTimer === null) {
    statusPollTimer = window.setInterval(() => void api.getStatus().then(renderStatus), 1000);
  } else if (status.state === 'idle' && statusPollTimer !== null) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

function renderProgress(status: StatusSnapshot): void {
  const marks = status.markCount ?? 0;
  const live = `${formatTimecode(status.recordingMs ?? 0)} · ${marks} mark${marks === 1 ? '' : 's'}`;
  if (status.state === 'recording') {
    finishedSummary = null; // a new session supersedes the last one's result
    statusDot.className = 'status-dot recording';
    statusText.textContent = `Recording — ${live}`;
    progressFill.className = 'progress-fill indeterminate';
  } else if (status.state === 'paused') {
    statusDot.className = 'status-dot paused';
    statusText.textContent = `Paused — ${live}`;
    progressFill.className = 'progress-fill indeterminate paused';
  } else if (finishedSummary) {
    statusDot.className = 'status-dot done';
    statusText.textContent =
      `Session finalized — ${finishedSummary.markCount} marks · ` +
      `${formatTimecode(finishedSummary.durationMs)}. Recording is closed; run the pipeline command above to process it.`;
    progressFill.className = 'progress-fill done';
  } else {
    statusDot.className = `status-dot ${status.obsConnected ? 'ready' : 'idle'}`;
    statusText.textContent = status.obsConnected
      ? 'Ready — OBS connected, no session running'
      : 'Idle — not connected to OBS';
    progressFill.className = 'progress-fill';
  }
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
  $<HTMLSpanElement>('model-tip').textContent = MODEL_TIP;
}

async function connectObs(): Promise<void> {
  // Every failure must reach the log — a silent button is indistinguishable
  // from a broken one, so the IPC round-trip is guarded end to end.
  try {
    config = await api.setConfig(readConfigForm());
    obsInfo.textContent = 'Connecting…';
    log('info', `Connecting to ws://${config.obs.host}:${config.obs.port}…`);
    const result = await api.obsConnect();
    if (result.connected) {
      obsInfo.textContent = `OBS ${result.obsVersion} · obs-websocket ${result.obsWebSocketVersion}` +
        (result.recordDirectory ? ` · records to ${result.recordDirectory}` : '');
      log('info', 'Connected to OBS.');
      renderPreflight(await api.obsPreflight());
    } else {
      obsInfo.textContent = 'Not connected';
      log('error', `OBS connection failed: ${result.error ?? 'unknown error'}. Try Auto-detect from OBS, or enable Tools → WebSocket Server Settings in OBS.`);
    }
    renderStatus(await api.getStatus());
  } catch (err) {
    obsInfo.textContent = 'Not connected';
    log('error', `Connect failed unexpectedly: ${String(err)}`);
  }
}

/** Read OBS's own websocket config; enable its server when it is safe to. */
async function autoDetectObs(): Promise<void> {
  try {
    log('info', 'Reading OBS WebSocket settings…');
    const result = await api.obsAutoDetect();
    log(result.ok ? 'info' : 'warn', result.message);
    config = await api.getConfig();
    fillConfigForm();
    if (result.ok && result.serverEnabled && !result.enabledNow) await connectObs();
  } catch (err) {
    log('error', `Auto-detect failed: ${String(err)}`);
  }
}

async function init(): Promise<void> {
  initBindingCapture();
  initLogPane();
  initWizard();
  config = await api.getConfig();
  fillConfigForm();
  renderStatus(await api.getStatus());
  await loadSessions();
  if (!config.setupDone) openWizard(0);

  $<HTMLButtonElement>('refresh-sessions').addEventListener('click', () => void loadSessions());
  $<HTMLButtonElement>('check-rig').addEventListener('click', () => void checkRig());

  $<HTMLButtonElement>('obs-autodetect').addEventListener('click', () => void autoDetectObs());
  $<HTMLButtonElement>('obs-connect').addEventListener('click', () => void connectObs());
  preflightBtn.addEventListener('click', async () => renderPreflight(await api.obsPreflight()));
  applyBtn.addEventListener('click', async () => {
    renderPreflight(await api.obsApplyRecommended());
    log('info', 'Applied recommended profile settings. Restart OBS to be safe; settings apply to the next recording.');
  });

  $<HTMLButtonElement>('save-config').addEventListener('click', async () => {
    const before = config.sessionsDir;
    config = await api.setConfig(readConfigForm());
    fillConfigForm(); // refresh the password placeholder ("saved" state)
    log('info', 'Settings saved.');
    if (config.sessionsDir !== before) await loadSessions();
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
        finishedSummary = event.summary;
        renderSummary(event.summary);
        void api.getStatus().then(renderStatus);
        void loadSessions();
        break;
      case 'pipeline-started':
        runningPipelineDir = event.sessionDir;
        renderSessions(sessionsCache);
        break;
      case 'pipeline-output':
        logPipeline(event.line);
        break;
      case 'pipeline-done':
        runningPipelineDir = null;
        log(
          event.code === 0 ? 'info' : 'error',
          event.code === 0
            ? `Pipeline finished${event.reportPath ? `: ${event.reportPath}` : ''}`
            : `Pipeline exited with code ${event.code ?? 'unknown'}.`,
        );
        void loadSessions();
        break;
      case 'obs-connection':
        log(event.connected ? 'info' : 'warn', event.connected ? 'OBS connected.' : 'OBS connection lost.');
        void api.getStatus().then(renderStatus);
        break;
      case 'log':
        log(event.level, event.message);
        break;
      case 'capture-input':
        // A controller/HID press identified by the helper while armed.
        if (capturing) finishCapture(event.binding);
        break;
    }
  });
}

// A throw inside init() would leave every button unbound with no visible
// cause; surface it in the log instead of dying silently in the console.
void init().catch((err) => {
  log('error', `UI failed to initialise: ${String(err)}`);
});
