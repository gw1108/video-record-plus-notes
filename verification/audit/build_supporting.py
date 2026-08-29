"""Builds supporting.html for the YouTube API compliance form from REAL output.

    python verification/audit/build_supporting.py [session_dir]

The request body on the page is not transcribed by hand: it is captured from
`playtest-youtube upload <session> --json --dry-run`, which prints the exact
body the uploader would pass to videos.insert. Re-run this whenever the
uploader changes so the evidence cannot drift from the code.
"""

from __future__ import annotations

import html
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DEFAULT_SESSION = Path(r"C:\Users\George\Videos\PlaytestSessions\2026-08-27_161319_golden-path-gw-2026-08-27")
SCREENSHOT = "../evidence/m2.4/02-publish-dialog.png"

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Playtest Recorder — what videos.insert receives</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #fff; font-family: "Segoe UI", system-ui, sans-serif; color: #1a1d21; }}
  .canvas {{ width: 1600px; height: 1250px; padding: 36px 40px; }}
  h1 {{ font-size: 27px; font-weight: 650; letter-spacing: -0.2px; }}
  .sub {{ font-size: 16px; color: #55606d; margin-top: 7px; line-height: 1.5; }}
  .cols {{ display: flex; gap: 26px; margin-top: 22px; }}
  .left {{ width: 660px; flex: none; }}
  .right {{ flex: 1; }}
  h2 {{ font-size: 17px; font-weight: 650; margin-bottom: 9px; }}
  figure {{ border: 1.5px solid #c5cdd6; border-radius: 9px; overflow: hidden; background: #f7f9fb; }}
  .crop {{ position: relative; width: 100%; height: 604px; overflow: hidden; background: #14161a; }}
  .crop img {{ position: absolute; left: -188px; top: -146px; width: 1040px; display: block; }}
  figcaption {{ font-size: 12.8px; line-height: 1.5; color: #55606d; padding: 9px 12px; border-top: 1px solid #d9e0e7; }}
  pre {{
    background: #f7f9fb; border: 1.5px solid #c5cdd6; border-radius: 9px; padding: 14px 16px;
    font-family: Consolas, "Cascadia Mono", monospace; font-size: 12.6px; line-height: 1.55;
    color: #1f2a36; white-space: pre-wrap; overflow-wrap: anywhere;
  }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 14px; }}
  th, td {{ text-align: left; padding: 7px 10px; border-bottom: 1px solid #dde3ea; font-size: 13.6px; vertical-align: top; }}
  th {{ width: 210px; color: #55606d; font-weight: 600; }}
  td code, li code, p code {{ font-family: Consolas, "Cascadia Mono", monospace; font-size: 12.7px; }}
  ul {{ margin: 8px 0 0 18px; }}
  li {{ font-size: 13.6px; line-height: 1.55; color: #46505c; margin-bottom: 5px; }}
  .note {{
    border: 1.5px solid #d5dbe2; border-left: 5px solid #33415a; border-radius: 8px;
    background: #fbfcfd; padding: 12px 15px; margin-top: 16px; font-size: 13.5px; line-height: 1.55; color: #46505c;
  }}
  .note strong {{ color: #1a1d21; }}
</style>
</head>
<body>
<div class="canvas">
  <h1>What <code>videos.insert</code> actually receives</h1>
  <p class="sub">Playtest Recorder makes one API call. Below is the exact request body, captured from the
    application's own dry-run mode on a real recorded session — not a hand-written example.</p>

  <div class="cols">
    <div class="left">
      <h2>The review step, before anything is sent</h2>
      <figure>
        <div class="crop"><img src="{screenshot}" alt="The Publish dialog: account state, audit notice, editable title and description, visibility select" /></div>
        <figcaption>The application's Publish dialog, captured from its automated UI test. The title and description
          shown are the real generated text for the session in the request body alongside; the account line and the session list behind it
          are test fixtures. The user reads and can edit all of this, and picks the visibility, before any request is
          made.</figcaption>
      </figure>
      <div class="note">
        <strong>Where the description comes from.</strong> Each timestamp line is one moment the developer marked
        during their own play session, with the words they dictated at that moment, transcribed on their own
        machine. Nothing in the metadata is scraped, generated from another channel, or taken from any third party.
      </div>
    </div>

    <div class="right">
      <h2>Request body (verbatim, from <code>--dry-run</code>)</h2>
      <pre>POST https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&amp;uploadType=resumable

{body}</pre>

      <table>
        <tr><th>Endpoints used</th><td><code>youtube.videos.insert</code> — and no others. No <code>search.list</code>,
          no <code>videos.list</code>, no channel, comment, subscriber or analytics reads.</td></tr>
        <tr><th>OAuth scope</th><td><code>https://www.googleapis.com/auth/youtube.upload</code> (single scope, write only)</td></tr>
        <tr><th>OAuth client type</th><td>Desktop app, installed-app loopback flow (<code>http://127.0.0.1:&lt;port&gt;</code>)</td></tr>
        <tr><th>Credential storage</th><td>Refresh token cached in the user's own profile at
          <code>%APPDATA%\\playtest-recorder\\youtube-token.json</code>. Never transmitted anywhere else; deleted by
          the app's Sign out.</td></tr>
        <tr><th>Upload mechanics</th><td>Resumable upload, 8 MiB chunks, one at a time. Never concurrent, never batched,
          never scheduled or automatic.</td></tr>
        <tr><th>Quota</th><td>1,600 units per upload. {quota_line}</td></tr>
        <tr><th>Default visibility</th><td><code>unlisted</code> (the user may choose private or public)</td></tr>
        <tr><th>Servers</th><td>None. The application has no backend; the request is made from the end user's own
          machine with their own credentials.</td></tr>
        <tr><th>Privacy policy</th><td><code>{privacy_url}</code></td></tr>
        <tr><th>Terms of service</th><td><code>{terms_url}</code></td></tr>
      </table>

      <div class="note">
        <strong>Who uses it.</strong> Playtest Recorder is a desktop tool for a game developer recording their own
        playtest sessions. One person per installation, uploading their own gameplay recording to their own channel,
        so that the session can be shared with their team alongside their notes. It reads nothing back from YouTube.
      </div>
    </div>
  </div>
</div>
</body>
</html>
"""

QUOTA_LINE = "At the requested 16,000 units/day that is ten uploads; peak 3,200 units/minute covers one upload plus one retry."


def capture_body(session_dir: Path) -> str:
    """The `dry-run` NDJSON event carries the body the uploader would send."""
    proc = subprocess.run(
        ["playtest-youtube", "upload", str(session_dir), "--json", "--dry-run"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        shell=True,
    )
    for line in proc.stdout.splitlines():
        if not line.strip().startswith("{"):
            continue
        event = json.loads(line)
        if event.get("event") == "dry-run":
            return json.dumps(event["body"], indent=2, ensure_ascii=False)
    raise SystemExit(f"no dry-run event in output:\n{proc.stdout}\n{proc.stderr}")


def read_env(key: str, default: str) -> str:
    env_file = REPO / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1].strip().strip("\"'")
    return default


def main() -> int:
    session = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SESSION
    body = capture_body(session)
    page = TEMPLATE.format(
        screenshot=SCREENSHOT,
        body=html.escape(body),
        quota_line=QUOTA_LINE,
        privacy_url=read_env("YOUTUBE_PRIVACY_POLICY_URL", "https://gw1108.github.io/video-record-plus-notes/privacy"),
        terms_url="https://gw1108.github.io/video-record-plus-notes/terms-of-service",
    )
    out = HERE / "supporting.html"
    out.write_text(page, encoding="utf-8")
    print(f"wrote {out} ({len(body.splitlines())} lines of captured request body)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
