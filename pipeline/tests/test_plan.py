import unittest

from playtest_pipeline.plan import (
    Speech,
    Window,
    extend_to_speech,
    merge_windows,
    plan_segments,
    vad_only_windows,
    window_for_mark,
)


class TestWindowForMark(unittest.TestCase):
    def test_default_policy(self):
        w = window_for_mark("m1", 60_000, 3_600_000)
        self.assertEqual((w.start_ms, w.end_ms), (40_000, 70_000))

    def test_clamps_to_session_bounds(self):
        w = window_for_mark("m1", 5_000, 3_600_000)
        self.assertEqual(w.start_ms, 0)
        w = window_for_mark("m2", 3_595_000, 3_600_000)
        self.assertEqual(w.end_ms, 3_600_000)

    def test_mark_beyond_end_of_file_never_degenerate(self):
        # Calibrated marks after an OBS crash can anchor past the salvaged
        # MP4's end; the window must still satisfy start <= end.
        w = window_for_mark("m1", 4_000_000, 3_600_000)
        self.assertLessEqual(w.start_ms, w.end_ms)
        self.assertEqual((w.start_ms, w.end_ms), (3_600_000, 3_600_000))


class TestExtendToSpeech(unittest.TestCase):
    def test_encloses_overlapping_speech(self):
        # Dictated note starts inside the window and runs past its end:
        # the window must grow so the sentence is never cut (§5.4).
        w = Window(40_000, 70_000, ("m1",))
        speech = [Speech(65_000, 85_000)]
        extended = extend_to_speech(w, speech)
        self.assertEqual((extended.start_ms, extended.end_ms), (40_000, 85_000))

    def test_chains_through_touching_segments(self):
        w = Window(40_000, 70_000, ("m1",))
        speech = [Speech(65_000, 80_000), Speech(78_000, 95_000)]
        extended = extend_to_speech(w, speech)
        self.assertEqual(extended.end_ms, 95_000)

    def test_ignores_disjoint_speech(self):
        w = Window(40_000, 70_000, ("m1",))
        extended = extend_to_speech(w, [Speech(100_000, 110_000)])
        self.assertEqual((extended.start_ms, extended.end_ms), (40_000, 70_000))


class TestMergeWindows(unittest.TestCase):
    def test_merges_overlaps_and_near_adjacent(self):
        merged = merge_windows(
            [
                Window(0, 30_000, ("m1",)),
                Window(29_000, 60_000, ("m2",)),
                Window(60_500, 90_000, ("m3",)),  # 500ms gap < 1s merge gap
                Window(120_000, 150_000, ("m4",)),
            ]
        )
        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0].note_ids, ("m1", "m2", "m3"))
        self.assertEqual((merged[0].start_ms, merged[0].end_ms), (0, 90_000))
        self.assertEqual(merged[1].note_ids, ("m4",))

    def test_empty(self):
        self.assertEqual(merge_windows([]), [])


class TestVadOnlyWindows(unittest.TestCase):
    def test_uncovered_speech_becomes_candidate(self):
        marks = [Window(40_000, 70_000, ("m1",))]
        speech = [
            Speech(50_000, 55_000),   # covered by mark window -> excluded
            Speech(200_000, 205_000),  # uncovered, long enough -> included
            Speech(300_000, 300_800),  # too short -> excluded
        ]
        out = vad_only_windows(speech, marks, 3_600_000)
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0].start_ms, out[0].end_ms), (198_000, 207_000))

    def test_plan_orders_chronologically(self):
        merged = plan_segments(
            [Window(200_000, 230_000, ("m1",))],
            [Window(10_000, 20_000, ("v1",))],
        )
        self.assertEqual([w.start_ms for w in merged], [10_000, 200_000])


if __name__ == "__main__":
    unittest.main()
