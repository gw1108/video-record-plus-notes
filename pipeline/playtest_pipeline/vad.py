"""Silero VAD stage (optional extra: pip install -e "pipeline[vad]").

Detects speech segments in the extracted mic track. Powers both the
"never cut a dictated note mid-sentence" window extension and the
speech-without-a-mark auto-highlights (tech-stack report §4.2).
"""

from __future__ import annotations

import wave
from pathlib import Path

from .plan import Speech

SAMPLE_RATE = 16_000
MIN_SPEECH_MS = 300
SPEECH_PAD_MS = 150
# A dictated note ("Note. The door collision feels sticky…") carries a natural
# ~0.6–0.7 s pause after the lead-in word; at 700 ms every M1 note came out as
# two segments. Separate utterances in a playtest are seconds apart, so 1 s
# keeps one sentence = one segment without merging unrelated speech.
MIN_SILENCE_MS = 1_000


def vad_available() -> bool:
    try:
        import silero_vad  # noqa: F401
        return True
    except ImportError:
        return False


def _read_mic_wav(wav_path: Path):
    """mic.wav is always 16 kHz mono s16le (media.extract_audio_track), so read
    it with the stdlib. silero's own read_audio goes through torchaudio, whose
    I/O backend (torchcodec on torchaudio >= 2.9) is not part of the extra."""
    import torch

    with wave.open(str(wav_path), "rb") as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, SAMPLE_RATE):
            raise ValueError(f"{wav_path} must be 16 kHz mono 16-bit PCM, got {w.getparams()}")
        frames = w.readframes(w.getnframes())
    return torch.frombuffer(bytearray(frames), dtype=torch.int16).float() / 32768.0


def detect_speech(wav_path: Path) -> list[Speech]:
    from silero_vad import get_speech_timestamps, load_silero_vad

    model = load_silero_vad()
    audio = _read_mic_wav(wav_path)
    stamps = get_speech_timestamps(
        audio,
        model,
        sampling_rate=SAMPLE_RATE,
        min_speech_duration_ms=MIN_SPEECH_MS,
        min_silence_duration_ms=MIN_SILENCE_MS,
        speech_pad_ms=SPEECH_PAD_MS,
    )
    # Sample offsets -> ms (return_seconds=True would round to 0.1 s).
    return [
        Speech(start_ms=round(s["start"] * 1000 / SAMPLE_RATE), end_ms=round(s["end"] * 1000 / SAMPLE_RATE))
        for s in stamps
    ]
