# player-embed

The self-contained report page — the **first-class self-hosted output** of the
pipeline (tech-stack report §5.0), and the same page that later serves as the
Tier-3 embedded widget inside a Notion page.

`report-template.html` carries a `/*__REPORT_DATA__*/null` placeholder;
`playtest-pipeline` (report.py) replaces it with the `report_data.json` blob
and writes the result as `<session>/report/report.html`. Data is inlined
because `file://` pages cannot fetch sibling JSON.

## What the page implements

- **Segment-skip module (§5.1)** — the ~30-line `timeupdate`/`seeked` pattern:
  when the playhead leaves a marked range, jump to the next range's start,
  with a "play everything" toggle. Active when the page serves the FULL
  recording; a physically condensed file disables it (everything is marked).
- **Note-sync** — scrubbing highlights (and scrolls to) the notes whose window
  contains the playhead; clicking a note seeks the video. All note timestamps
  display **original-recording time**; on a condensed file, the cut map
  (built from actual post-keyframe-snap boundaries, §5.4) translates both
  directions.
- **Timeline marker strip** — kept ranges + a tick per note (red = manual
  mark, yellow = VAD speech), clickable.
- **Interactive transcript** — Hyperaudio-Lite-style click-to-seek with
  word-level highlight when word timestamps exist.

## Deep links

`report.html?t=<seconds>` opens the page seeked to that moment. `t` is
**original-recording seconds** — the same domain as the displayed note
timestamps — and is translated through the cut map, so a `t` that falls in a
cut-out gap snaps to the start of the next kept segment; a `t` past the end
of the recording does nothing. This is what the Notion publisher's Tier-2
timestamp links emit (`?t=${floor(note.videoMs / 1000)}`).

- Accepted forms: `?t=95`, `?t=95.5`, `?t=1m35s`, `?t=1h2m3s`; `#t=95` in the
  hash works as a fallback.
- The seek waits for `loadedmetadata`; playback is then attempted, and if the
  browser blocks autoplay the playhead is still positioned and the matching
  note highlighted/scrolled (note-sync runs on `seeked`).

## Hosting

- Works opened directly from disk (`file://`) and behind any static server
  honoring HTTP Range requests (nginx is plenty — §5.5).
- Copy-pasteable nginx and Caddy configs, plus the self-host-pure and Notion
  Tier-3 recipes, live in [`deploy/`](../../deploy/README.md).
- **Notion Tier-3 embedding (§5.0):** the server must NOT send
  `X-Frame-Options` and its CSP `frame-ancestors` must allow
  `https://*.notion.so https://*.notion.com https://*.notion.site` — API-created embed blocks skip Notion's
  embeddability validation and silently fail to render otherwise. The
  `deploy/` configs do this; verify rendering inside Notion once manually.

## Planned upgrades (not blockers)

- Swap the native `<video>` chrome for **Vidstack** (MIT) — chapter rendering
  in the time slider; point-markers still need a custom overlay
  ([vidstack#1660](https://github.com/vidstack/player/issues/1660)), which the
  strip here already implements.
- Swap the transcript block for **Hyperaudio Lite** proper (MIT viewer only —
  its *editor* sibling is AGPL/commercial, do not vendor it).
