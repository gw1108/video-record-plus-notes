"""ffmpeg/ffprobe helpers. The pipeline uses FFmpeg only as a separate post-session process.

Binary lookup, first hit wins:
  1. `$PLAYTEST_FFMPEG_DIR/ffmpeg[.exe]` — explicit override;
  2. `playtest_pipeline/bin/ffmpeg[.exe]` — included in the selected Windows release wheel;
  3. `ffmpeg` on PATH for source/editable installs.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

FFMPEG_DIR_ENV_VAR = "PLAYTEST_FFMPEG_DIR"
BUNDLED_BIN_DIR = Path(__file__).resolve().parent / "bin"


class FfmpegError(RuntimeError):
    pass


@lru_cache(maxsize=None)
def resolve_tool(name: str) -> str:
    """Absolute path to `ffmpeg`/`ffprobe` per the lookup order above, or the
    bare name (PATH lookup at call time) when none of the fixed dirs has it."""
    exe = f"{name}.exe" if sys.platform == "win32" else name
    override = os.environ.get(FFMPEG_DIR_ENV_VAR)
    candidates = [Path(override) / exe] if override else []
    candidates.append(BUNDLED_BIN_DIR / exe)
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return shutil.which(name) or name


def tool_origin(name: str = "ffmpeg") -> str:
    """Human-readable provenance for logs/`inspect` ("env", "bundled", "PATH")."""
    path = resolve_tool(name)
    override = os.environ.get(FFMPEG_DIR_ENV_VAR)
    if override and Path(path).parent == Path(override):
        return f"{FFMPEG_DIR_ENV_VAR} ({path})"
    if Path(path).parent == BUNDLED_BIN_DIR:
        return f"bundled ({path})"
    return f"PATH ({path})"


def _run(cmd: list[str]) -> str:
    cmd = [resolve_tool(cmd[0]), *cmd[1:]]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise FfmpegError(
            f"{cmd[0]} failed ({result.returncode}): {' '.join(cmd)}\n{result.stderr[-2000:]}"
        )
    return result.stdout


def run_ffmpeg(args: list[str]) -> None:
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args])


def probe_json(path: Path, *extra: str) -> dict:
    out = _run([
        "ffprobe", "-v", "error", "-of", "json",
        *extra,
        str(path),
    ])
    return json.loads(out)


def probe_duration_ms(path: Path) -> int:
    data = probe_json(path, "-show_entries", "format=duration")
    return round(float(data["format"]["duration"]) * 1000)


def probe_audio_stream_count(path: Path) -> int:
    data = probe_json(path, "-select_streams", "a", "-show_entries", "stream=index")
    return len(data.get("streams", []))


def probe_chapters(path: Path) -> list[dict]:
    """MP4 chapters OBS wrote via CreateRecordChapter (redundant copy of the
    sidecar marks; used only for cross-checking)."""
    data = probe_json(path, "-show_chapters")
    return data.get("chapters", [])


def extract_audio_track(src: Path, out_wav: Path, track_index: int = 1) -> int:
    """Extract one audio track as 16 kHz mono PCM for VAD/STT.

    `track_index` is 0-based among audio streams. The recommended OBS profile
    puts the mic alone on track 2 (audio stream index 1); if the recording has
    only one audio track, fall back to it with a warning. Returns the index
    actually used.
    """
    available = probe_audio_stream_count(src)
    if available == 0:
        raise FfmpegError(f"No audio streams in {src}")
    used = track_index if track_index < available else 0
    if used != track_index:
        print(
            f"  WARNING: recording has {available} audio track(s); wanted a:{track_index} (mic), "
            f"using a:{used} (mixed audio — STT quality may suffer from game-audio bleed)"
        )
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg([
        "-i", str(src),
        "-map", f"0:a:{used}",
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(out_wav),
    ])
    return used


def keyframes_between(src: Path, from_s: float, to_s: float) -> list[float]:
    """Video keyframe timestamps (seconds) in [from_s, to_s], via packet flags.

    Used to discover the ACTUAL start of a stream-copied cut: ffmpeg -ss with
    -c copy snaps to the keyframe at or before the requested time (§5.4).
    """
    from_s = max(0.0, from_s)
    out = _run([
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "packet=pts_time,flags",
        "-of", "csv=p=0",
        "-read_intervals", f"{from_s}%{to_s}",
        str(src),
    ])
    keyframes: list[float] = []
    for line in out.splitlines():
        parts = line.strip().split(",")
        if len(parts) >= 2 and "K" in parts[1]:
            try:
                keyframes.append(float(parts[0]))
            except ValueError:
                continue
    return sorted(keyframes)


def keyframe_at_or_before(src: Path, at_s: float, max_gop_s: float = 30.0) -> float:
    """Latest keyframe <= at_s (small epsilon for float pts). Falls back to 0.0."""
    eps = 0.001
    for lookback in (10.0, max_gop_s, max_gop_s * 4):
        frames = keyframes_between(src, at_s - lookback, at_s + eps)
        candidates = [k for k in frames if k <= at_s + eps]
        if candidates:
            return max(candidates)
    return 0.0


def has_encoder(name: str) -> bool:
    try:
        out = _run(["ffmpeg", "-hide_banner", "-encoders"])
    except FfmpegError:
        return False
    return any(line.split()[1:2] == [name] for line in out.splitlines() if line.strip())
