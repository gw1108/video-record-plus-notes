"""playtest-pipeline CLI — orchestrates the post-session stages.

    playtest-pipeline process <session_dir> [options]
    playtest-pipeline inspect <session_dir>
    playtest-pipeline youtube-kit <session_dir>   # regenerate report/youtube/*.txt only

Every stage caches its output inside <session_dir>/pipeline and is skipped
when the output already exists (rerun with --force). Heavy optional stages
(VAD, STT) degrade gracefully when their extras aren't installed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import report as report_mod
from . import youtube as youtube_mod
from .condense import CondenseResult, condense
from .media import probe_chapters, probe_duration_ms, extract_audio_track, tool_origin
from .plan import (
    DEFAULT_MERGE_GAP_MS,
    DEFAULT_POST_MS,
    DEFAULT_PRE_MS,
    Speech,
    Window,
    extend_to_speech,
    plan_segments,
    vad_only_windows,
    window_for_mark,
)
from .session import Session, load_session, resolve_recording
from .transcribe import stt_available, transcribe
from .vad import detect_speech, vad_available


# Measured on an RTX 2060 6 GB (pipeline/README.md "Model choice"): medium is
# ~2x slower than small on the GPU for marginally cleaner wording; on CPU only
# small stays comfortably faster than realtime.
MODEL_TIP = "  tip: --model medium for better accuracy (~2x slower on a GPU); --model small on CPU"


def _stage(name: str) -> None:
    print(f"\n== {name}")


def _load_or_none(path: Path) -> dict | list | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def cmd_process(args: argparse.Namespace) -> int:
    session_dir = Path(args.session_dir).resolve()
    pipeline_dir = session_dir / "pipeline"
    report_dir = session_dir / "report"

    _stage("Load session")
    session = load_session(session_dir)
    recording = resolve_recording(session, session_dir, args.recording)
    duration_ms = probe_duration_ms(recording)
    anchored = [m for m in session.marks if m.video_ms is not None]
    print(f"  {session.title} — recording {recording.name}, {duration_ms / 1000:.0f}s, "
          f"{len(anchored)}/{len(session.marks)} anchored marks")
    print(f"  ffmpeg: {tool_origin('ffmpeg')}")
    # After an OBS crash the salvaged MP4 can be shorter than late (calibrated)
    # marks: no video exists for them. Keep them out of the cut but list them —
    # silently dropping a mark would look like a recorder bug.
    beyond_eof = [m for m in anchored if m.video_ms > duration_ms]
    if beyond_eof:
        print(f"  WARNING: {len(beyond_eof)} mark(s) are anchored past the end of the "
              "recording (video not salvaged — OBS crash?). Excluded from the cut, "
              "listed in the report:")
        for m in beyond_eof:
            print(f"    #{m.seq} {m.label} @ {m.video_ms / 1000:.1f}s")
        anchored = [m for m in anchored if m.video_ms <= duration_ms]

    _stage("Extract mic track (OBS audio track 2)")
    mic_wav = pipeline_dir / "mic.wav"
    if mic_wav.exists() and not args.force:
        print("  (cached) mic.wav")
    else:
        extract_audio_track(recording, mic_wav, track_index=1)
        print(f"  -> {mic_wav}")

    _stage("Voice activity detection (Silero)")
    vad_path = pipeline_dir / "vad.json"
    speech: list[Speech] = []
    if args.skip_vad:
        print("  skipped (--skip-vad)")
    elif (cached := _load_or_none(vad_path)) is not None and not args.force:
        speech = [Speech(s["startMs"], s["endMs"]) for s in cached]
        print(f"  (cached) {len(speech)} speech segments")
    elif not vad_available():
        print("  SKIPPED — silero-vad not installed (pip install -e \"pipeline[vad]\"). "
              "Mark windows will not extend to enclose dictated sentences.")
    else:
        speech = detect_speech(mic_wav)
        _write_json(vad_path, [{"startMs": s.start_ms, "endMs": s.end_ms} for s in speech])
        print(f"  {len(speech)} speech segments -> {vad_path.name}")

    _stage("Speech-to-text (faster-whisper)")
    transcript_path = pipeline_dir / "transcript.json"
    transcript: dict | None = None
    stt_ran = False
    if args.skip_stt:
        print("  skipped (--skip-stt)")
    elif (cached := _load_or_none(transcript_path)) is not None and not args.force:
        transcript = cached  # type: ignore[assignment]
        print(f"  (cached) {len(transcript.get('segments', []))} transcript segments")
    elif not stt_available():
        print("  SKIPPED — faster-whisper not installed (pip install -e \"pipeline[stt]\"). "
              "Notes will have empty text.")
    else:
        print(f"  transcribing with model '{args.model}' (this can take a few minutes)…")
        transcript = transcribe(mic_wav, model_size=args.model)
        _write_json(transcript_path, transcript)
        print(f"  {len(transcript['segments'])} segments -> {transcript_path.name}")
        stt_ran = True

    _stage("Plan segments (mark→segment policy §5.4)")
    pre_ms = round(args.pre * 1000)
    post_ms = round(args.post * 1000)
    per_mark: dict[str, Window] = {}
    for mark in anchored:
        w = window_for_mark(mark.id, mark.video_ms, duration_ms, pre_ms, post_ms)  # type: ignore[arg-type]
        per_mark[mark.id] = extend_to_speech(w, speech)
    vad_windows = (
        vad_only_windows(speech, list(per_mark.values()), duration_ms)
        if speech and not args.no_vad_notes
        else []
    )
    merged = plan_segments(list(per_mark.values()), vad_windows, round(args.merge_gap * 1000))
    kept_ms = sum(w.end_ms - w.start_ms for w in merged)
    print(f"  {len(per_mark)} mark windows + {len(vad_windows)} VAD-only windows "
          f"-> {len(merged)} merged segments, keeping {kept_ms / 1000:.0f}s "
          f"of {duration_ms / 1000:.0f}s ({100 * kept_ms / max(1, duration_ms):.0f}%)")

    _stage("Condensed export (FFmpeg cut + concat)")
    condensed: CondenseResult | None = None
    if merged:
        condensed = condense(
            recording, merged, pipeline_dir / "segments", report_dir / "condensed.mp4",
            reencode=args.reencode,
        )
        _write_json(
            pipeline_dir / "segments.json",
            {
                "requested": [
                    {"startMs": w.start_ms, "endMs": w.end_ms, "noteIds": list(w.note_ids)}
                    for w in merged
                ],
                "actual": [c.to_json() for c in condensed.cutmap],
            },
        )
        _write_json(report_dir / "cutmap.json", [c.to_json() for c in condensed.cutmap])
        print(f"  -> {condensed.condensed_path} ({condensed.condensed_duration_ms / 1000:.0f}s)")
    else:
        print("  no marks and no speech — skipping the cut; the report will reference "
              "the full original recording.")

    _stage("Report bundle")
    notes = report_mod.build_notes(session, per_mark, vad_windows, transcript)
    chapters = report_mod.build_chapters_vtt(merged, notes)
    if condensed:
        video_file, video_kind = "condensed.mp4", "condensed"
        video_duration = condensed.condensed_duration_ms
        cutmap = condensed.cutmap
    else:
        video_file, video_kind = recording.resolve().as_uri(), "original"
        video_duration = duration_ms
        cutmap = []
    report_data = report_mod.build_report_data(
        session, duration_ms, video_file, video_kind, video_duration,
        notes, merged, cutmap, transcript,
        dropped_marks=[
            {"id": m.id, "seq": m.seq, "label": m.label,
             "videoMs": m.video_ms, "gameTimeMs": m.game_time_ms}
            for m in beyond_eof
        ],
    )
    report_mod.write_report(report_dir, report_data, chapters, notes)
    print(f"  -> {report_dir / 'report.html'}")
    kit_dir = youtube_mod.write_kit(report_dir, report_data)
    print(f"  -> {kit_dir / 'description.txt'} (YouTube title + chapters)")
    report_mod.print_notes_summary(notes)

    # Cross-check the sidecar (source of truth) against the redundant MP4
    # chapters OBS wrote — chapters are absent after an OBS crash, which is fine.
    try:
        chapter_count = len(probe_chapters(recording))
        if chapter_count and chapter_count != len(anchored):
            print(f"\n  note: recording has {chapter_count} MP4 chapters vs "
                  f"{len(anchored)} sidecar marks (sidecar wins).")
    except Exception:
        pass

    print("\nDone. Open the report:")
    print(f"  {report_dir / 'report.html'}")
    if stt_ran:
        print(MODEL_TIP)
    youtube_mod.print_kit_instructions(kit_dir, report_dir)
    print("  (NOTION_TOKEN + PARENT_ID from .env or the environment; without --youtube the")
    print("   publisher falls back to a Notion file upload of condensed.mp4)")
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    session_dir = Path(args.session_dir).resolve()
    session = load_session(session_dir)
    print(f"{session.title}  ({session.id})")
    print(f"  started: {session.started_at_wall}")
    print(f"  target:  {session.capture_target_kind} {session.capture_target_name or ''}")
    print(f"  recording: {session.recording_file or '(unknown)'}")
    print(f"  marks: {len(session.marks)}")
    for m in session.marks:
        video = f"{m.video_ms / 1000:.1f}s" if m.video_ms is not None else "unanchored"
        game = f"  game={m.game_time_ms / 1000:.1f}s" if m.game_time_ms is not None else ""
        print(f"    #{m.seq} {m.label:<8} {video}{game}")
    return 0


def cmd_youtube_kit(args: argparse.Namespace) -> int:
    """Rebuild report/youtube/{title,description}.txt from an existing report
    bundle — no recording or ML stages needed (e.g. after tweaking notes)."""
    report_dir = Path(args.session_dir).resolve() / "report"
    data = _load_or_none(report_dir / "report_data.json")
    if not isinstance(data, dict):
        raise FileNotFoundError(f"no report bundle at {report_dir} — run `process` first")
    kit_dir = youtube_mod.write_kit(report_dir, data)
    print((kit_dir / "title.txt").read_text(encoding="utf-8").rstrip())
    print()
    print((kit_dir / "description.txt").read_text(encoding="utf-8").rstrip())
    print()
    youtube_mod.print_kit_instructions(kit_dir, report_dir)
    return 0


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to a legacy codepage; note text is arbitrary Unicode.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(prog="playtest-pipeline", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("process", help="run the full post-session pipeline")
    p.add_argument("session_dir")
    p.add_argument("--recording", help="override path to the OBS recording")
    p.add_argument("--skip-stt", action="store_true")
    p.add_argument("--skip-vad", action="store_true")
    p.add_argument("--no-vad-notes", action="store_true",
                   help="don't turn un-marked speech bursts into segments")
    p.add_argument("--reencode", action="store_true",
                   help="frame-exact cuts (slower); default is keyframe-snapped stream copy")
    p.add_argument("--pre", type=float, default=DEFAULT_PRE_MS / 1000,
                   help="seconds kept before each mark (default 20)")
    p.add_argument("--post", type=float, default=DEFAULT_POST_MS / 1000,
                   help="seconds kept after each mark (default 10)")
    p.add_argument("--merge-gap", type=float, default=DEFAULT_MERGE_GAP_MS / 1000,
                   help="merge segments closer than this many seconds (default 1)")
    p.add_argument("--model", default="small",
                   help="faster-whisper model size (default small): small on any machine; "
                        "medium for slightly better accuracy on a GPU (~2x slower, ~2 GB VRAM)")
    p.add_argument("--force", action="store_true", help="ignore cached stage outputs")
    p.set_defaults(func=cmd_process)

    p = sub.add_parser("inspect", help="print session sidecar summary")
    p.add_argument("session_dir")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("youtube-kit", help="regenerate report/youtube/*.txt from the report bundle")
    p.add_argument("session_dir")
    p.set_defaults(func=cmd_youtube_kit)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (FileNotFoundError, ValueError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
