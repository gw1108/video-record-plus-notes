#!/usr/bin/env node
/**
 * Dump a published Notion page's blocks for PLAN M2/M3 verification:
 *
 *     node hack/notion-page-dump.mjs <page-url-or-id> [--archive]
 *
 * Prints one line per top-level block (type + first 90 chars of text, video
 * file kind/size, embed URL, toggle child count) and a summary. `--archive`
 * moves the page to Notion's trash afterwards (test pages are throwaway).
 * Token from NOTION_TOKEN or .env (same loader as the CLI).
 */
import { Client } from '@notionhq/client';
import { loadDotEnv } from '../packages/notion-publisher/dist/cli.js';

loadDotEnv();
const [target, ...rest] = process.argv.slice(2);
if (!target) {
  console.error('usage: node hack/notion-page-dump.mjs <page-url-or-id> [--archive]');
  process.exit(1);
}
const id = (target.match(/([0-9a-f]{32})(?:[^0-9a-f]|$)/i) ?? [])[1] ?? target;
const notion = new Client({ auth: process.env.NOTION_TOKEN });

const text = (rt) => (rt ?? []).map((r) => r.plain_text).join('');
const links = (rt) => (rt ?? []).filter((r) => r.href).map((r) => r.href);

async function children(blockId) {
  const out = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    out.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

const page = await notion.pages.retrieve({ page_id: id });
console.log(`page: ${text(page.properties?.title?.title)}  (${page.url})`);
const blocks = await children(id);
const counts = {};
for (const b of blocks) {
  counts[b.type] = (counts[b.type] ?? 0) + 1;
  const body = b[b.type] ?? {};
  let line = `${b.type.padEnd(12)} `;
  if (b.type === 'video') {
    const src = body.file ?? body.external ?? body.file_upload ?? {};
    line += `[${body.type}] ${(src.url ?? '').slice(0, 80)}`;
  } else if (b.type === 'embed') line += body.url;
  else if (b.type === 'toggle') {
    const kids = await children(b.id);
    line += `${text(body.rich_text)}  (${kids.length} children)`;
  } else line += text(body.rich_text).slice(0, 90).replace(/\n/g, '⏎');
  const l = links(body.rich_text);
  if (l.length) line += `  → ${l.join(' ')}`;
  console.log(line);
}
console.log(`\n${blocks.length} top-level blocks:`, JSON.stringify(counts));

if (rest.includes('--archive')) {
  await notion.pages.update({ page_id: id, archived: true });
  console.log('archived (in Notion trash).');
}
