/**
 * Offline checks for the block builders — the parts of PLAN M2 that need no
 * token: >100-block batching, the 2000-char rich_text cap, the transcript
 * toggle's child cap, and the Tier-2 `?t=` links the report page honors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Note, ReportData, TranscriptSegment } from '@playtest/shared';
import { CHILDREN_BATCH_MAX, chunk, noteBlock, rt, summaryCallout, transcriptToggle } from './blocks.js';

function note(i: number, text = `note ${i}`): Note {
  return {
    id: `m${i}`,
    kind: 'manual',
    label: 'mark',
    videoMs: i * 1000 + 473, // non-integer seconds: the link must floor
    gameTimeMs: null,
    text,
    windowStartMs: 0,
    windowEndMs: 1,
  };
}

test('chunk splits a long note list into ≤100-block batches', () => {
  const blocks = Array.from({ length: 250 }, (_, i) => noteBlock(note(i)));
  const batches = chunk(blocks, CHILDREN_BATCH_MAX);
  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.map((b) => b.length),
    [100, 100, 50],
  );
  assert.ok(batches.every((b) => b.length <= CHILDREN_BATCH_MAX));
});

test('rich text never exceeds the 2000-char item limit', () => {
  const item = rt('x'.repeat(5000));
  assert.ok(item.text.content.length <= 2000);
});

test('note block carries a ?t=<floor seconds> link only when an embed URL is set', () => {
  const linked = noteBlock(note(19), 'https://host/report.html') as {
    paragraph: { rich_text: Array<{ text: { link?: { url: string } } }> };
  };
  assert.equal(linked.paragraph.rich_text[0]!.text.link?.url, 'https://host/report.html?t=19');
  const withQuery = noteBlock(note(19), 'https://host/r.html?x=1') as typeof linked;
  assert.equal(withQuery.paragraph.rich_text[0]!.text.link?.url, 'https://host/r.html?x=1&t=19');
  const plain = noteBlock(note(19)) as typeof linked;
  assert.equal(plain.paragraph.rich_text[0]!.text.link, undefined);
});

test('transcript toggle caps its children below the batch limit', () => {
  const segments: TranscriptSegment[] = Array.from({ length: 5000 }, (_, i) => ({
    startMs: i * 4000,
    endMs: i * 4000 + 3000,
    text: `segment ${i} ${'word '.repeat(80)}`,
  }));
  const toggle = transcriptToggle(segments) as { toggle: { children: unknown[] } } | null;
  assert.ok(toggle);
  assert.ok(toggle.toggle.children.length <= CHILDREN_BATCH_MAX);
  assert.ok(toggle.toggle.children.length > 1);
  assert.equal(transcriptToggle([]), null);
});

test('summary callout describes condensed vs original video', () => {
  const base: ReportData = {
    schemaVersion: 1,
    session: { id: 's', title: 't', date: '2026-08-23T00:00:00Z', originalDurationMs: 90_000 },
    video: { file: 'condensed.mp4', kind: 'condensed', durationMs: 30_000 },
    notes: [note(1)],
    ranges: [],
    cutmap: [],
    transcript: [],
  };
  const text = (b: unknown) => (b as { callout: { rich_text: Array<{ text: { content: string } }> } }).callout.rich_text[0]!.text.content;
  assert.equal(text(summaryCallout(base)), '1 notes · original 1:30 · condensed to 0:30');
  assert.match(text(summaryCallout({ ...base, video: { ...base.video, kind: 'original' } })), /full recording$/);
});
