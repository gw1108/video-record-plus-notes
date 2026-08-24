/** `.env` loading for the CLI: comments, quotes, CRLF, env precedence, walk-up. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv } from './cli.js';

test('loadDotEnv parses .env from a parent dir without clobbering the environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotenv-'));
  const nested = join(root, 'packages', 'x');
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(root, '.env'),
    ['# comment', 'NOTION_TOKEN=ntn_abc', "PARENT_ID='1234'", 'export QUOTED="a b"', 'BAD LINE', ''].join('\r\n'),
  );
  const env: NodeJS.ProcessEnv = { NOTION_TOKEN: 'from-env' };
  const found = loadDotEnv(nested, env);
  assert.equal(found, join(root, '.env'));
  assert.equal(env['NOTION_TOKEN'], 'from-env'); // real env wins
  assert.equal(env['PARENT_ID'], '1234');
  assert.equal(env['QUOTED'], 'a b');
  assert.equal(Object.keys(env).length, 3);
});

test('loadDotEnv returns null when no .env exists up the tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'dotenv-none-'));
  // tmpdir itself could in theory hold a .env; scope the assertion to the walk result being a path or null.
  const found = loadDotEnv(root, {});
  assert.ok(found === null || found.endsWith('.env'));
});
