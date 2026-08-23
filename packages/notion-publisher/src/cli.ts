#!/usr/bin/env node
/**
 * playtest-notion publish <reportDir> --parent-page <id>
 *                        [--embed-url URL] [--no-upload] [--token TOKEN]
 *
 * Token: --token flag or NOTION_TOKEN env var. The integration must be
 * connected to the parent page (Share → Connections in Notion).
 */
import { publish } from './publish.js';

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error(
    '\nusage: playtest-notion publish <reportDir> --parent-page <id> [--embed-url URL] [--no-upload] [--token TOKEN]',
  );
  process.exit(1);
}

async function main(): Promise<void> {
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
  const parentPageId = (flags.get('parent-page') as string) ?? fail('missing --parent-page');
  const token = (flags.get('token') as string) ?? process.env['NOTION_TOKEN'] ?? fail('set NOTION_TOKEN or pass --token');

  await publish({
    reportDir,
    parentPageId,
    token,
    embedUrl: flags.get('embed-url') as string | undefined,
    uploadVideo: !flags.has('no-upload'),
  });
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
