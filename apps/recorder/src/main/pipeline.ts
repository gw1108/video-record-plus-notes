/**
 * Runs the post-session pipeline as a child process and streams its output.
 * The pipeline stays a separate Python CLI (`playtest-pipeline`): the app
 * only spawns the same command line it prints for manual use, so "run it
 * from the app" and "paste it in a terminal" can never drift apart.
 *
 * Only ever runs while the recorder is idle — STT/VAD/FFmpeg are exactly the
 * heavy work that must not overlap a live session (perf report §1). The
 * controller guards that; this class just enforces one run at a time.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PipelineConfig } from '../common/ipc-contract.js';
import { buildPipelineCommand } from './recording.js';
import { REPORT_RELATIVE_PATH } from './sessions.js';

export interface PipelineRunEvents {
  started: (sessionDir: string, command: string) => void;
  line: (sessionDir: string, line: string) => void;
  done: (sessionDir: string, code: number | null, reportPath?: string) => void;
}

export class PipelineRunner extends EventEmitter {
  private child: ChildProcess | null = null;
  private currentDir: string | null = null;

  get running(): string | null {
    return this.currentDir;
  }

  run(config: PipelineConfig, sessionDir: string): string {
    if (this.child) throw new Error(`Pipeline already running for ${this.currentDir}.`);
    const command = buildPipelineCommand(config, sessionDir);
    // Through the shell so "playtest-pipeline" resolves like it does in the
    // user's terminal (PATHEXT .exe shim, or "python -m …" prefixes).
    const child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    this.child = child;
    this.currentDir = sessionDir;
    this.emit('started', sessionDir, command);
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream }).on('line', (line) => {
        if (line.trim()) this.emit('line', sessionDir, line);
      });
    }
    child.on('error', (err) => this.emit('line', sessionDir, `error: ${err.message}`));
    child.on('exit', (code) => {
      this.child = null;
      this.currentDir = null;
      const reportPath = join(sessionDir, REPORT_RELATIVE_PATH);
      this.emit('done', sessionDir, code, existsSync(reportPath) ? reportPath : undefined);
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
}
