"""Make a report bundle with N notes for the Notion >100-block / pacing test (PLAN M2).

    python hack/notion-stress-bundle.py <report_dir> <out_dir> [--notes 150]

Copies report_data.json (with the notes list padded to N synthetic notes) and
the small sidecar files into <out_dir>; condensed.mp4 is NOT copied, so
publish it with --no-upload:

    npx playtest-notion publish <out_dir> --parent-page <id> --no-upload

Expected: "Appending blocks (batch 1/2)…", "(batch 2/2)…" with the 350 ms
pacing, no 429 in the output, and a page with N note paragraphs.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("report_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--notes", type=int, default=150)
    args = ap.parse_args()

    src = Path(args.report_dir)
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    data = json.loads((src / "report_data.json").read_text(encoding="utf-8"))
    duration = data["session"]["originalDurationMs"]
    notes = list(data["notes"])
    for i in range(len(notes), args.notes):
        t = int(duration * (i + 1) / (args.notes + 1))
        notes.append(
            {
                "id": f"x{i}",
                "kind": "manual",
                "label": "mark" if i % 3 else "issue",
                "videoMs": t,
                "gameTimeMs": None,
                "text": f"Synthetic note {i} for the >100-block batching test.",
                "windowStartMs": max(0, t - 20000),
                "windowEndMs": min(duration, t + 10000),
            }
        )
    data["notes"] = notes
    data["session"]["title"] = f"{data['session']['title']} (stress {args.notes} notes)"
    (out / "report_data.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    for name in ("notes.json", "cutmap.json", "chapters.vtt"):
        if (src / name).exists():
            shutil.copy2(src / name, out / name)
    print(f"{out}: {len(notes)} notes -> publish with --no-upload")


if __name__ == "__main__":
    main()
