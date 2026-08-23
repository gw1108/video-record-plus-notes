"""Speech-to-text stage (optional extra: pip install -e "pipeline[stt]").

faster-whisper with word_timestamps=True gives word-level timing good enough
to snap note text to marks. (WhisperX forced alignment is the documented
upgrade path for tighter word timing + diarization — tech-stack report §4.2.)
Batch post-session by design: bigger model, zero frame-time impact (§4.1).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


def stt_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def transcribe(wav_path: Path, model_size: str = "small", device: str = "auto") -> dict[str, Any]:
    """Returns {"segments": [{startMs, endMs, text, words: [{startMs, endMs, text}]}]}."""
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device=device)
    segments_iter, info = model.transcribe(
        str(wav_path),
        word_timestamps=True,
        vad_filter=True,  # suppress hallucinated text over silence/game noise
    )
    segments = []
    for seg in segments_iter:
        words = [
            {"startMs": round(w.start * 1000), "endMs": round(w.end * 1000), "text": w.word.strip()}
            for w in (seg.words or [])
        ]
        segments.append(
            {
                "startMs": round(seg.start * 1000),
                "endMs": round(seg.end * 1000),
                "text": seg.text.strip(),
                "words": words,
            }
        )
    return {
        "language": getattr(info, "language", None),
        "model": model_size,
        "segments": segments,
    }
