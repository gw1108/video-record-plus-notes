"""Load the session sidecar (source of truth for marks).

Mirrors packages/shared/src/session.ts and schema/session.schema.json.
If session.json is missing or corrupt (recorder crash), rebuilds it from the
append-only session.journal.jsonl.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

SIDECAR_FILENAME = "session.json"
JOURNAL_FILENAME = "session.journal.jsonl"


@dataclass
class Mark:
    id: str
    seq: int
    kind: str  # manual | vad | auto
    label: str
    mono_ms: float
    video_ms: int | None
    game_time_ms: int | None = None
    hotkey: str | None = None

    @staticmethod
    def from_json(d: dict) -> "Mark":
        return Mark(
            id=d["id"],
            seq=d["seq"],
            kind=d.get("kind", "manual"),
            label=d.get("label", "mark"),
            mono_ms=d.get("monoMs", 0),
            video_ms=d.get("videoMs"),
            game_time_ms=d.get("gameTimeMs"),
            hotkey=d.get("hotkey"),
        )


@dataclass
class Session:
    id: str
    title: str
    started_at_wall: str
    capture_target_kind: str
    capture_target_name: str | None
    recording_file: str | None
    marks: list[Mark] = field(default_factory=list)
    raw: dict = field(default_factory=dict)

    @staticmethod
    def from_sidecar(data: dict) -> "Session":
        if data.get("schemaVersion") != 1:
            raise ValueError(f"Unsupported sidecar schemaVersion: {data.get('schemaVersion')!r}")
        info = data["session"]
        target = info.get("captureTarget", {})
        return Session(
            id=info["id"],
            title=info.get("title", info["id"]),
            started_at_wall=info.get("startedAtWall", ""),
            capture_target_kind=target.get("kind", "other"),
            capture_target_name=target.get("name"),
            recording_file=info.get("recordingFile"),
            marks=[Mark.from_json(m) for m in data.get("marks", [])],
            raw=data,
        )


def _sidecar_from_journal(journal_path: Path) -> dict | None:
    """Rebuild a sidecar dict from journal lines (mirrors sidecarFromJournal in TS)."""
    session_info: dict | None = None
    marks: list[dict] = []
    events: list[dict] = []
    telemetry: list[dict] = []
    for raw_line in journal_path.read_text(encoding="utf-8").splitlines():
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            line = json.loads(raw_line)
        except json.JSONDecodeError:
            continue  # torn tail write from a crash — skip
        t, data = line.get("t"), line.get("data")
        if t == "session":
            session_info = data
        elif t == "mark":
            marks.append(data)
        elif t == "event":
            events.append(data)
        elif t == "telemetry":
            telemetry.append(data)
        elif t == "end" and session_info is not None:
            session_info["endedAtWall"] = data.get("endedAtWall")
            if data.get("recordingFile"):
                session_info["recordingFile"] = data["recordingFile"]
    if session_info is None:
        return None
    return {
        "schemaVersion": 1,
        "session": session_info,
        "marks": marks,
        "events": events,
        "telemetry": telemetry,
    }


def load_session(session_dir: Path) -> Session:
    sidecar_path = session_dir / SIDECAR_FILENAME
    journal_path = session_dir / JOURNAL_FILENAME
    data: dict | None = None
    if sidecar_path.exists():
        try:
            data = json.loads(sidecar_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            data = None
    if data is None and journal_path.exists():
        print(f"  session.json missing/corrupt — rebuilding from {JOURNAL_FILENAME}")
        data = _sidecar_from_journal(journal_path)
    if data is None:
        raise FileNotFoundError(
            f"No readable {SIDECAR_FILENAME} or {JOURNAL_FILENAME} in {session_dir}"
        )
    return Session.from_sidecar(data)


def resolve_recording(session: Session, session_dir: Path, override: str | None) -> Path:
    """Find the OBS recording: CLI override > sidecar path > any video in session dir."""
    if override:
        p = Path(override)
        if p.exists():
            return p
        raise FileNotFoundError(f"--recording not found: {override}")
    if session.recording_file:
        p = Path(session.recording_file)
        if not p.is_absolute():
            p = session_dir / p
        if p.exists():
            return p
        print(f"  sidecar recording path missing on disk: {p}")
    candidates = [
        f for ext in ("*.mp4", "*.mkv", "*.mov") for f in session_dir.glob(ext)
    ]
    if candidates:
        best = max(candidates, key=lambda f: f.stat().st_size)
        print(f"  using recording found in session dir: {best.name}")
        return best
    raise FileNotFoundError(
        "Recording not found. Pass --recording PATH (the OBS output file for this session)."
    )
