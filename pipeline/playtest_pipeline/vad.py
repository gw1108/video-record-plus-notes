"""Silero VAD stage (optional extra: pip install -e "pipeline[vad]").

Detects speech segments in the extracted mic track. Powers both the
"never cut a dictated note mid-sentence" window extension and the
speech-without-a-mark auto-highlights (tech-stack report §4.2).
"""

from __future__ import annotations

from pathlib import Path

from .plan import Speech


def vad_available() -> bool:
    try:
        import silero_vad  # noqa: F401
        return True
    except ImportError:
        return False


def detect_speech(wav_path: Path) -> list[Speech]:
    from silero_vad import get_speech_timestamps, load_silero_vad, read_audio

    model = load_silero_vad()
    audio = read_audio(str(wav_path), sampling_rate=16000)
    stamps = get_speech_timestamps(
        audio,
        model,
        sampling_rate=16000,
        return_seconds=True,
        min_speech_duration_ms=300,
        min_silence_duration_ms=700,
        speech_pad_ms=150,
    )
    return [Speech(start_ms=round(s["start"] * 1000), end_ms=round(s["end"] * 1000)) for s in stamps]
