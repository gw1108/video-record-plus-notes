"""Mark -> segment planning (tech-stack report §5.4). Pure logic, unit-tested.

A mark is an instant, pressed AFTER the interesting moment (the replay-buffer
premise): default window [mark - 20s, mark + 10s]. Windows are extended to
enclose any overlapping VAD speech segment so a dictated note is never cut
mid-sentence, then overlapping/near-adjacent windows merge. VAD speech bursts
without a mark optionally become candidate segments of their own.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

DEFAULT_PRE_MS = 20_000
DEFAULT_POST_MS = 10_000
DEFAULT_MERGE_GAP_MS = 1_000
VAD_ONLY_PAD_MS = 2_000


@dataclass(frozen=True)
class Speech:
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class Window:
    start_ms: int
    end_ms: int
    note_ids: tuple[str, ...]

    def overlaps(self, start_ms: int, end_ms: int) -> bool:
        return self.start_ms < end_ms and start_ms < self.end_ms


def window_for_mark(
    mark_id: str,
    video_ms: int,
    duration_ms: int,
    pre_ms: int = DEFAULT_PRE_MS,
    post_ms: int = DEFAULT_POST_MS,
) -> Window:
    # A mark anchored past end-of-file (calibrated marks after an OBS crash,
    # on a shorter salvaged MP4) must not produce start > end: clamp both.
    return Window(
        start_ms=max(0, min(video_ms - pre_ms, duration_ms)),
        end_ms=min(duration_ms, video_ms + post_ms),
        note_ids=(mark_id,),
    )


def extend_to_speech(window: Window, speech: list[Speech]) -> Window:
    """Grow the window until it fully encloses every speech segment it touches.

    Iterates to a fixpoint: enclosing one segment can bring the window into
    contact with the next. Bounded by the number of speech segments.
    """
    current = window
    for _ in range(len(speech) + 1):
        changed = False
        for seg in speech:
            if current.overlaps(seg.start_ms, seg.end_ms):
                new_start = min(current.start_ms, seg.start_ms)
                new_end = max(current.end_ms, seg.end_ms)
                if (new_start, new_end) != (current.start_ms, current.end_ms):
                    current = replace(current, start_ms=new_start, end_ms=new_end)
                    changed = True
        if not changed:
            break
    return current


def merge_windows(windows: list[Window], merge_gap_ms: int = DEFAULT_MERGE_GAP_MS) -> list[Window]:
    """Merge overlapping or near-adjacent windows, combining note ids."""
    if not windows:
        return []
    ordered = sorted(windows, key=lambda w: (w.start_ms, w.end_ms))
    merged: list[Window] = [ordered[0]]
    for w in ordered[1:]:
        last = merged[-1]
        if w.start_ms <= last.end_ms + merge_gap_ms:
            merged[-1] = Window(
                start_ms=last.start_ms,
                end_ms=max(last.end_ms, w.end_ms),
                note_ids=tuple(dict.fromkeys(last.note_ids + w.note_ids)),
            )
        else:
            merged.append(w)
    return merged


def vad_only_windows(
    speech: list[Speech],
    mark_windows: list[Window],
    duration_ms: int,
    pad_ms: int = VAD_ONLY_PAD_MS,
    min_speech_ms: int = 1_500,
) -> list[Window]:
    """Speech bursts not covered by any mark window become 'vad' candidate
    segments (the "significant audio activity" auto-highlights, §4.2)."""
    out: list[Window] = []
    for i, seg in enumerate(speech):
        if seg.end_ms - seg.start_ms < min_speech_ms:
            continue
        if any(w.overlaps(seg.start_ms, seg.end_ms) for w in mark_windows):
            continue
        out.append(
            Window(
                start_ms=max(0, seg.start_ms - pad_ms),
                end_ms=min(duration_ms, seg.end_ms + pad_ms),
                note_ids=(f"v{i + 1}",),
            )
        )
    return out


def plan_segments(
    mark_windows: list[Window],
    vad_windows: list[Window],
    merge_gap_ms: int = DEFAULT_MERGE_GAP_MS,
) -> list[Window]:
    """Final cut list: all windows merged, in chronological order."""
    return merge_windows([*mark_windows, *vad_windows], merge_gap_ms)
