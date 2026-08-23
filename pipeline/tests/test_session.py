import json
import tempfile
import unittest
from pathlib import Path

from playtest_pipeline.session import load_session


def write_journal(session_dir: Path, lines: list[dict]) -> None:
    (session_dir / "session.journal.jsonl").write_text(
        "".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8"
    )


class TestJournalRecovery(unittest.TestCase):
    def test_rebuilds_from_journal_when_sidecar_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            session_dir = Path(tmp)
            write_journal(
                session_dir,
                [
                    {"t": "session", "data": {
                        "id": "s1", "title": "Crash test",
                        "startedAtWall": "2026-08-22T15:00:00Z",
                        "captureTarget": {"kind": "game", "name": "DS2"},
                    }},
                    {"t": "mark", "data": {"id": "m1", "seq": 1, "kind": "manual",
                                            "label": "mark", "monoMs": 100, "videoMs": 5000}},
                    {"t": "end", "data": {"endedAtWall": "2026-08-22T16:00:00Z",
                                           "recordingFile": "C:/rec/a.mp4"}},
                ],
            )
            session = load_session(session_dir)
            self.assertEqual(session.id, "s1")
            self.assertEqual(len(session.marks), 1)
            self.assertEqual(session.marks[0].video_ms, 5000)
            self.assertEqual(session.recording_file, "C:/rec/a.mp4")

    def test_torn_tail_line_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            session_dir = Path(tmp)
            write_journal(session_dir, [
                {"t": "session", "data": {
                    "id": "s1", "title": "T", "startedAtWall": "2026-08-22T15:00:00Z",
                    "captureTarget": {"kind": "app"},
                }},
            ])
            with (session_dir / "session.journal.jsonl").open("a", encoding="utf-8") as f:
                f.write('{"t": "mark", "data": {"id": "m1", "se')  # crash mid-write
            session = load_session(session_dir)
            self.assertEqual(session.id, "s1")
            self.assertEqual(session.marks, [])

    def test_sidecar_preferred_over_journal(self):
        with tempfile.TemporaryDirectory() as tmp:
            session_dir = Path(tmp)
            sidecar = {
                "schemaVersion": 1,
                "session": {"id": "s2", "title": "Sidecar", "startedAtWall": "x",
                             "captureTarget": {"kind": "video"}},
                "marks": [], "events": [], "telemetry": [],
            }
            (session_dir / "session.json").write_text(json.dumps(sidecar), encoding="utf-8")
            write_journal(session_dir, [{"t": "session", "data": {
                "id": "sJOURNAL", "title": "J", "startedAtWall": "x",
                "captureTarget": {"kind": "app"},
            }}])
            self.assertEqual(load_session(session_dir).id, "s2")

    def test_missing_everything_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                load_session(Path(tmp))


if __name__ == "__main__":
    unittest.main()
