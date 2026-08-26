# deploy — hosting a report bundle

A session's `report/` directory is a complete static site:

```
report/
  report.html        self-contained player page (data inlined; no other assets)
  condensed.mp4      the edited-down video — can be hundreds of MB
  chapters.vtt       WebVTT chapters (kept ranges + note payload)
  report_data.json   the data blob that report.html already inlines
  notes.json, cutmap.json
```

Any static server that honors **HTTP Range** requests (needed for seeking a
large faststart MP4) is enough — tech-stack report §5.5. No HLS, no app server.

## Path A — self-hosted, no Notion (first-class)

1. Copy the `report/` dir (or the whole sessions folder) to the host, e.g.
   `/srv/playtest/<session-id>/report/`.
2. Serve it with one of the configs here — edit `server_name`/hostname and `root`:
   - **nginx:** `deploy/nginx.conf` → `/etc/nginx/conf.d/playtest.conf`, then
     `nginx -t && nginx -s reload`. nginx serves static files with Range
     support by default; the config only adds MIME types, the framing
     header, and `gzip off` for `.mp4`.
   - **Caddy:** `deploy/Caddyfile` → `caddy run --config Caddyfile`
     (automatic HTTPS with a real hostname).
3. Open `https://<host>/<session-id>/report/report.html`. Done — seek↔notes
   sync, segment skip, transcript, and `?t=<seconds>` deep links all work
   from this page alone (see `packages/player-embed/README.md`).

The same page also works straight from disk (`file://`), so "hosting" is only
needed to share it.

## Notion page, default route — unlisted YouTube upload (no hosting)

The Notion page does not need a hosted report at all: the video carrier is
an **unlisted YouTube upload** of `condensed.mp4` (tech-stack §5.0, decision
2026-08-23). Three manual steps, ≈ 1 minute:

1. YouTube Studio → *Create → Upload videos* → drop `<session>\report\condensed.mp4`.
2. Title from `report\youtube\title.txt`; paste `report\youtube\description.txt`
   into *Description* (its timestamp list becomes the chapter bar — `0:00`
   first, ≥ 3 chapters, ≥ 10 s each, all guaranteed by the pipeline);
   *Audience*: not made for kids; *Visibility*: **Unlisted**. Copy the
   `https://youtu.be/<id>` link.
3. ```powershell
   playtest-notion publish "<session>\report" --youtube https://youtu.be/<id>
   ```
   The page gets a `video` block on the watch URL (the real YouTube player),
   and every note's `[m:ss]` becomes `https://youtu.be/<id>?t=<condensed s>`.
   The Notion file upload is skipped; it remains the fallback when no
   `--youtube` is given (paid workspaces only — free plans cap uploads at
   5 MiB).

Paths A–C below are for teams that self-host (NDA footage, or the
bidirectional seek↔notes widget inside Notion).

## Path B — Notion page with the embedded widget (Tier 3)

Host the report exactly as in Path A, then publish with the widget URL:

```powershell
# NOTION_TOKEN + PARENT_ID from .env (see .env.example) or the environment
playtest-notion publish "<session>\report" `
  --embed-url https://<host>/<session-id>/report/report.html
```

`--embed-url` does two things: adds an embed block pointing at the hosted
page, and turns every note's `[mm:ss]` into a Tier-2 link
`…/report.html?t=<original-seconds>` that opens the page seeked to that
moment. Combined with `--youtube`, the page link stays on the timestamp and
a `▶` after it carries the YouTube deep link.

**Framing caveat (tech-stack §5.0):** Notion renders API-created embed
blocks as plain iframes and *skips* its iFramely embeddability validation —
the API accepts any URL, and if the host refuses framing the block silently
renders blank for viewers. Both configs therefore send **no
`X-Frame-Options`** and
`Content-Security-Policy: frame-ancestors 'self' https://*.notion.so https://*.notion.com https://*.notion.site`
(Notion pages open on `app.notion.com` since 2026; `*.notion.so` alone leaves the embed blank).
Requirements: the URL must be **https** (Notion is https; mixed content is
blocked) and reachable by whoever opens the page (public or intranet).

**Manual verification step (a human must do this once per host):** open the
published Notion page in a browser and confirm the embed actually renders and
plays; then click one note's timestamp link and confirm the page opens seeked
to that time. The publisher cannot detect a blank embed.

## Path C — quick public https from the dev PC (no server; for the Tier-3 check)

Serves one report dir from this machine through a temporary Cloudflare quick
tunnel. Nothing to buy or configure; the URL dies when you stop cloudflared.

```powershell
winget install CaddyServer.Caddy; winget install Cloudflare.cloudflared   # once
$REPORT = "C:\Users\<you>\Videos\PlaytestSessions\<session>\report"
(Get-Content deploy\Caddyfile) -replace '^reports\.example\.com \{', ':8080 {' `
  -replace 'root \* /srv/playtest.*', "root * `"$($REPORT -replace '\\','/')`"" |
  Set-Content "$env:TEMP\Caddyfile"
Start-Process caddy -ArgumentList "run --config $env:TEMP\Caddyfile --adapter caddyfile"
cloudflared tunnel --url http://localhost:8080      # prints https://<random>.trycloudflare.com
```

Check `https://<random>.trycloudflare.com/report.html` plays in a normal tab,
then publish with `--embed-url https://<random>.trycloudflare.com/report.html`
(`--no-upload` if the workspace is on the Free plan). Stop with `Ctrl+C` on
cloudflared and `caddy stop`. Verified 2026-08-23 up to the tunnel step
(`verification/evidence/m3/local-headers.txt`: CSP present, no `X-Frame-Options`, `206`
Range replies, `video/mp4` + `text/vtt`).

## Notes

- Don't gzip `.mp4` (already compressed; on-the-fly gzip breaks Range).
  nginx only gzips `gzip_types` (text/html by default) anyway; Caddy doesn't
  compress unless `encode` is configured.
- MIME: `.mp4` → `video/mp4`, `.vtt` → `text/vtt` — both configs set them
  explicitly so the player and any VTT-aware tool get the right types.
- `report_data.json` is only needed by the Notion publisher (it reads the
  bundle from disk); the page never fetches it.
