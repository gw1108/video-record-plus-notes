"""Physically condensed export — this IS the edited-down video (§5.4).

Stream-copy cuts snap to keyframes, so the cut map is built from the ACTUAL
post-snap boundaries (keyframe probe + ffprobe of each emitted segment), never
from the requested times — requested times would be silently wrong by up to a
GOP per segment and corrupt every note lookup downstream.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .media import (
    has_encoder,
    keyframe_at_or_before,
    probe_audio_stream_count,
    probe_duration_ms,
    run_ffmpeg,
)
from .plan import Window

END_PAD_MS = 500  # never trim the tail of a dictated note at a packet boundary


@dataclass
class CutSegment:
    original_start_ms: int
    original_end_ms: int
    condensed_start_ms: int
    condensed_end_ms: int

    def to_json(self) -> dict:
        return {
            "originalStartMs": self.original_start_ms,
            "originalEndMs": self.original_end_ms,
            "condensedStartMs": self.condensed_start_ms,
            "condensedEndMs": self.condensed_end_ms,
        }


@dataclass
class CondenseResult:
    condensed_path: Path
    condensed_duration_ms: int
    cutmap: list[CutSegment]


def build_cutmap(actual_bounds: list[tuple[int, int]]) -> list[CutSegment]:
    """Pure cut-map arithmetic from actual (start_ms, duration_ms) per segment."""
    cutmap: list[CutSegment] = []
    cursor = 0
    for start_ms, duration_ms in actual_bounds:
        cutmap.append(
            CutSegment(
                original_start_ms=start_ms,
                original_end_ms=start_ms + duration_ms,
                condensed_start_ms=cursor,
                condensed_end_ms=cursor + duration_ms,
            )
        )
        cursor += duration_ms
    return cutmap


def merge_colliding_starts(
    starts_s: list[float],
    windows: list[Window],
    end_pad_ms: int = END_PAD_MS,
) -> list[tuple[float, Window]]:
    """Merge windows whose actual cut start lands inside the previous segment's
    emitted span [start, end + pad].

    Stream-copy starts snap to the keyframe at or before the requested time
    (up to a GOP earlier), so two windows that survived plan-level merging can
    still collide here — the condensed video would then play the shared span
    twice and the cut map would contain overlapping original ranges, breaking
    note-sync near the overlap. Pure logic, unit-tested.
    """
    out: list[tuple[float, Window]] = []
    for start_s, w in zip(starts_s, windows):
        if out:
            prev_start_s, prev_w = out[-1]
            if start_s <= (prev_w.end_ms + end_pad_ms) / 1000:
                out[-1] = (
                    prev_start_s,
                    Window(
                        start_ms=prev_w.start_ms,
                        end_ms=max(prev_w.end_ms, w.end_ms),
                        note_ids=tuple(dict.fromkeys(prev_w.note_ids + w.note_ids)),
                    ),
                )
                continue
        out.append((start_s, w))
    return out


def concat_entry(p: Path) -> str:
    """concat-demuxer list line; single quotes in the path (e.g. C:/Users/O'Brien)
    escape per the demuxer's shell-like rule: close quote, \\', reopen."""
    return "file '{}'\n".format(p.resolve().as_posix().replace("'", "'\\''"))


def _pick_video_encoder() -> list[str]:
    if has_encoder("h264_nvenc"):
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "19"]
    # libx264 exists only in GPL ffmpeg builds; fine for local use, but a
    # shipped product must bundle an LGPL build + hardware encoders (§6.2).
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19"]


def _audio_args(audio_count: int, stream_copy_single: bool) -> list[str]:
    """Audio handling for a segment cut.

    With 2+ tracks (game on 1, mic on 2 per the recommended routing) ALL of
    them are mixed into one AAC track: mapping only 0:a:0 silences dictated
    notes, and a second MP4 track wouldn't help — browser <video> (the report
    player) and Notion play only the default audio track. Audio re-encode is
    cheap; the video stream is unaffected. A single track is copied verbatim
    in stream-copy mode.
    """
    if audio_count >= 2:
        labels = "".join(f"[0:a:{i}]" for i in range(audio_count))
        return [
            "-filter_complex",
            f"{labels}amix=inputs={audio_count}:duration=longest:normalize=0[aout]",
            "-map", "[aout]",
            "-c:a", "aac", "-b:a", "160k",
        ]
    if audio_count == 1:
        if stream_copy_single:
            return ["-map", "0:a:0", "-c:a", "copy"]
        return ["-map", "0:a:0", "-c:a", "aac", "-b:a", "160k"]
    return []


def condense(
    recording: Path,
    windows: list[Window],
    work_dir: Path,
    out_path: Path,
    reencode: bool = False,
) -> CondenseResult:
    if not windows:
        raise ValueError("No segments to cut")
    work_dir.mkdir(parents=True, exist_ok=True)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    audio_count = probe_audio_stream_count(recording)
    audio_args = _audio_args(audio_count, stream_copy_single=not reencode)
    actual_bounds: list[tuple[int, int]] = []
    seg_paths: list[Path] = []

    if reencode:
        # Frame-exact: input seek + re-encode decodes from the prior keyframe
        # and drops up to the requested instant.
        starts_s = [w.start_ms / 1000 for w in windows]
    else:
        # Stream copy: discover the keyframe the cut will snap to, then cut
        # exactly there so -t is measured from a known origin.
        starts_s = [keyframe_at_or_before(recording, w.start_ms / 1000) for w in windows]
    cut_list = merge_colliding_starts(starts_s, windows)
    if len(cut_list) < len(windows):
        print(
            f"  merged {len(windows) - len(cut_list)} segment(s) whose cut start "
            "landed inside the previous segment (keyframe snap-back)"
        )

    for i, (start_s, w) in enumerate(cut_list):
        seg_path = work_dir / f"seg_{i:03d}.mp4"
        end_s = (w.end_ms + END_PAD_MS) / 1000
        if reencode:
            run_ffmpeg([
                "-ss", f"{start_s:.3f}", "-i", str(recording),
                "-t", f"{max(0.1, end_s - start_s):.3f}",
                "-map", "0:v:0", *audio_args,
                *_pick_video_encoder(),
                str(seg_path),
            ])
        else:
            # Video is stream-copied; audio goes through _audio_args (mixed
            # when the mic is on its own track).
            run_ffmpeg([
                "-ss", f"{start_s:.3f}", "-i", str(recording),
                "-t", f"{max(0.1, end_s - start_s):.3f}",
                "-map", "0:v:0", *audio_args,
                "-c:v", "copy",
                "-avoid_negative_ts", "make_zero",
                str(seg_path),
            ])
        actual_start_ms = round(start_s * 1000)
        actual_duration_ms = probe_duration_ms(seg_path)
        actual_bounds.append((actual_start_ms, actual_duration_ms))
        seg_paths.append(seg_path)
        print(
            f"  segment {i + 1}/{len(cut_list)}: requested {w.start_ms}-{w.end_ms}ms, "
            f"actual {actual_start_ms}-{actual_start_ms + actual_duration_ms}ms"
        )

    list_file = work_dir / "concat.txt"
    list_file.write_text("".join(concat_entry(p) for p in seg_paths), encoding="utf-8")
    run_ffmpeg([
        "-f", "concat", "-safe", "0",
        "-i", str(list_file),
        "-c", "copy",
        "-movflags", "+faststart",
        str(out_path),
    ])

    return CondenseResult(
        condensed_path=out_path,
        condensed_duration_ms=probe_duration_ms(out_path),
        cutmap=build_cutmap(actual_bounds),
    )
