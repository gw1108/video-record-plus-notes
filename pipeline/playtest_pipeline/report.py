"""Report assembly (§5.0): notes, WebVTT chapters, report_data.json, and the
self-contained player page — the first-class self-hosted report output. The
Notion page (packages/notion-publisher) is built from this same bundle.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .condense import CutSegment
from .plan import Window
from .session import Session

TEMPLATE_ENV_VAR = "PLAYTEST_TEMPLATE"
TEMPLATE_RELPATH = Path("packages") / "player-embed" / "report-template.html"
PACKAGED_TEMPLATE_PATH = Path(__file__).with_name("report-template.html")
DATA_PLACEHOLDER = "/*__REPORT_DATA__*/null"


def _vtt_timestamp(ms: int) -> str:
    ms = max(0, ms)
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, millis = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{millis:03d}"


def _timecode(ms: int) -> str:
    total = max(0, ms) // 1000
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def text_in_range(transcript: dict | None, start_ms: int, end_ms: int) -> str:
    """Transcript text within [start_ms, end_ms], word-accurate when word
    timestamps exist, segment-overlap otherwise. (Kept for ad-hoc lookups;
    note text itself is assigned one-segment-one-note by `assign_note_text`.)"""
    if not transcript:
        return ""
    parts: list[str] = []
    for seg in transcript.get("segments", []):
        words = seg.get("words") or []
        if words:
            # any word overlapping the range counts (boundary words included)
            hit = [w["text"] for w in words if w["startMs"] < end_ms and w["endMs"] > start_ms]
            if hit:
                parts.append(" ".join(hit))
        elif seg["startMs"] < end_ms and seg["endMs"] > start_ms:
            parts.append(seg.get("text", ""))
    return " ".join(p for p in parts if p).strip()


def _distance_ms(point_ms: int, start_ms: int, end_ms: int) -> int:
    """0 when the point lies inside [start, end], else the gap to the nearest edge."""
    if point_ms < start_ms:
        return start_ms - point_ms
    if point_ms > end_ms:
        return point_ms - end_ms
    return 0


def assign_note_text(notes: list[dict[str, Any]], transcript: dict | None) -> None:
    """Credit every transcript segment to exactly ONE note and set `text`.

    The segment windows (`windowStartMs..windowEndMs`, mark - 20 s .. + 10 s
    by default) are deliberately generous because they drive the video cut;
    using them for the text too made neighbouring notes repeat each other's
    sentences and gave a silent mark the previous note's dictation (found on
    the m1-live report, 2026-08-24). So: among the notes whose window
    overlaps a segment, the one whose mark instant is nearest to the segment
    gets it — "speak then press" and "press then speak" both resolve to the
    right mark, and a mark with no speech of its own stays empty. Ties go to
    the earlier note. Speech that no window covers is dropped here (it is
    still in the full transcript).
    """
    for n in notes:
        n["text"] = ""
    if not transcript or not notes:
        return
    parts: dict[str, list[str]] = {n["id"]: [] for n in notes}
    for seg in transcript.get("segments", []):
        seg_start, seg_end = seg["startMs"], seg["endMs"]
        candidates = [
            n for n in notes if n["windowStartMs"] < seg_end and n["windowEndMs"] > seg_start
        ]
        if not candidates:
            continue
        best = min(candidates, key=lambda n: (_distance_ms(n["videoMs"], seg_start, seg_end), n["videoMs"]))
        text = (seg.get("text") or "").strip()
        if text:
            parts[best["id"]].append(text)
    for n in notes:
        n["text"] = " ".join(parts[n["id"]])


def build_notes(
    session: Session,
    per_mark_windows: dict[str, Window],
    vad_windows: list[Window],
    transcript: dict | None,
) -> list[dict[str, Any]]:
    notes: list[dict[str, Any]] = []
    for mark in session.marks:
        if mark.video_ms is None:
            continue
        w = per_mark_windows.get(mark.id)
        if w is None:
            continue
        notes.append(
            {
                "id": mark.id,
                "kind": "manual",
                "label": mark.label,
                "videoMs": mark.video_ms,
                "gameTimeMs": mark.game_time_ms,
                "text": "",
                "windowStartMs": w.start_ms,
                "windowEndMs": w.end_ms,
            }
        )
    for w in vad_windows:
        note_id = w.note_ids[0]
        notes.append(
            {
                "id": note_id,
                "kind": "vad",
                "label": "speech",
                "videoMs": w.start_ms,
                "gameTimeMs": None,
                "text": "",
                "windowStartMs": w.start_ms,
                "windowEndMs": w.end_ms,
            }
        )
    notes.sort(key=lambda n: n["videoMs"])
    assign_note_text(notes, transcript)
    return notes


def build_chapters_vtt(merged_windows: list[Window], notes: list[dict[str, Any]]) -> str:
    """WebVTT kind=chapters track: cue per kept range; payload carries the
    note JSON blob (§5.2) so any player can rebuild markers + skip ranges."""
    by_id = {n["id"]: n for n in notes}
    lines = ["WEBVTT", ""]
    for i, w in enumerate(merged_windows, start=1):
        cue_notes = [by_id[nid] for nid in w.note_ids if nid in by_id]
        title = ", ".join(f"#{n['id']} {n['label']}" for n in cue_notes) or f"segment {i}"
        payload = json.dumps({"title": title, "notes": cue_notes}, ensure_ascii=False)
        lines.append(str(i))
        lines.append(f"{_vtt_timestamp(w.start_ms)} --> {_vtt_timestamp(w.end_ms)}")
        lines.append(payload)
        lines.append("")
    return "\n".join(lines)


def build_report_data(
    session: Session,
    original_duration_ms: int,
    video_file: str,
    video_kind: str,
    video_duration_ms: int,
    notes: list[dict[str, Any]],
    merged_windows: list[Window],
    cutmap: list[CutSegment],
    transcript: dict | None,
    dropped_marks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "session": {
            "id": session.id,
            "title": session.title,
            "date": session.started_at_wall,
            "originalDurationMs": original_duration_ms,
        },
        "video": {"file": video_file, "kind": video_kind, "durationMs": video_duration_ms},
        "notes": notes,
        "ranges": [
            {"startMs": w.start_ms, "endMs": w.end_ms, "noteIds": list(w.note_ids)}
            for w in merged_windows
        ],
        "cutmap": [c.to_json() for c in cutmap],
        # Marks anchored past the end of the (salvaged) recording: no video
        # exists for them; shown as a separate list, never seekable.
        "droppedMarks": dropped_marks or [],
        "transcript": (transcript or {}).get("segments", []),
    }


def find_template() -> Path:
    """Resolve an explicit override, the checkout source, or the packaged wheel fallback."""
    env = os.environ.get(TEMPLATE_ENV_VAR)
    if env:
        p = Path(env)
        if p.is_file():
            return p
        raise FileNotFoundError(f"{TEMPLATE_ENV_VAR} points at a missing file: {env}")
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / TEMPLATE_RELPATH
        if candidate.is_file():
            return candidate
    if PACKAGED_TEMPLATE_PATH.is_file():
        return PACKAGED_TEMPLATE_PATH
    raise FileNotFoundError(
        f"Player template not found in the checkout or installed package; set {TEMPLATE_ENV_VAR}."
    )


def render_report_html(report_data: dict[str, Any]) -> str:
    template = find_template().read_text(encoding="utf-8")
    if DATA_PLACEHOLDER not in template:
        raise ValueError(f"Template missing placeholder {DATA_PLACEHOLDER!r}")
    # Inline the data (file:// pages cannot fetch neighboring JSON). Escape
    # "</script" so note/transcript text cannot break out of the script tag.
    blob = json.dumps(report_data, ensure_ascii=False).replace("</", "<\\/")
    return template.replace(DATA_PLACEHOLDER, blob)


def write_report(
    report_dir: Path,
    report_data: dict[str, Any],
    chapters_vtt: str,
    notes: list[dict[str, Any]],
) -> None:
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "report_data.json").write_text(
        json.dumps(report_data, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (report_dir / "notes.json").write_text(
        json.dumps(notes, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    (report_dir / "chapters.vtt").write_text(chapters_vtt, encoding="utf-8")
    (report_dir / "report.html").write_text(render_report_html(report_data), encoding="utf-8")


def print_notes_summary(notes: list[dict[str, Any]]) -> None:
    for n in notes:
        text = (n["text"][:70] + "…") if len(n["text"]) > 70 else (n["text"] or "(no speech)")
        game = f" game {_timecode(n['gameTimeMs'])}" if n.get("gameTimeMs") is not None else ""
        print(f"    [{_timecode(n['videoMs'])}]{game} {n['label']}: {text}")
