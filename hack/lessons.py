#!/usr/bin/env python3
"""Promote proven lessons out of tasks/lessons.md into their durable home docs.

Entry format in tasks/lessons.md:

    ### Title
    _seen: N · home: relative/path.md_
    One paragraph of body.

Any entry with seen >= THRESHOLD is removed from tasks/lessons.md and appended to its home
file under a "## Promoted lessons" heading (the file is created if missing). If the home is a
new .claude/docs/ file, a pointer row is added to the "Where to look" table in CLAUDE.md so
agents can find it.

Usage: python hack/lessons.py [--check] [--threshold N] [--quiet]
  --check   report what would be promoted, change nothing (exit 0 either way)
  --quiet   print nothing unless something was promoted (for the Stop hook)
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LESSONS = ROOT / "tasks" / "lessons.md"
CLAUDE_MD = ROOT / "CLAUDE.md"
THRESHOLD = 3
PROMOTED_HEADING = "## Promoted lessons"
META_RE = re.compile(r"^_seen:\s*(\d+)\s*[·\-|,]\s*home:\s*(\S+?)_?\s*$")


class Lesson:
    def __init__(self, title: str, seen: int, home: str, body: str, raw: str):
        self.title, self.seen, self.home, self.body, self.raw = title, seen, home, body, raw


def parse(text: str) -> tuple[str, list[Lesson]]:
    """Split the file into (preamble, lessons). Preamble is everything before the first ###."""
    parts = re.split(r"(?m)^(?=### )", text)
    preamble, chunks = parts[0], parts[1:]
    lessons: list[Lesson] = []
    for chunk in chunks:
        lines = chunk.rstrip("\n").split("\n")
        title = lines[0][4:].strip()
        seen, home, body_start = 1, "", 1
        if len(lines) > 1:
            m = META_RE.match(lines[1].strip())
            if m:
                seen, home, body_start = int(m.group(1)), m.group(2), 2
        body = "\n".join(lines[body_start:]).strip()
        lessons.append(Lesson(title, seen, home, body, chunk))
    return preamble, lessons


def append_to_home(home: Path, lesson: Lesson) -> bool:
    """Append the lesson to its home doc. Returns True if the file was newly created."""
    created = not home.exists()
    if created:
        home.parent.mkdir(parents=True, exist_ok=True)
        stem = home.stem.replace("-", " ").replace("_", " ")
        text = f"# {stem[:1].upper()}{stem[1:]}\n\nLessons promoted from `tasks/lessons.md` after being hit by three or more agents.\n\n{PROMOTED_HEADING}\n"
    else:
        text = home.read_text(encoding="utf-8")
        if PROMOTED_HEADING not in text:
            text = text.rstrip("\n") + f"\n\n{PROMOTED_HEADING}\n"
    text = text.rstrip("\n") + f"\n\n### {lesson.title}\n{lesson.body}\n"
    home.write_text(text, encoding="utf-8")
    return created


def add_pointer_row(home_rel: str) -> None:
    """Add a row for a newly created doc to the 'Where to look' table in CLAUDE.md."""
    text = CLAUDE_MD.read_text(encoding="utf-8")
    if f"`{home_rel}`" in text:
        return
    lines = text.split("\n")
    last_row = -1
    in_table = False
    for i, line in enumerate(lines):
        if line.startswith("| Doc |"):
            in_table = True
        elif in_table and line.startswith("|"):
            last_row = i
        elif in_table and last_row >= 0 and not line.startswith("|"):
            break
    row = f"| `{home_rel}` | Lessons promoted from `tasks/lessons.md` (fill in a summary) | Working in the area the file name describes |"
    if last_row >= 0:
        lines.insert(last_row + 1, row)
        CLAUDE_MD.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--threshold", type=int, default=THRESHOLD)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not LESSONS.exists():
        if not args.quiet:
            print(f"no {LESSONS.relative_to(ROOT)}")
        return 0
    text = LESSONS.read_text(encoding="utf-8")
    preamble, lessons = parse(text)
    ready = [l for l in lessons if l.seen >= args.threshold]
    missing_home = [l for l in ready if not l.home]

    if not ready:
        if not args.quiet:
            print(f"{len(lessons)} lessons, none at seen >= {args.threshold}")
        return 0

    for l in missing_home:
        print(f"NOT promoted (no home): {l.title} (seen {l.seen}) — add a `home:` path", file=sys.stderr)
    ready = [l for l in ready if l.home]

    if args.check:
        for l in ready:
            print(f"would promote: {l.title} (seen {l.seen}) -> {l.home}")
        return 0

    kept = [l for l in lessons if l not in ready]
    for l in ready:
        home = (ROOT / l.home).resolve()
        created = append_to_home(home, l)
        if created:
            add_pointer_row(l.home)
        print(f"promoted: {l.title} (seen {l.seen}) -> {l.home}{' (new file, CLAUDE.md row added)' if created else ''}")

    new_text = preamble.rstrip("\n") + "\n" + "".join("\n" + l.raw.rstrip("\n") + "\n" for l in kept)
    LESSONS.write_text(new_text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
