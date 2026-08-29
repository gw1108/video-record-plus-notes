"""playtest-youtube — upload a report bundle's condensed cut to YouTube as an unlisted video (PLAN M2.4 step 3).

    playtest-youtube upload <reportDir> [--privacy unlisted] [--dry-run] [--force]
    playtest-youtube auth [--reauth]      # run the loopback flow, cache the token
    playtest-youtube status               # where the credentials live and whether they work
    playtest-youtube logout               # forget the cached token

`upload` reads `report/youtube/{title,description}.txt` (the kit `playtest-pipeline process` writes, chapters included), authorizes against the Desktop-app client JSON in `%APPDATA%\\playtest-recorder\\`, and calls `videos().insert` with `privacyStatus=unlisted`. The resulting URL is written to `report/youtube/url.txt`, which `playtest-notion publish` reads on its own — so the whole path is `process` → `upload` → `publish`.

Every command takes `--json`, which replaces the human output with one NDJSON object per line (`{"event": …}`). That is what the recorder app's Publish dialog parses: the app spawns this CLI exactly as a person would run it, so the in-app flow and the terminal flow cannot drift apart.

Until Google's compliance audit passes, uploads from the project land *private* whatever the request says. The command works end to end anyway; it just says so up front.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from . import youtube_auth as auth
from . import youtube_upload as up

AUDIT_ENV_VAR = "YOUTUBE_AUDIT_STATUS"
PROGRESS_WIDTH = 28
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


def load_dotenv(start: Path | None = None, env: dict[str, str] | None = None) -> Path | None:
    """Minimal dotenv, matching the publisher's `loadDotEnv`: `KEY=value` lines, `#` comments, optional quotes, nearest `.env` walking up from the cwd, and a real environment variable always wins. `YOUTUBE_AUDIT_STATUS` is the one key this CLI reads."""
    env = os.environ if env is None else env
    directory = (start or Path.cwd()).resolve()
    for candidate in [directory, *directory.parents]:
        file = candidate / ".env"
        if not file.exists():
            continue
        for line in file.read_text(encoding="utf-8").splitlines():
            if line.lstrip().startswith("#"):
                continue
            match = _ENV_LINE.match(line)
            if not match:
                continue
            key, value = match.group(1), match.group(2)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            env.setdefault(key, value)
        return file
    return None


class Reporter:
    """Human-readable lines by default; one NDJSON object per line under `--json`. Only `emit` carries structure — `say` output is for people and is dropped entirely in JSON mode, so a parser never has to skip prose."""

    def __init__(self, json_mode: bool) -> None:
        self.json_mode = json_mode

    def emit(self, event: str, **fields: Any) -> None:
        if self.json_mode:
            print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)

    def say(self, text: str = "") -> None:
        if not self.json_mode:
            print(text)

    def stage(self, name: str) -> None:
        self.say(f"\n== {name}")

    def progress(self, sent: int, total: int) -> None:
        if self.json_mode:
            self.emit("progress", sent=sent, total=total)
            return
        filled = round(PROGRESS_WIDTH * sent / max(1, total))
        bar = "#" * filled + "." * (PROGRESS_WIDTH - filled)
        end = "\n" if sent >= total else ""
        print(f"\r  [{bar}] {100 * sent / max(1, total):5.1f}%  {_mib(sent)} / {_mib(total)}", end=end, flush=True)

    def failure(self, message: str, hint: str = "") -> None:
        self.emit("error", message=message, hint=hint)
        sys.stdout.flush()
        print(f"\nerror: {message}", file=sys.stderr)
        if hint:
            print(f"  hint: {hint}", file=sys.stderr)


def _mib(n: int) -> str:
    return f"{n / (1024 * 1024):.1f} MiB"


def _token_fields(info: auth.TokenInfo) -> dict[str, Any]:
    return {
        "path": str(info.path),
        "exists": info.exists,
        "expiry": info.expiry.isoformat() if info.expiry else None,
        "expired": info.expired,
        "scopesOk": info.scopes_ok,
        "hasRefreshToken": info.has_refresh_token,
    }


def cmd_upload(args: argparse.Namespace) -> int:
    out = Reporter(args.json)
    report_dir = up.resolve_report_dir(Path(args.report_dir))

    out.stage("Kit")
    kit = up.read_kit(report_dir)
    if args.title:
        kit.title = args.title
    video = up.resolve_video(report_dir, args.video)
    size = video.stat().st_size
    previous = up.read_url(report_dir)
    warning = up.audit_warning(os.environ.get(AUDIT_ENV_VAR))

    out.say(f"  title:       {kit.title}  ({len(kit.title)}/100 chars)")
    out.say(f"  description: {kit.chapter_count} chapters, {kit.description_bytes}/5000 bytes  (from {kit.source})")
    out.say(f"  video:       {video.name}  ({_mib(size)})")
    out.emit(
        "kit",
        title=kit.title,
        description=kit.description,
        chapters=kit.chapter_count,
        descriptionBytes=kit.description_bytes,
        source=kit.source,
        video=str(video),
        bytes=size,
        privacy=args.privacy,
        previousUrl=previous,
        auditWarning=warning,
    )
    if kit.chapter_count < up.kit_mod.MIN_CHAPTERS:
        out.say(f"  note: fewer than {up.kit_mod.MIN_CHAPTERS} chapters — YouTube will not draw a chapter bar on this video.")
    if video.suffix.lower() not in up.VIDEO_SUFFIXES:
        out.say(f"  warning: {video.suffix} is not a format YouTube accepts — expect a rejected upload.")

    if previous and not args.force:
        out.failure(f"this bundle was already uploaded: {previous}", f"re-upload with --force, or delete {up.url_file(report_dir)}")
        return 1
    if previous:
        out.say(f"  note: re-uploading (--force); the previous upload {previous} is left alone on the channel.")

    body = up.build_body(
        kit,
        privacy=args.privacy,
        category_id=args.category,
        tags=[t.strip() for t in args.tags.split(",") if t.strip()],
    )
    if warning:
        out.say(f"\n  WARNING: {warning}")

    if args.dry_run:
        out.stage("Dry run — the request that would be sent")
        out.say("  POST https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=resumable")
        out.say(f"  media: {video} ({_mib(size)}, {up.CHUNK_SIZE // 1024 // 1024} MiB chunks)")
        out.say(json.dumps(body, indent=2, ensure_ascii=False))
        out.say("\nDry run — nothing was uploaded and no browser was opened. Drop --dry-run to upload.")
        out.emit("dry-run", body=body)
        return 0

    out.stage("Authorize")
    out.emit("auth-start")
    creds, how = auth.load_credentials(
        client_json=Path(args.client_json) if args.client_json else None,
        token_json=Path(args.token) if args.token else None,
        interactive=not args.no_browser,
        port=args.port,
        open_browser=not args.no_browser,
    )
    out.say({
        "cached": f"  using the cached token ({auth.token_json_path()})",
        "refreshed": "  refreshed the cached token",
        "browser": f"  authorized in the browser; token cached at {auth.token_json_path()}",
    }[how])
    out.emit("auth", how=how, tokenPath=str(Path(args.token) if args.token else auth.token_json_path()))

    out.stage(f"Upload ({args.privacy})")
    out.emit("upload-start", bytes=size, video=str(video))
    response = up.upload_video(video, body, creds, on_progress=out.progress)
    video_id = response["id"]
    url = up.watch_url(video_id)
    written = up.write_url(report_dir, url)
    actual = str(response.get("status", {}).get("privacyStatus", "?"))

    out.say(f"\n  video id:    {video_id}")
    out.say(f"  visibility:  {actual}" + (f"  (requested {args.privacy} — locked by the pending audit)" if actual != args.privacy else ""))
    out.say(f"  -> {written}")
    out.say("\nDone.")
    out.say(f"  watch:  {url}")
    out.say(f"  edit:   {up.studio_url(video_id)}")
    out.say("  publish to Notion (picks up url.txt on its own):")
    out.say(f'    npx playtest-notion publish "{report_dir}"')
    out.emit(
        "done",
        videoId=video_id,
        url=url,
        studioUrl=up.studio_url(video_id),
        privacyStatus=actual,
        requestedPrivacy=args.privacy,
        urlFile=str(written),
    )
    if actual != "unlisted" and args.privacy == "unlisted":
        out.say("\n  YouTube processes the video for a few minutes; chapters appear once processing finishes.")
    return 0


def cmd_auth(args: argparse.Namespace) -> int:
    out = Reporter(args.json)
    out.stage("Authorize")
    client_json = Path(args.client_json) if args.client_json else auth.client_json_path()
    installed = auth.read_client(client_json)
    out.say(f"  client:  {client_json}")
    out.say(f"  id:      {installed['client_id']}")
    out.say(f"  scope:   {' '.join(auth.SCOPES)}")
    out.emit("auth-start", clientId=installed["client_id"], clientJson=str(client_json), scopes=auth.SCOPES)
    creds, how = auth.load_credentials(
        client_json=client_json,
        token_json=Path(args.token) if args.token else None,
        interactive=not args.no_browser,
        reauth=args.reauth,
        port=args.port,
        open_browser=not args.no_browser,
    )
    token_path = Path(args.token) if args.token else auth.token_json_path()
    expiry = getattr(creds, "expiry", None)
    out.say(f"  result:  {how}")
    out.say(f"  token:   {token_path}")
    if expiry:
        out.say(f"  expires: {expiry} UTC  (weekly re-consent is normal while the consent screen is in Testing)")
    out.say("\nReady: playtest-youtube upload <reportDir>")
    out.emit("auth", how=how, tokenPath=str(token_path), expiry=expiry.isoformat() if expiry else None)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    out = Reporter(args.json)
    fields: dict[str, Any] = {"configDir": str(auth.config_dir())}
    out.say(f"config dir:  {auth.config_dir()}")

    client_path = auth.client_json_path()
    try:
        installed = auth.read_client(client_path)
        fields["client"] = {"path": str(client_path), "ok": True, "clientId": installed["client_id"], "project": installed.get("project_id")}
        out.say(f"client JSON: {client_path}")
        out.say(f"  client_id: {installed['client_id']}")
        if installed.get("project_id"):
            out.say(f"  project:   {installed['project_id']}")
    except auth.AuthError as err:
        fields["client"] = {"path": str(client_path), "ok": False, "error": str(err), "hint": err.hint}
        out.say(f"client JSON: MISSING — {err}")
        out.say(f"  hint: {err.hint}")

    token = auth.read_token()
    fields["token"] = _token_fields(token)
    if not token.exists:
        out.say(f"token:       none yet ({token.path}) — run `playtest-youtube auth`")
    else:
        state = "expired (will refresh silently)" if token.expired else "valid"
        out.say(f"token:       {token.path}  [{state}]")
        out.say(f"  expiry:    {token.expiry.isoformat() if token.expiry else 'unknown'}")
        out.say(f"  scopes:    {' '.join(token.scopes) or '(none recorded)'}" + ("" if token.scopes_ok else "  <- missing youtube.upload; re-run `auth --reauth`"))
        if not token.has_refresh_token:
            out.say("  note:      no refresh token cached — every upload will open the browser")

    try:
        import googleapiclient  # noqa: F401
        import google_auth_oauthlib  # noqa: F401
        fields["libraries"] = True
        out.say("libraries:   google-api-python-client + google-auth-oauthlib installed")
    except ImportError as err:
        fields["libraries"] = False
        fields["librariesHint"] = auth.INSTALL_HINT
        out.say(f"libraries:   MISSING ({err.name}) — {auth.INSTALL_HINT}")

    audit = os.environ.get(AUDIT_ENV_VAR)
    warning = up.audit_warning(audit)
    fields["audit"] = audit
    fields["auditWarning"] = warning
    out.say(f"audit:       {audit or '(unset)'}" + ("" if not warning else "  <- uploads land PRIVATE until this reads 'passed'"))

    # The app treats this as "can upload without opening a browser".
    fields["ready"] = bool(fields.get("libraries")) and fields["client"]["ok"] and token.exists and token.scopes_ok
    out.emit("status", **fields)
    return 0


def cmd_logout(args: argparse.Namespace) -> int:
    out = Reporter(args.json)
    path = Path(args.token) if args.token else auth.token_json_path()
    removed = auth.forget_token(path)
    out.say(f"removed {path}" if removed else f"no cached token at {path}")
    out.say(f"The app still has access on Google's side — revoke it at {auth.REVOKE_URL}")
    out.emit("logout", removed=removed, tokenPath=str(path), revokeUrl=auth.REVOKE_URL)
    return 0


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to a legacy codepage; note text (and so the kit title) is arbitrary Unicode.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    load_dotenv()

    parser = argparse.ArgumentParser(prog="playtest-youtube", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def common_flags(p: argparse.ArgumentParser) -> None:
        p.add_argument("--json", action="store_true", help="emit one NDJSON object per line instead of human output (what the recorder app parses)")

    def credential_flags(p: argparse.ArgumentParser) -> None:
        p.add_argument("--client-json", help=f"OAuth client JSON (default {auth.client_json_path()})")
        p.add_argument("--token", help=f"token cache (default {auth.token_json_path()})")
        p.add_argument("--port", type=int, default=0, help="loopback redirect port (default 0 = let the OS choose)")
        p.add_argument("--no-browser", action="store_true", help="never open a browser: fail unless a cached token works")

    p = sub.add_parser("upload", help="upload the bundle's condensed cut as an unlisted video")
    p.add_argument("report_dir", help="a report bundle (or the session dir containing it)")
    p.add_argument("--video", help="upload this file instead of report/condensed.mp4")
    p.add_argument("--title", help="override the kit title")
    p.add_argument("--privacy", choices=up.PRIVACY_CHOICES, default="unlisted")
    p.add_argument("--tags", default=",".join(up.DEFAULT_TAGS), help="comma-separated tags (default: playtest)")
    p.add_argument("--category", default=up.CATEGORY_GAMING, help="YouTube category id (default 20 = Gaming)")
    p.add_argument("--dry-run", action="store_true", help="print the request body and exit; no auth, no network")
    p.add_argument("--force", action="store_true", help="upload again even though youtube/url.txt exists")
    credential_flags(p)
    common_flags(p)
    p.set_defaults(func=cmd_upload)

    p = sub.add_parser("auth", help="run the loopback OAuth flow and cache the token")
    p.add_argument("--reauth", action="store_true", help="ignore the cached token and consent again")
    credential_flags(p)
    common_flags(p)
    p.set_defaults(func=cmd_auth)

    p = sub.add_parser("status", help="show credential paths, token state, and audit status")
    common_flags(p)
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("logout", help="delete the cached token")
    p.add_argument("--token", help=f"token cache (default {auth.token_json_path()})")
    common_flags(p)
    p.set_defaults(func=cmd_logout)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (auth.AuthError, up.UploadError) as err:
        Reporter(getattr(args, "json", False)).failure(str(err), err.hint)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted — nothing was left half-published; re-run to start over.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
