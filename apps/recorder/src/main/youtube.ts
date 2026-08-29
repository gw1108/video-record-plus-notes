/**
 * YouTube upload backend for the Publish dialog (PLAN M2.4).
 *
 * Same rule as `PipelineRunner`: the app spawns `playtest-youtube` — the very
 * command the README documents — and never reimplements OAuth or the resumable
 * upload in Electron. `--json` makes the CLI emit one NDJSON object per line,
 * so the dialog gets a real progress bar and the final URL instead of scraped
 * prose. Anything the parser does not recognise is forwarded to the log pane.
 *
 * Reading and writing the kit text is plain file I/O, so it happens here
 * rather than through the CLI: the dialog shows `report/youtube/title.txt` and
 * `description.txt`, and saves edits back to those same files before the
 * upload — they stay the one source of truth for both the in-app and the
 * manual (copy-paste into YouTube Studio) route.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  YouTubeConfig,
  YouTubeKit,
  YouTubeStatus,
  YouTubeUploadRequest,
} from '../common/ipc-contract.js';

const KIT_DIR = join('report', 'youtube');
const TITLE_FILE = join(KIT_DIR, 'title.txt');
const DESCRIPTION_FILE = join(KIT_DIR, 'description.txt');
const URL_FILE = join(KIT_DIR, 'url.txt');
const CONDENSED_FILE = join('report', 'condensed.mp4');
/** A timestamp line: "0:00 Session start" / "1:02:03 …" — YouTube wants ≥ 3. */
const TIMECODE = /^(?:\d+:)?\d{1,2}:\d{2}\s+\S/;
/** Signing in waits on a human at a browser; everything else is quick. */
const STATUS_TIMEOUT_MS = 30_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function youtubeUrlOf(sessionDir: string): string | undefined {
  return read(join(sessionDir, URL_FILE))?.trim() || undefined;
}

export function hasCondensed(sessionDir: string): boolean {
  return existsSync(join(sessionDir, CONDENSED_FILE));
}

/** The kit as the dialog shows it. Missing kit files are not an error — the pipeline may predate them, and the CLI rebuilds the text from `report_data.json` at upload time. */
export function readKit(sessionDir: string): YouTubeKit {
  const video = join(sessionDir, CONDENSED_FILE);
  const hasVideo = existsSync(video);
  const title = read(join(sessionDir, TITLE_FILE))?.trim() ?? '';
  const description = read(join(sessionDir, DESCRIPTION_FILE))?.replace(/\n+$/, '') ?? '';
  let videoBytes = 0;
  try {
    if (hasVideo) videoBytes = statSync(video).size;
  } catch {
    videoBytes = 0;
  }
  return {
    ok: hasVideo,
    error: hasVideo ? undefined : 'No condensed.mp4 in this session — run the pipeline first.',
    title,
    description,
    chapters: description.split('\n').filter((line) => TIMECODE.test(line)).length,
    hasVideo,
    videoBytes,
    previousUrl: youtubeUrlOf(sessionDir) ?? null,
  };
}

/** Save edited kit text back to the files the manual Studio route also uses. */
export function writeKit(sessionDir: string, title: string, description: string): void {
  mkdirSync(join(sessionDir, KIT_DIR), { recursive: true });
  writeFileSync(join(sessionDir, TITLE_FILE), `${title.trim()}\n`, 'utf8');
  writeFileSync(join(sessionDir, DESCRIPTION_FILE), `${description.replace(/\n+$/, '')}\n`, 'utf8');
}

interface CliEvent {
  event: string;
  [key: string]: unknown;
}

export interface YouTubeRunEvents {
  started: (sessionDir: string, command: string) => void;
  authWaiting: (sessionDir: string) => void;
  authDone: (sessionDir: string, how: string) => void;
  progress: (sessionDir: string, sent: number, total: number) => void;
  line: (sessionDir: string, line: string) => void;
  done: (
    sessionDir: string,
    result: {
      ok: boolean;
      url?: string;
      studioUrl?: string;
      privacyStatus?: string;
      requestedPrivacy?: string;
      error?: string;
      hint?: string;
    },
  ) => void;
}

export class YouTubeUploader extends EventEmitter {
  private child: ChildProcess | null = null;
  private currentDir: string | null = null;

  get running(): string | null {
    return this.currentDir;
  }

  /**
   * `playtest-youtube status --json` — a short-lived probe the dialog runs on
   * open. A missing command is a normal answer here (the uploader is opt-in),
   * so it resolves with `ok: false` rather than rejecting.
   */
  async status(config: YouTubeConfig): Promise<YouTubeStatus> {
    const result = await this.runOnce(config, ['status', '--json'], STATUS_TIMEOUT_MS);
    if (!result.ok) return { ok: false, error: result.error };
    const status = result.events.find((e) => e.event === 'status');
    if (!status) return { ok: false, error: result.stderr || 'playtest-youtube status printed nothing.' };
    const { event: _event, ...fields } = status;
    return { ok: true, ...(fields as Omit<YouTubeStatus, 'ok'>) };
  }

  /** The loopback OAuth flow. Opens the consent screen in the default browser and resolves once the token is cached. */
  async signIn(config: YouTubeConfig, reauth = false): Promise<{ ok: boolean; error?: string; hint?: string }> {
    const args = ['auth', '--json'];
    if (reauth) args.push('--reauth');
    const result = await this.runOnce(config, args, SIGN_IN_TIMEOUT_MS);
    if (!result.ok) return { ok: false, error: result.error };
    const failure = result.events.find((e) => e.event === 'error');
    if (failure) return { ok: false, error: String(failure.message ?? 'sign-in failed'), hint: String(failure.hint ?? '') };
    if (!result.events.some((e) => e.event === 'auth')) {
      return { ok: false, error: result.stderr || 'Sign-in did not complete.' };
    }
    return { ok: true };
  }

  async signOut(config: YouTubeConfig): Promise<{ ok: boolean; error?: string }> {
    const result = await this.runOnce(config, ['logout', '--json'], STATUS_TIMEOUT_MS);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  /**
   * Save the dialog's kit text, then spawn the upload. Progress arrives as
   * events; one upload at a time, mirroring the pipeline runner.
   */
  upload(config: YouTubeConfig, req: YouTubeUploadRequest): string {
    if (this.child) throw new Error(`An upload is already running for ${this.currentDir}.`);
    writeKit(req.sessionDir, req.title, req.description);
    const args = ['upload', quote(req.sessionDir), '--json', '--privacy', req.privacy];
    if (req.force) args.push('--force');
    const command = `${config.command} ${args.join(' ')}`;
    const child = this.spawnCli(command);
    this.child = child;
    this.currentDir = req.sessionDir;
    this.emit('started', req.sessionDir, command);

    const dir = req.sessionDir;
    let done: Parameters<YouTubeRunEvents['done']>[1] | null = null;
    let failure: { error: string; hint?: string } | null = null;

    this.readEvents(child, (parsed, raw) => {
      if (!parsed) {
        if (raw.trim()) this.emit('line', dir, raw);
        return;
      }
      switch (parsed.event) {
        case 'auth-start':
          this.emit('authWaiting', dir);
          break;
        case 'auth':
          this.emit('authDone', dir, String(parsed.how ?? ''));
          break;
        case 'progress':
          this.emit('progress', dir, Number(parsed.sent ?? 0), Number(parsed.total ?? 0));
          break;
        case 'done':
          done = {
            ok: true,
            url: String(parsed.url ?? ''),
            studioUrl: String(parsed.studioUrl ?? ''),
            privacyStatus: String(parsed.privacyStatus ?? ''),
            requestedPrivacy: String(parsed.requestedPrivacy ?? ''),
          };
          break;
        case 'error':
          failure = { error: String(parsed.message ?? 'upload failed'), hint: String(parsed.hint ?? '') };
          break;
        default:
          break; // 'kit', 'upload-start', 'dry-run': the dialog already has these
      }
    });

    child.on('error', (err) => {
      failure = { error: err.message };
    });
    child.on('exit', (code) => {
      this.child = null;
      this.currentDir = null;
      if (done) this.emit('done', dir, done);
      else if (failure) this.emit('done', dir, { ok: false, ...failure });
      else this.emit('done', dir, { ok: false, error: `playtest-youtube exited with code ${code ?? 'unknown'}.` });
    });
    return command;
  }

  cancel(): void {
    if (!this.child) return;
    // shell:true means child.pid is the shell; kill the whole tree on Windows.
    if (process.platform === 'win32' && this.child.pid) {
      spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      this.child.kill();
    }
  }

  private spawnCli(command: string): ChildProcess {
    // Through the shell so "playtest-youtube" resolves the way it does in the
    // user's terminal (PATHEXT shim, or a "python -m …" command prefix).
    return spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
  }

  private readEvents(child: ChildProcess, onLine: (parsed: CliEvent | null, raw: string) => void): void {
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        onLine(parseEvent(line), line);
      });
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on('line', (line) => onLine(null, line));
    }
  }

  /** Run a short CLI command to completion and collect its NDJSON events. */
  private runOnce(
    config: YouTubeConfig,
    args: string[],
    timeoutMs: number,
  ): Promise<{ ok: boolean; error?: string; events: CliEvent[]; stderr: string }> {
    return new Promise((resolve) => {
      const command = `${config.command} ${args.join(' ')}`;
      const events: CliEvent[] = [];
      const stderr: string[] = [];
      let child: ChildProcess;
      try {
        child = this.spawnCli(command);
      } catch (err) {
        resolve({ ok: false, error: `Could not run "${command}": ${String(err)}`, events, stderr: '' });
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, error: `"${command}" timed out.`, events, stderr: stderr.join('\n') });
      }, timeoutMs);
      this.readEvents(child, (parsed, raw) => {
        if (parsed) events.push(parsed);
        else if (raw.trim()) stderr.push(raw);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: notInstalledMessage(config.command, err), events, stderr: stderr.join('\n') });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        // A non-zero exit still carries usable events (status prints its
        // findings, auth prints the error), so only a total absence is fatal.
        if (events.length === 0 && code !== 0) {
          resolve({
            ok: false,
            error: stderr.join('\n') || notInstalledMessage(config.command),
            events,
            stderr: stderr.join('\n'),
          });
          return;
        }
        resolve({ ok: true, events, stderr: stderr.join('\n') });
      });
    });
  }
}

function notInstalledMessage(command: string, err?: Error): string {
  const detail = err ? ` (${err.message})` : '';
  return `Could not run "${command}"${detail}. Install the uploader with: pip install -e "pipeline[youtube]"`;
}

function parseEvent(line: string): CliEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed) as CliEvent;
    return typeof value?.event === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Quote a path for the shell we spawn through (cmd.exe on Windows). */
function quote(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}
