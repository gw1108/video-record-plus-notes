/**
 * Notion block builders for the report page layout (tech-stack report §5.3):
 * [embed widget?] → summary → video → Notes (native, commentable blocks) →
 * Full transcript (collapsed toggle).
 */
import {
  formatTimecode,
  originalToCondensedMs,
  type CutSegment,
  type Note,
  type ReportData,
  type TranscriptSegment,
} from '@playtest/shared';

// Notion limits: 2000 chars per rich_text item, 100 blocks per children array.
const RICH_TEXT_MAX = 1900;
export const CHILDREN_BATCH_MAX = 100;

type RichText = {
  type: 'text';
  text: { content: string; link?: { url: string } };
  annotations?: { bold?: boolean; italic?: boolean; color?: string };
};

// Notion block payloads are deeply polymorphic; the SDK accepts these shapes.
export type Block = Record<string, unknown>;

export function rt(content: string, opts: { bold?: boolean; italic?: boolean; color?: string; link?: string } = {}): RichText {
  const item: RichText = { type: 'text', text: { content: content.slice(0, RICH_TEXT_MAX) } };
  if (opts.link) item.text.link = { url: opts.link };
  if (opts.bold || opts.italic || opts.color) {
    item.annotations = { bold: opts.bold, italic: opts.italic, color: opts.color };
  }
  return item;
}

export function paragraph(richText: RichText[]): Block {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText } };
}

export function heading2(text: string): Block {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [rt(text)] } };
}

export function embedBlock(url: string): Block {
  return { object: 'block', type: 'embed', embed: { url } };
}

/**
 * YouTube video id from `https://youtu.be/<id>`, `https://www.youtube.com/watch?v=<id>`
 * (any query order, `m.`/`music.` hosts, `/embed/<id>`, `/shorts/<id>`) or a bare
 * 11-char id. Throws on anything else — a typo here would publish a dead block.
 */
export function parseYouTubeId(input: string): string {
  const trimmed = input.trim();
  const ID = /^[A-Za-z0-9_-]{11}$/;
  if (ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`not a YouTube URL or video id: ${input}`);
  }
  const host = url.hostname.replace(/^www\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0] ?? null;
  else if (/^(m\.|music\.)?youtube(-nocookie)?\.com$/.test(host)) {
    id = url.searchParams.get('v') ?? /^\/(?:embed|shorts|live|v)\/([^/?]+)/.exec(url.pathname)?.[1] ?? null;
  }
  if (!id || !ID.test(id)) throw new Error(`not a YouTube URL or video id: ${input}`);
  return id;
}

/** Canonical watch URL — the form Notion's `video` block documents as supported. */
export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Deep link into the video at a whole second (`youtu.be/<id>?t=<s>`). */
export function youtubeLinkAt(id: string, seconds: number): string {
  return `https://youtu.be/${id}?t=${Math.max(0, Math.floor(seconds))}`;
}

/** `video` block on an external URL (YouTube `watch?v=` renders the real player). */
export function videoExternalBlock(url: string): Block {
  return { object: 'block', type: 'video', video: { type: 'external', external: { url } } };
}

export function videoUploadBlock(fileUploadId: string): Block {
  return {
    object: 'block',
    type: 'video',
    video: { type: 'file_upload', file_upload: { id: fileUploadId } },
  };
}

export function summaryCallout(data: ReportData, opts: { youtube?: boolean } = {}): Block {
  const condensed =
    data.video.kind === 'condensed'
      ? `condensed to ${formatTimecode(data.video.durationMs)}`
      : 'full recording';
  const carrier = opts.youtube ? ' · video: YouTube (unlisted)' : '';
  return {
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '🎮' },
      rich_text: [
        rt(
          `${data.notes.length} notes · original ${formatTimecode(data.session.originalDurationMs)} · ${condensed}${carrier}`,
        ),
      ],
    },
  };
}

export interface NoteLinkOptions {
  /** Hosted report page: `?t=<original seconds>` links (Tier 2 via the widget). */
  embedUrl?: string;
  /** YouTube video id: `youtu.be/<id>?t=<condensed seconds>` links. */
  youtubeId?: string;
  /** Cut map used to convert the note's original time to condensed time. */
  cutmap?: CutSegment[];
}

/**
 * One note = one paragraph: [video ts] (game ts) LABEL — transcribed text.
 * The timestamp links to the hosted page when `embedUrl` is set (original
 * seconds), else to YouTube (condensed seconds via the cut map). With both,
 * the page link wins and the YouTube link is appended as `▶`. A note with no
 * condensed position (its window was dropped) gets no YouTube link.
 */
export function noteBlock(note: Note, opts: string | NoteLinkOptions = {}): Block {
  const o: NoteLinkOptions = typeof opts === 'string' ? { embedUrl: opts } : opts;
  const tsText = `[${formatTimecode(note.videoMs)}]`;
  const seconds = Math.floor(note.videoMs / 1000);
  const embedLink = o.embedUrl ? `${o.embedUrl}${o.embedUrl.includes('?') ? '&' : '?'}t=${seconds}` : undefined;
  let youtubeLink: string | undefined;
  if (o.youtubeId) {
    const condensedMs =
      o.cutmap && o.cutmap.length > 0 ? originalToCondensedMs(o.cutmap, note.videoMs) : note.videoMs;
    if (condensedMs !== null) youtubeLink = youtubeLinkAt(o.youtubeId, condensedMs / 1000);
  }
  const parts: RichText[] = [
    rt(tsText + ' ', {
      bold: true,
      color: 'blue',
      // Tier-2 timestamp link (§5.0): note → video.
      link: embedLink ?? youtubeLink,
    }),
  ];
  if (embedLink && youtubeLink) parts.push(rt('▶ ', { color: 'red', link: youtubeLink }));
  if (note.gameTimeMs !== null && note.gameTimeMs !== undefined) {
    parts.push(rt(`(game ${formatTimecode(note.gameTimeMs)}) `, { color: 'gray' }));
  }
  parts.push(rt(`${note.label.toUpperCase()} — `, { bold: true }));
  parts.push(note.text ? rt(note.text) : rt('no transcribed speech', { italic: true, color: 'gray' }));
  return paragraph(parts);
}

export function transcriptToggle(transcript: TranscriptSegment[]): Block | null {
  if (transcript.length === 0) return null;
  const children: Block[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) children.push(paragraph([rt(buffer)]));
    buffer = '';
  };
  for (const seg of transcript) {
    const line = `[${formatTimecode(seg.startMs)}] ${seg.text}`;
    if (buffer.length + line.length + 1 > RICH_TEXT_MAX) flush();
    buffer = buffer ? `${buffer}\n${line}` : line;
    if (children.length >= CHILDREN_BATCH_MAX - 1) break; // hard cap; rest is in report.html
  }
  flush();
  return {
    object: 'block',
    type: 'toggle',
    toggle: { rich_text: [rt('Full transcript', { bold: true })], children },
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
