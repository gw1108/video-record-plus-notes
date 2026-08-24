import unittest

from playtest_pipeline.youtube import (
    FEW_CHAPTERS_LINE,
    build_chapters,
    build_description,
    build_title,
    chapter_lines,
    chapter_title,
    first_sentence,
    format_timecode,
    original_to_condensed_ms,
)


def note(nid: str, video_ms: int, label: str = "mark", text: str = "") -> dict:
    return {"id": nid, "kind": "manual", "label": label, "videoMs": video_ms,
            "gameTimeMs": None, "text": text, "windowStartMs": 0, "windowEndMs": 1}


IDENTITY = [{"originalStartMs": 0, "originalEndMs": 90_423,
             "condensedStartMs": 0, "condensedEndMs": 90_423}]


class TestFolding(unittest.TestCase):
    def test_report_big_shape(self):
        # REPORT_BIG (m1-live): 0:08 folds into 0:00, 0:24 into 0:19, 1:21 into 0:59.
        notes = [
            note("m1", 8_337, text="1. Note. The lighting is too dark."),
            note("m2", 19_473, text="2. Note. The door collision is off."),
            note("m3", 24_895, "issue", "The lighting is too dark."),
            note("m4", 49_003, text="Path finding gets stuck."),
            note("m5", 59_430, text="Note after the pause. Boss music too loud."),
            note("m6", 81_118, text="Final note. Difficulty felt fair."),
        ]
        chapters = build_chapters(notes, IDENTITY, 90_383)
        self.assertEqual([ms for ms, _ in chapters], [0, 19_473, 49_003, 59_430])
        titles = [t for _, t in chapters]
        self.assertEqual(titles[0], "MARK — 1. Note. The lighting is too dark.")
        self.assertEqual(titles[1], "MARK — 2. Note. The door collision is off. · ISSUE — The lighting is too dark.")
        self.assertTrue(titles[3].startswith("MARK — Note after the pause. Boss music too loud. · MARK — Final"))
        self.assertLessEqual(len(titles[3]), 80)
        # every chapter ≥ 10 s, including the last one against the video end
        bounds = [ms for ms, _ in chapters] + [90_383]
        self.assertTrue(all(b - a >= 10_000 for a, b in zip(bounds, bounds[1:])))
        self.assertEqual(chapter_lines(chapters)[0], "0:00 MARK — 1. Note. The lighting is too dark.")

    def test_first_chapter_is_session_start_when_no_early_note(self):
        chapters = build_chapters([note("m1", 30_000, text="Hi there.")], IDENTITY, 90_000)
        self.assertEqual(chapters, [(0, "Session start"), (30_000, "MARK — Hi there.")])

    def test_fold_title_capped_at_80(self):
        long = "x" * 70
        notes = [note("a", 1_000, text=long), note("b", 5_000, text=long)]
        (_, title), = build_chapters(notes, IDENTITY, 60_000)
        self.assertLessEqual(len(title), 80)
        self.assertTrue(title.endswith("…"))

    def test_note_dropped_by_cutmap_is_skipped(self):
        cutmap = [
            {"originalStartMs": 0, "originalEndMs": 20_000, "condensedStartMs": 0, "condensedEndMs": 20_000},
            {"originalStartMs": 60_000, "originalEndMs": 80_000, "condensedStartMs": 20_000, "condensedEndMs": 40_000},
        ]
        self.assertEqual(original_to_condensed_ms(cutmap, 70_000), 30_000)
        self.assertEqual(original_to_condensed_ms(cutmap, 40_000), 20_000)  # gap → next segment
        self.assertIsNone(original_to_condensed_ms(cutmap, 95_000))  # past the end → dropped
        notes = [note("a", 5_000, text="A."), note("b", 70_000, text="B."), note("c", 95_000, text="C.")]
        chapters = build_chapters(notes, cutmap, 40_000)
        self.assertEqual([t for _, t in chapters], ["MARK — A.", "MARK — B."])
        self.assertEqual(chapters[1][0], 30_000)

    def test_silent_mark_folds_away_behind_a_titled_note(self):
        # m1-live after text attribution: m5 (silent, 59.4 s) + m6 (81.1 s, < 10 s before the end)
        notes = [note("m5", 59_430), note("m6", 81_118, text="Final note. The curve felt fair.")]
        chapters = build_chapters(notes, IDENTITY, 90_383)
        self.assertEqual(chapters[-1], (59_430, "MARK — Final note. The curve felt fair."))
        # two silent marks still show both labels
        chapters = build_chapters([note("a", 59_430), note("b", 81_118)], IDENTITY, 90_383)
        self.assertEqual(chapters[-1], (59_430, "MARK · MARK"))

    def test_empty_cutmap_is_identity(self):
        self.assertEqual(original_to_condensed_ms([], 12_345), 12_345)


class TestTitles(unittest.TestCase):
    def test_angle_brackets_and_first_sentence(self):
        self.assertEqual(chapter_title(note("a", 0, "bug", "Menu <b>flickers</b> when the map opens! Then more.")),
                         "BUG — Menu (b)flickers(/b) when the map opens!")
        self.assertEqual(first_sentence("Ok. Fine. It works after the second try though."),
                         "Ok. Fine. It works after the second try though.")
        self.assertEqual(chapter_title(note("a", 0, "fun")), "FUN")

    def test_video_title(self):
        data = {"session": {"title": "m1-live", "date": "2026-08-23T12:00:00.000Z"}}
        self.assertEqual(build_title(data), "m1-live — playtest 2026-08-23")
        long = {"session": {"title": "t" * 200, "date": "2026-08-23T12:00:00.000Z"}}
        self.assertLessEqual(len(build_title(long)), 100)

    def test_timecode(self):
        self.assertEqual(format_timecode(19_473), "0:19")
        self.assertEqual(format_timecode(3_661_000), "1:01:01")


def report(notes, duration_ms=90_383, cutmap=IDENTITY):
    return {
        "session": {"id": "s", "title": "m1-live", "date": "2026-08-23T12:00:00.000Z",
                    "originalDurationMs": 90_381},
        "video": {"file": "condensed.mp4", "kind": "condensed", "durationMs": duration_ms},
        "notes": notes, "cutmap": cutmap, "transcript": [],
    }


class TestDescription(unittest.TestCase):
    def test_layout_and_few_chapters_line(self):
        # REPORT_SMALL: 6 s, 3 notes, no speech → only 0:00, plus the warning line.
        small = report([note("m1", 1_501, "bug"), note("m2", 1_960, "fun"), note("m3", 3_086, "fun")],
                       duration_ms=5_965)
        text = build_description(small)
        lines = text.split("\n")
        self.assertEqual(lines[0], "3 notes · original 1:30 · condensed 0:05 · recorded 2026-08-23")
        self.assertEqual(lines[1], "")
        self.assertEqual(lines[2], "0:00 BUG · FUN · FUN")
        self.assertEqual(lines[3], FEW_CHAPTERS_LINE)
        self.assertEqual(lines[-1], "Generated by Playtest Recorder")
        self.assertNotIn("<", text)
        self.assertNotIn(">", text)

    def test_no_warning_with_three_chapters(self):
        notes = [note("a", 15_000, text="A."), note("b", 30_000, text="B."), note("c", 45_000, text="C.")]
        text = build_description(report(notes))
        self.assertNotIn(FEW_CHAPTERS_LINE, text)
        self.assertIn("\n0:00 Session start\n0:15 MARK — A.\n0:30 MARK — B.\n0:45 MARK — C.\n\n", text)

    def test_byte_cap_drops_trailing_chapters(self):
        total = 12_000 * 200
        full = [{"originalStartMs": 0, "originalEndMs": total, "condensedStartMs": 0, "condensedEndMs": total}]
        notes = [note(f"n{i}", 12_000 * i, text="ü" * 60 + ".") for i in range(1, 200)]
        text = build_description(report(notes, duration_ms=total, cutmap=full))
        self.assertLessEqual(len(text.encode("utf-8")), 4_800)
        self.assertRegex(text, r"… and \d+ more notes in the Notion report")
        self.assertTrue(text.startswith("199 notes"))
        self.assertTrue(text.endswith("Generated by Playtest Recorder"))


if __name__ == "__main__":
    unittest.main()
