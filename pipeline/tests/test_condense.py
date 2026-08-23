import unittest
from pathlib import Path

from playtest_pipeline.condense import build_cutmap, concat_entry, merge_colliding_starts
from playtest_pipeline.plan import Window


class TestBuildCutmap(unittest.TestCase):
    def test_cutmap_from_actual_bounds(self):
        # Two emitted segments with keyframe-snapped starts and probed durations.
        cutmap = build_cutmap([(38_500, 32_000), (118_000, 31_500)])
        self.assertEqual(cutmap[0].original_start_ms, 38_500)
        self.assertEqual(cutmap[0].original_end_ms, 70_500)
        self.assertEqual(cutmap[0].condensed_start_ms, 0)
        self.assertEqual(cutmap[0].condensed_end_ms, 32_000)
        self.assertEqual(cutmap[1].condensed_start_ms, 32_000)
        self.assertEqual(cutmap[1].condensed_end_ms, 63_500)
        self.assertEqual(cutmap[1].original_end_ms, 149_500)

    def test_json_shape_matches_shared_contract(self):
        seg = build_cutmap([(0, 1000)])[0].to_json()
        self.assertEqual(
            set(seg),
            {"originalStartMs", "originalEndMs", "condensedStartMs", "condensedEndMs"},
        )


class TestMergeCollidingStarts(unittest.TestCase):
    def test_keyframe_snapback_into_previous_segment_merges(self):
        # Segment 2's requested start (61.5s) snaps back to a keyframe at 58s,
        # inside segment 1's emitted span [38.5s, 60s+pad] — without merging,
        # 58-60.5s would play twice and the cut map would overlap.
        windows = [Window(40_000, 60_000, ("m1",)), Window(61_500, 90_000, ("m2",))]
        merged = merge_colliding_starts([38.5, 58.0], windows)
        self.assertEqual(len(merged), 1)
        start_s, w = merged[0]
        self.assertEqual(start_s, 38.5)
        self.assertEqual((w.start_ms, w.end_ms), (40_000, 90_000))
        self.assertEqual(w.note_ids, ("m1", "m2"))

    def test_disjoint_segments_untouched(self):
        windows = [Window(40_000, 60_000, ("m1",)), Window(120_000, 150_000, ("m2",))]
        merged = merge_colliding_starts([38.5, 118.0], windows)
        self.assertEqual(len(merged), 2)
        self.assertEqual([s for s, _ in merged], [38.5, 118.0])

    def test_chain_of_collisions_collapses_to_one(self):
        windows = [
            Window(10_000, 20_000, ("m1",)),
            Window(21_000, 30_000, ("m2",)),
            Window(31_000, 40_000, ("m3",)),
        ]
        # every snap lands at or before the previous segment's padded end
        merged = merge_colliding_starts([8.0, 18.0, 28.0], windows)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0][1].end_ms, 40_000)
        self.assertEqual(merged[0][1].note_ids, ("m1", "m2", "m3"))


class TestConcatEntry(unittest.TestCase):
    def test_plain_path(self):
        entry = concat_entry(Path("segs") / "seg_000.mp4")
        self.assertTrue(entry.startswith("file '"))
        self.assertTrue(entry.endswith("seg_000.mp4'\n"))

    def test_single_quote_escaped(self):
        # e.g. a sessions dir under C:\Users\O'Brien
        entry = concat_entry(Path("O'Brien") / "seg_000.mp4")
        self.assertIn("O'\\''Brien", entry)


if __name__ == "__main__":
    unittest.main()
