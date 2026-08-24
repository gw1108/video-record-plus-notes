/**
 * Publish a pipeline report bundle to Notion (tech-stack report §5.0/§5.3):
 * create page → embed widget (Tier 3, when hosted) → upload/attach the
 * condensed video (Tier 1 fallback content) → notes as native blocks →
 * transcript toggle. Batches children and paces calls under Notion's ~3 req/s.
 */
import { Client } from '@notionhq/client';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportData } from '@playtest/shared';
import {
  Block,
  CHILDREN_BATCH_MAX,
  chunk,
  embedBlock,
  heading2,
  noteBlock,
  paragraph,
  rt,
  summaryCallout,
  transcriptToggle,
  videoUploadBlock,
} from './blocks.js';
import { uploadFile } from './upload.js';

const RATE_DELAY_MS = 350;

export interface PublishOptions {
  reportDir: string;
  parentPageId: string;
  token: string;
  /** Hosted widget URL for the Tier-3 embed + Tier-2 timestamp links. */
  embedUrl?: string;
  /** Skip uploading condensed.mp4 (e.g. free workspace, or embed-only page). */
  uploadVideo: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function publish(opts: PublishOptions): Promise<string> {
  const dataPath = join(opts.reportDir, 'report_data.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as ReportData;
  const notion = new Client({ auth: opts.token });

  // Header blocks go in with page creation; the video block is appended after
  // its upload finishes; notes/transcript batches follow, keeping §5.3 order.
  const header: Block[] = [];
  if (opts.embedUrl) header.push(embedBlock(opts.embedUrl));
  header.push(summaryCallout(data));

  const date = data.session.date ? new Date(data.session.date).toLocaleDateString() : '';
  console.log(`Creating page "${data.session.title}"…`);
  const page = await notion.pages.create({
    parent: { page_id: opts.parentPageId },
    properties: {
      title: { title: [rt(`${data.session.title}${date ? ` — ${date}` : ''}`)] as never },
    },
    children: header as never,
  });
  const pageId = page.id;
  await sleep(RATE_DELAY_MS);

  const videoFile = join(opts.reportDir, data.video.file);
  if (opts.uploadVideo && data.video.kind === 'condensed' && existsSync(videoFile)) {
    console.log('Uploading condensed video…');
    try {
      const fileUploadId = await uploadFile(opts.token, videoFile);
      await notion.blocks.children.append({
        block_id: pageId,
        children: [videoUploadBlock(fileUploadId)] as never,
      });
      console.log('  video attached.');
    } catch (err) {
      console.warn(`  video upload failed: ${String(err)}`);
      console.warn('  (free workspaces cap uploads at 5 MiB — host the video and use --embed-url)');
      await notion.blocks.children.append({
        block_id: pageId,
        children: [
          paragraph([rt('Video upload failed — condensed video available at: ', { italic: true }), rt(videoFile)]),
        ] as never,
      });
    }
    await sleep(RATE_DELAY_MS);
  }

  const body: Block[] = [heading2('Notes')];
  for (const note of data.notes) body.push(noteBlock(note, opts.embedUrl));
  const toggle = transcriptToggle(data.transcript);
  if (toggle) body.push(toggle);

  const batches = chunk(body, CHILDREN_BATCH_MAX);
  for (const [i, batch] of batches.entries()) {
    console.log(`Appending blocks (batch ${i + 1}/${batches.length})…`);
    await notion.blocks.children.append({ block_id: pageId, children: batch as never });
    await sleep(RATE_DELAY_MS);
  }

  const url = (page as { url?: string }).url ?? `https://notion.so/${pageId.replace(/-/g, '')}`;
  console.log(`\nPublished: ${url}`);
  if (opts.embedUrl) {
    console.log(
      'Reminder: the embed URL must be reachable by page viewers and must allow framing by Notion ' +
        '(no X-Frame-Options; CSP frame-ancestors including https://*.notion.so https://*.notion.com https://*.notion.site). Verify rendering once manually.',
    );
  }
  return url;
}
