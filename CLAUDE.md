This project is a tool that lets users record their screen using OBS, make notes with speech to text, mark points in their video, then finally export their condensed video + transcript into a notion page for sharing. This file is a directory: it holds only the rules every task needs and points at the docs for everything else. Keep it small — new detail goes into `.claude/docs/` or `tasks/lessons.md`, not here.

In files and in chat, including inside code blocks, Claude writes text as continuous lines with no hard wrapping at fixed column widths and no leading-space alignment. Structural formatting (headers, separators, indented lists) is fine.

## Where to look

| Doc | Covers | Open it when |
| --- | --- | --- |
| `tasks/lessons.md` | Running tally of gotchas hit by agents, with a promotion rule (below) | Before writing an `Assets/Editor` script, touching UI/ProBuilder/URP, or after being bitten by something non-obvious |

## Verifying changes

**Do not guess whether a change works — execute the code.** 

## Lessons — record, tally, promote

`tasks/lessons.md` is where an agent writes a gotcha it just hit. Every entry carries a `_seen: N · home: <path>_` line. The protocol:

1. Before adding a lesson, search the file for the same or a similar one. If it exists, increment `seen` (and sharpen the wording if you learned more) instead of adding a duplicate.
2. If it is new, add it with `seen: 1` and a `home` — the durable doc it belongs in once proven (`.claude/docs/<topic>.md`, or `CLAUDE.md` only for a rule every task needs). Name a new `.claude/docs/` file if no existing one fits.
3. At `seen >= 3` the lesson is promoted: `python hack/lessons.py` moves it out of `tasks/lessons.md` and appends it to its `home` (creating the file, and a pointer row in the table above, if needed). A Stop hook runs this automatically; run it by hand after editing the file.