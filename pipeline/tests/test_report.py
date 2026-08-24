import unittest

from playtest_pipeline.plan import Window
from playtest_pipeline.report import assign_note_text, build_chapters_vtt, build_report_data, text_in_range
from playtest_pipeline.session import Session


TRANSCRIPT = {
    "segments": [
        {
            "startMs": 1000, "endMs": 4000, "text": "this boss is unfair",
            "words": [
                {"startMs": 1000, "endMs": 1400, "text": "this"},
                {"startMs": 1400, "endMs": 1800, "text": "boss"},
                {"startMs": 1800, "endMs": 2400, "text": "is"},
                {"startMs": 2400, "endMs": 3900, "text": "unfair"},
            ],
        },
        {"startMs": 10_000, "endMs": 12_000, "text": "segment without words"},
    ]
}


class TestTextInRange(unittest.TestCase):
    def test_word_accurate_selection(self):
        # Overlap-inclusive: a word straddling the range boundary is kept —
        # better to include a boundary word than truncate a dictated note.
        self.assertEqual(text_in_range(TRANSCRIPT, 1300, 2500), "this boss is unfair")
        self.assertEqual(text_in_range(TRANSCRIPT, 1500, 2000), "boss is")

    def test_segment_fallback_without_words(self):
        self.assertEqual(text_in_range(TRANSCRIPT, 9_000, 13_000), "segment without words")

    def test_empty_transcript(self):
        self.assertEqual(text_in_range(None, 0, 1000), "")
        self.assertEqual(text_in_range(TRANSCRIPT, 500_000, 600_000), "")


class TestChaptersVtt(unittest.TestCase):
    def test_cue_structure(self):
        notes = [{"id": "m1", "kind": "manual", "label": "issue", "videoMs": 62_000,
                  "gameTimeMs": None, "text": "hello", "windowStartMs": 42_000,
                  "windowEndMs": 72_000}]
        vtt = build_chapters_vtt([Window(42_000, 72_000, ("m1",))], notes)
        lines = vtt.splitlines()
        self.assertEqual(lines[0], "WEBVTT")
        self.assertIn("00:00:42.000 --> 00:01:12.000", vtt)
        self.assertIn('"title": "#m1 issue"', vtt)


class TestBuildReportData(unittest.TestCase):
    def _session(self) -> Session:
        return Session(
            id="2026-08-22_153042_run", title="run", started_at_wall="2026-08-22T15:30:42Z",
            capture_target_kind="window", capture_target_name=None, recording_file=None,
        )

    def test_dropped_marks_included_and_default_empty(self):
        base = (self._session(), 60_000, "condensed.mp4", "condensed", 30_000, [], [], [], None)
        data = build_report_data(*base)
        self.assertEqual(data["droppedMarks"], [])
        dropped = [{"id": "m9", "seq": 9, "label": "issue", "videoMs": 90_000, "gameTimeMs": None}]
        data = build_report_data(*base, dropped_marks=dropped)
        self.assertEqual(data["droppedMarks"], dropped)


if __name__ == "__main__":
    unittest.main()


def _note(nid, video_ms, start_ms, end_ms, kind="manual"):
    return {"id": nid, "kind": kind, "label": "mark", "videoMs": video_ms, "gameTimeMs": None,
            "text": "", "windowStartMs": start_ms, "windowEndMs": end_ms}


class TestAssignNoteText(unittest.TestCase):
    """One transcript segment → one note (the nearest mark whose window
    overlaps it). Timings are the m1-live session, where the 20 s pre-window
    made every note repeat its neighbours and a silent mark inherit text."""

    M1_TRANSCRIPT = {"segments": [
        {"startMs": 3_000, "endMs": 7_500, "text": "First note. The lighting is too dark."},
        {"startMs": 15_000, "endMs": 18_500, "text": "Second note. The door collision feels sticky."},
        {"startMs": 26_000, "endMs": 27_000, "text": "Issue found."},
        {"startMs": 28_000, "endMs": 31_500, "text": "The enemy pathfinding gets stuck."},
        {"startMs": 43_000, "endMs": 44_500, "text": "Note after the pause."},
        {"startMs": 45_000, "endMs": 48_500, "text": "The boss music is far too loud."},
        {"startMs": 76_000, "endMs": 77_000, "text": "Final note."},
        {"startMs": 77_500, "endMs": 81_000, "text": "The difficulty curve felt fair."},
    ]}

    def m1_notes(self):
        # windows = mark - 20 s .. mark + 10 s, clamped at 0 (plan.window_for_mark)
        return [
            _note("m1", 8_337, 0, 18_337),
            _note("m2", 19_473, 0, 29_473),
            _note("m3", 24_895, 4_895, 34_895),
            _note("m4", 49_003, 29_003, 59_003),
            _note("m5", 59_430, 39_430, 69_430),   # the silent mark
            _note("m6", 81_118, 61_118, 90_381),
        ]

    def test_m1_live_attribution(self):
        notes = self.m1_notes()
        assign_note_text(notes, self.M1_TRANSCRIPT)
        by_id = {n["id"]: n["text"] for n in notes}
        self.assertEqual(by_id["m1"], "First note. The lighting is too dark.")
        self.assertEqual(by_id["m2"], "Second note. The door collision feels sticky.")
        self.assertEqual(by_id["m3"], "Issue found. The enemy pathfinding gets stuck.")   # press-then-speak
        self.assertEqual(by_id["m4"], "Note after the pause. The boss music is far too loud.")
        self.assertEqual(by_id["m5"], "")                                                 # silent mark stays silent
        self.assertEqual(by_id["m6"], "Final note. The difficulty curve felt fair.")

    def test_each_segment_used_once(self):
        notes = self.m1_notes()
        assign_note_text(notes, self.M1_TRANSCRIPT)
        joined = " ".join(n["text"] for n in notes)
        for seg in self.M1_TRANSCRIPT["segments"]:
            self.assertEqual(joined.count(seg["text"]), 1, seg["text"])

    def test_uncovered_speech_and_vad_notes(self):
        notes = [_note("m1", 10_000, 0, 20_000), _note("v1", 40_000, 40_000, 46_000, kind="vad")]
        transcript = {"segments": [
            {"startMs": 11_000, "endMs": 12_000, "text": "near the mark"},
            {"startMs": 30_000, "endMs": 31_000, "text": "in no window"},
            {"startMs": 41_000, "endMs": 45_000, "text": "vad burst"},
        ]}
        assign_note_text(notes, transcript)
        self.assertEqual([n["text"] for n in notes], ["near the mark", "vad burst"])

    def test_tie_goes_to_earlier_note_and_empty_transcript(self):
        notes = [_note("a", 10_000, 0, 20_000), _note("b", 14_000, 0, 24_000)]
        assign_note_text(notes, {"segments": [{"startMs": 11_000, "endMs": 13_000, "text": "between"}]})
        self.assertEqual([n["text"] for n in notes], ["between", ""])
        assign_note_text(notes, None)
        self.assertEqual([n["text"] for n in notes], ["", ""])
