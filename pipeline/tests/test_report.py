import unittest

from playtest_pipeline.plan import Window
from playtest_pipeline.report import build_chapters_vtt, build_report_data, text_in_range
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
