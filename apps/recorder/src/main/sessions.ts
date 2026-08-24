/**
 * Session browser backend: enumerate past sessions under `sessionsDir` by
 * reading each directory's sidecar (`session.json`; the journal when the
 * sidecar is missing after a crash). Read-only — the pipeline and the
 * recorder are the only writers.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  JOURNAL_FILENAME,
  SIDECAR_FILENAME,
  sidecarFromJournal,
  type JournalLine,
  type SessionSidecar,
} from '@playtest/shared';
import type { SessionListEntry } from '../common/ipc-contract.js';

export const REPORT_RELATIVE_PATH = join('report', 'report.html');

function readSidecar(sessionDir: string): SessionSidecar | null {
  const sidecarPath = join(sessionDir, SIDECAR_FILENAME);
  try {
    return JSON.parse(readFileSync(sidecarPath, 'utf8')) as SessionSidecar;
  } catch {
    // fall through to the journal
  }
  try {
    const lines = readFileSync(join(sessionDir, JOURNAL_FILENAME), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as JournalLine);
    return sidecarFromJournal(lines);
  } catch {
    return null;
  }
}

function durationOf(sidecar: SessionSidecar): number | null {
  const started = sidecar.events.find((e) => e.type === 'record-started');
  const stopped = sidecar.events.find((e) => e.type === 'record-stopped');
  if (started && stopped) return Math.max(0, Math.round(stopped.monoMs - started.monoMs));
  const { startedAtWall, endedAtWall } = sidecar.session;
  if (startedAtWall && endedAtWall) {
    const ms = Date.parse(endedAtWall) - Date.parse(startedAtWall);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  return null;
}

export function entryFor(sessionDir: string): SessionListEntry | null {
  const sidecar = readSidecar(sessionDir);
  if (!sidecar?.session?.id) return null;
  const { session } = sidecar;
  return {
    id: session.id,
    title: session.title,
    sessionDir,
    startedAtWall: session.startedAtWall,
    endedAtWall: session.endedAtWall,
    durationMs: durationOf(sidecar),
    markCount: sidecar.marks.length,
    recordingFile: session.recordingFile,
    recordingExists: Boolean(session.recordingFile && existsSync(session.recordingFile)),
    hasReport: existsSync(join(sessionDir, REPORT_RELATIVE_PATH)),
    unfinished: !session.endedAtWall,
  };
}

/** Newest first. Directories without a readable sidecar/journal are skipped. */
export function listSessions(sessionsDir: string): SessionListEntry[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const entries: SessionListEntry[] = [];
  for (const name of names) {
    const dir = join(sessionsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const entry = entryFor(dir);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => (b.startedAtWall ?? '').localeCompare(a.startedAtWall ?? ''));
  return entries;
}
