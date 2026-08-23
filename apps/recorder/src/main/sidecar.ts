/**
 * Session sidecar writer. Two artifacts per session:
 *  - session.journal.jsonl — append-only, written synchronously on every
 *    mutation. Survives crashes; the pipeline can rebuild from it.
 *  - session.json — the canonical sidecar, atomically rewritten (tmp+rename)
 *    on a short debounce.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  emptySidecar,
  JOURNAL_FILENAME,
  SIDECAR_FILENAME,
  type JournalLine,
  type Mark,
  type SessionEvent,
  type SessionInfo,
  type SessionSidecar,
  type TelemetrySample,
} from '@playtest/shared';

const FLUSH_DEBOUNCE_MS = 250;

export class SidecarWriter {
  private sidecar: SessionSidecar;
  private journalFd: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(readonly sessionDir: string, session: SessionInfo) {
    mkdirSync(sessionDir, { recursive: true });
    this.sidecar = emptySidecar(session);
    this.journalFd = openSync(join(sessionDir, JOURNAL_FILENAME), 'a');
    this.journal({ t: 'session', data: session });
    this.flushNow();
  }

  get data(): SessionSidecar {
    return this.sidecar;
  }

  private journal(line: JournalLine): void {
    if (this.closed) return;
    writeSync(this.journalFd, JSON.stringify(line) + '\n');
    // Marks are the product's core data; pay the fsync on every line.
    fsyncSync(this.journalFd);
  }

  addMark(mark: Mark): void {
    this.sidecar.marks.push(mark);
    this.journal({ t: 'mark', data: mark });
    this.scheduleFlush();
  }

  addEvent(event: SessionEvent): void {
    this.sidecar.events.push(event);
    this.journal({ t: 'event', data: event });
    this.scheduleFlush();
  }

  addTelemetry(sample: TelemetrySample): void {
    this.sidecar.telemetry.push(sample);
    this.journal({ t: 'telemetry', data: sample });
    this.scheduleFlush();
  }

  updateSession(patch: Partial<SessionInfo>): void {
    this.sidecar.session = { ...this.sidecar.session, ...patch };
    this.journal({ t: 'session', data: this.sidecar.session });
    this.scheduleFlush();
  }

  end(endedAtWall: string, recordingFile?: string): void {
    this.sidecar.session.endedAtWall = endedAtWall;
    if (recordingFile) this.sidecar.session.recordingFile = recordingFile;
    this.journal({ t: 'end', data: { endedAtWall, recordingFile } });
    this.close();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
  }

  flushNow(): void {
    const target = join(this.sessionDir, SIDECAR_FILENAME);
    const tmp = target + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.sidecar, null, 2), 'utf8');
    renameSync(tmp, target);
  }

  close(): void {
    if (this.closed) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushNow();
    this.closed = true;
    closeSync(this.journalFd);
  }
}
