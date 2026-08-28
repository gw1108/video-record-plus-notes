/**
 * Verifies the session-delete path (Delete button → `sessions:delete`):
 * the compiled `entryFor` guard plus Electron's `shell.trashItem`, against
 * REAL files in a throwaway sessions dir. Confirms the folder leaves disk,
 * lands in the Recycle Bin, and that the optional OBS-recording delete works
 * independently of the folder delete.
 *
 * Run (from the repo root):  npx electron verification/harnesses/session-delete.mjs
 * Exits 0 on pass, 1 on any failed assertion. electron.exe is a GUI-subsystem
 * binary on Windows, so its stdout never reaches the parent shell — the report
 * is written to verification/evidence/session-delete.txt instead. The confirm
 * dialog is not exercised here (it needs a human click); this covers
 * everything after it.
 */
import { app, shell } from 'electron';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entryFor } from '../../apps/recorder/dist/main/sessions.js';

const REPORT = join(import.meta.dirname, '..', 'evidence', 'session-delete.txt');
const lines = [];
let failures = 0;

function say(line) {
  lines.push(line);
  writeFileSync(REPORT, lines.join('\n') + '\n');
}

function check(ok, label) {
  say(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
}

/** A minimal but real sidecar — the same shape SidecarWriter emits. */
function makeSession(root, id, recordingFile) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'report'), { recursive: true });
  writeFileSync(join(dir, 'report', 'report.html'), '<h1>report</h1>');
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({
      session: {
        id,
        title: `delete harness ${id}`,
        startedAtWall: new Date().toISOString(),
        endedAtWall: new Date().toISOString(),
        recordingFile,
      },
      marks: [],
      events: [],
    }),
  );
  return dir;
}

/**
 * Original paths of everything currently in the Recycle Bin, lowercased. Read
 * straight from the `$I<id>` metadata files rather than through
 * Shell.Application COM, which takes ~15 s per enumeration on a bin this size.
 * Layout: 8-byte header, 8-byte size, 8-byte FILETIME, 4-byte name length,
 * then the original path as UTF-16LE.
 */
function recycleBinPaths() {
  const paths = new Set();
  const root = 'C:/$Recycle.Bin'; // forward slashes: no escaping to get wrong
  let sids;
  try {
    sids = readdirSync(root);
  } catch {
    return paths;
  }
  for (const sid of sids) {
    let names;
    try {
      names = readdirSync(join(root, sid));
    } catch {
      continue; // another user's bin — not ours to read
    }
    for (const name of names) {
      if (!name.startsWith('$I')) continue;
      try {
        const buf = readFileSync(join(root, sid, name));
        if (buf.length < 28) continue;
        const chars = buf.readUInt32LE(24);
        paths.add(buf.toString('utf16le', 28, 28 + chars * 2).replace(/\0+$/, '').toLowerCase());
      } catch {
        // raced with an empty-bin, or unreadable — skip
      }
    }
  }
  return paths;
}

/** True when `path` is recoverable from the Recycle Bin (Windows paths are case-insensitive). */
function inRecycleBin(bin, path) {
  return bin.has(path.toLowerCase());
}

// The process has no window, so anything thrown would hang it instead of
// failing the run. Always land on an explicit exit code.
process.on('unhandledRejection', (err) => {
  say(`FAIL  unhandled rejection: ${String(err)}`);
  app.exit(1);
});
process.on('uncaughtException', (err) => {
  say(`FAIL  uncaught exception: ${String(err)}`);
  app.exit(1);
});

// NB: `await app.whenReady()` at top level never resolves in an Electron ESM
// main entry — top-level await blocks the 'ready' event. Everything async has
// to live inside this callback.
app.whenReady().then(main);

async function main() {
  say(`electron ${process.versions.electron} — session-delete harness`);

  const root = mkdtempSync(join(tmpdir(), 'playtest-delete-'));
  const recording = join(root, 'kept-recording.mkv');
  writeFileSync(recording, 'not really video');
  const dir = makeSession(root, 'sess-with-recording', recording);
  const orphan = makeSession(root, 'sess-no-recording', join(root, 'gone.mkv'));
  const notASession = join(root, 'just-a-folder');
  mkdirSync(notASession);
  say(`sessions root: ${root}`);

  // Guard: only real session directories are deletable at all.
  check(entryFor(dir)?.id === 'sess-with-recording', 'entryFor accepts a session directory');
  check(entryFor(notASession) === null, 'entryFor rejects a non-session directory');
  check(entryFor(dir)?.recordingExists === true, 'recordingExists true when the file is on disk');
  check(entryFor(orphan)?.recordingExists === false, 'recordingExists false when the recording is gone');

  // Default path: folder to the bin, recording left alone (checkbox unticked).
  await shell.trashItem(dir);
  check(!existsSync(dir), 'session folder left the disk');
  check(existsSync(recording), 'recording survives when the checkbox is not ticked');
  check(inRecycleBin(recycleBinPaths(), dir), 'session folder is in the Recycle Bin (restorable)');

  // Checkbox path: the recording goes to the bin too.
  await shell.trashItem(recording);
  check(!existsSync(recording), 'recording left the disk on the checkbox path');
  check(inRecycleBin(recycleBinPaths(), recording), 'recording is in the Recycle Bin (restorable)');

  // A path that no longer exists must reject, not silently succeed.
  let threw = false;
  try {
    await shell.trashItem(join(root, 'never-existed'));
  } catch {
    threw = true;
  }
  check(threw, 'trashItem rejects a missing path (surfaces as an error in the UI)');

  await shell.trashItem(orphan);
  await shell.trashItem(notASession);
  say(failures ? `${failures} FAILED` : 'all checks passed');
  app.exit(failures ? 1 : 0);
}
