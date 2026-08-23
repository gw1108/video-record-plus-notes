/**
 * Notion block builders for the report page layout (tech-stack report §5.3):
 * [embed widget?] → summary → video → Notes (native, commentable blocks) →
 * Full transcript (collapsed toggle).
 */
import { formatTimecode, type Note, type ReportData, type TranscriptSegment } from '@playtest/shared';

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

export function videoUploadBlock(fileUploadId: string): Block {
  return {
    object: 'block',
    type: 'video',
    video: { type: 'file_upload', file_upload: { id: fileUploadId } },
  };
}

export function summaryCallout(data: ReportData): Block {
  const condensed =
    data.video.kind === 'condensed'
      ? `condensed to ${formatTimecode(data.video.durationMs)}`
      : 'full recording';
  return {
    object: 'block',
    type: 'callout',
    callout: {
      icon: { type: 'emoji', emoji: '🎮' },
      rich_text: [
        rt(
          `${data.notes.length} notes · original ${formatTimecode(data.session.originalDurationMs)} · ${condensed}`,
        ),
      ],
    },
  };
}

/** One note = one paragraph: [video ts] (game ts) LABEL — transcribed text. */
export function noteBlock(note: Note, embedUrl?: string): Block {
  const tsText = `[${formatTimecode(note.videoMs)}]`;
  const seconds = Math.floor(note.videoMs / 1000);
  const parts: RichText[] = [
    rt(tsText + ' ', {
      bold: true,
      color: 'blue',
      // Tier-2 timestamp link when the widget is hosted (§5.0): note → video.
      link: embedUrl ? `${embedUrl}${embedUrl.includes('?') ? '&' : '?'}t=${seconds}` : undefined,
    }),
  ];
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
