#!/usr/bin/env node
/**
 * playtest-notion publish <reportDir> [--parent-page <id>]
 *                        [--embed-url URL] [--no-upload] [--token TOKEN]
 *
 * Token: --token flag or NOTION_TOKEN env var; --parent-page falls back to
 * PARENT_ID. Both are also read from a `.env` file (cwd or any parent — see
 * `.env.example` at the repo root) without overriding real env vars. The
 * integration must be connected to the parent page (Share → Connections).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { publish } from './publish.js';

/** Minimal dotenv: KEY=value lines, `#` comments, optional quotes; env wins. */
export function loadDotEnv(start = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (line.trimStart().startsWith('#')) continue;
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const value = m[2]!.replace(/^(["'])(.*)\1$/, '$2');
        if (env[m[1]!] === undefined) env[m[1]!] = value;
      }
      return file;
    }
    if (dirname(dir) === dir) return null;
  }
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error(
    '\nusage: playtest-notion publish <reportDir> [--parent-page <id>] [--embed-url URL] [--no-upload] [--token TOKEN]',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  if (argv[0] !== 'publish') fail('unknown command (expected "publish")');
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (name === 'no-upload') flags.set(name, true);
      else {
        const value = argv[++i];
        if (value === undefined) fail(`missing value for --${name}`);
        flags.set(name, value);
      }
    } else positional.push(arg);
  }

  const reportDir = positional[0] ?? fail('missing <reportDir>');
  const parentPageId =
    (flags.get('parent-page') as string) ?? process.env['PARENT_ID'] ?? fail('pass --parent-page or set PARENT_ID');
  const token = (flags.get('token') as string) ?? process.env['NOTION_TOKEN'] ?? fail('set NOTION_TOKEN or pass --token');

  await publish({
    reportDir,
    parentPageId,
    token,
    embedUrl: flags.get('embed-url') as string | undefined,
    uploadVideo: !flags.has('no-upload'),
  });
}

// Only run the CLI when executed directly (the test imports loadDotEnv).
const invokedAsScript = process.argv[1] !== undefined && /cli\.[cm]?js$/.test(process.argv[1]);
if (invokedAsScript) {
  main().catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
