import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFromDirectSample, OffsetCalibration, offsetOfSample } from './anchor.js';
import { condensedToOriginalMs, originalToCondensedMs, type CutSegment } from './notes.js';
import { sidecarFromJournal, type JournalLine } from './session.js';
import { formatTimecode, formatVttTimestamp } from './time.js';

test('direct anchor walks back the press→status delay', () => {
  // Press at mono=10_000. Status sent at 10_004, received at 10_010 (rtt 6),
  // reporting outputDuration=65_000. Status midpoint is 10_007, which is 7ms
  // after the press, so the press maps to 65_000 - 7 = 64_993.
  const videoMs = anchorFromDirectSample(10_000, {
    sentMonoMs: 10_004,
    recvMonoMs: 10_010,
    outputDurationMs: 65_000,
  });
  assert.equal(videoMs, 64_993);
});

test('direct anchor clamps to zero right after record start', () => {
  const videoMs = anchorFromDirectSample(100, {
    sentMonoMs: 102,
    recvMonoMs: 104,
    outputDurationMs: 1,
  });
  assert.equal(videoMs, 0);
});

test('calibration median resists one slow status call', () => {
  const cal = new OffsetCalibration();
  // True offset is 50_000 (video clock = mono clock + 50_000).
  for (const base of [1000, 2000, 3000, 4000]) {
    cal.addSample({ sentMonoMs: base, recvMonoMs: base + 4, outputDurationMs: base + 2 + 50_000 });
  }
  // One pathological sample, 900ms late.
  cal.addSample({ sentMonoMs: 5000, recvMonoMs: 5008, outputDurationMs: 5004 + 50_000 - 900 });
  assert.equal(cal.offsetMs(), 50_000);
  assert.equal(cal.anchorMonoMs(6000), 56_000);
});

test('calibration is empty after reset (pause boundary)', () => {
  const cal = new OffsetCalibration();
  cal.addSample({ sentMonoMs: 0, recvMonoMs: 2, outputDurationMs: 100 });
  assert.equal(offsetOfSample({ sentMonoMs: 0, recvMonoMs: 2, outputDurationMs: 100 }), 99);
  cal.reset();
  assert.equal(cal.offsetMs(), null);
  assert.equal(cal.anchorMonoMs(123), null);
});

const CUTMAP: CutSegment[] = [
  { originalStartMs: 10_000, originalEndMs: 40_000, condensedStartMs: 0, condensedEndMs: 30_000 },
  { originalStartMs: 90_000, originalEndMs: 120_000, condensedStartMs: 30_000, condensedEndMs: 60_000 },
];

test('cut map translates both directions and snaps gaps forward', () => {
  assert.equal(originalToCondensedMs(CUTMAP, 15_000), 5_000);
  assert.equal(originalToCondensedMs(CUTMAP, 95_000), 35_000);
  // In the gap between segments: snap to next kept segment's start.
  assert.equal(originalToCondensedMs(CUTMAP, 60_000), 30_000);
  // Past the last segment: null.
  assert.equal(originalToCondensedMs(CUTMAP, 500_000), null);
  assert.equal(condensedToOriginalMs(CUTMAP, 5_000), 15_000);
  assert.equal(condensedToOriginalMs(CUTMAP, 45_000), 105_000);
  assert.equal(condensedToOriginalMs(CUTMAP, 70_000), null);
});

test('journal rebuild preserves marks and applies end line', () => {
  const lines: JournalLine[] = [
    {
      t: 'session',
      data: {
        id: 's1',
        title: 'Test',
        startedAtWall: '2026-08-22T15:00:00Z',
        captureTarget: { kind: 'game', name: 'DS2' },
      },
    },
    {
      t: 'mark',
      data: { id: 'm1', seq: 1, kind: 'manual', label: 'mark', monoMs: 100, videoMs: 5000 },
    },
    { t: 'event', data: { type: 'record-started', monoMs: 0 } },
    { t: 'end', data: { endedAtWall: '2026-08-22T16:00:00Z', recordingFile: 'C:/rec/a.mp4' } },
  ];
  const sidecar = sidecarFromJournal(lines);
  assert.ok(sidecar);
  assert.equal(sidecar.marks.length, 1);
  assert.equal(sidecar.session.endedAtWall, '2026-08-22T16:00:00Z');
  assert.equal(sidecar.session.recordingFile, 'C:/rec/a.mp4');
  assert.equal(sidecarFromJournal([]), null);
});

test('time formatting', () => {
  assert.equal(formatTimecode(0), '0:00');
  assert.equal(formatTimecode(65_000), '1:05');
  assert.equal(formatTimecode(3_725_000), '1:02:05');
  assert.equal(formatVttTimestamp(3_725_123), '01:02:05.123');
});
