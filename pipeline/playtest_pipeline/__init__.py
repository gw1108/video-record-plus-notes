"""Post-session pipeline for the playtest recorder.

Stages (all batch, never during recording — perf report §1):
  extract mic track -> VAD -> STT -> merge notes -> condensed cut + cut map
  -> report bundle (self-contained player page) -> Notion handoff.
"""

__version__ = "0.1.0"
