"""`videos().insert` for a report bundle (PLAN M2.4 step 3): the kit's title and chaptered description go up with `condensed.mp4` as a resumable upload, and the resulting `youtu.be` URL is written to `report/youtube/url.txt` so `playtest-notion publish` picks it up without `--youtube`.

The body is built by a pure function so `--dry-run` can print exactly what would be sent — no credentials, no network, and no `google-api-python-client` import needed. Only `upload_video` touches the API.

Until the compliance audit passes, YouTube locks every upload from an unaudited project to *private* whatever `status.privacyStatus` says (see `audit_warning`). The request stays honest — `unlisted` is what we want and what the audit form describes — and the CLI warns instead of pretending the flag took.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from . import youtube as kit_mod

CHUNK_SIZE = 8 * 1024 * 1024  # resumable chunk, a multiple of 256 KiB as the API requires
MAX_RETRIES = 5
RETRIABLE_STATUS = (500, 502, 503, 504)
CATEGORY_GAMING = "20"
PRIVACY_CHOICES = ("unlisted", "private", "public")
DEFAULT_TAGS = ("playtest",)
URL_FILE_NAME = "url.txt"
KIT_DIR_NAME = "youtube"
# The recorder writes MP4; YouTube also takes the rest of this list, and a wrong extension is worth catching before an 800 MB upload.
VIDEO_SUFFIXES = (".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv", ".wmv", ".m4v")
_TIMECODE = re.compile(r"^(?:\d+:)?\d{1,2}:\d{2}\s+\S")


class UploadError(RuntimeError):
    """An upload problem the user can act on, carrying the next step as `hint`."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.hint = hint


@dataclass
class Kit:
    """The title/description pair `playtest-pipeline` generated for this report."""

    title: str
    description: str
    source: str  # "kit files" or "report_data.json"
    path: Path

    @property
    def chapter_count(self) -> int:
        return sum(1 for line in self.description.splitlines() if _TIMECODE.match(line))

    @property
    def description_bytes(self) -> int:
        return len(self.description.encode("utf-8"))


def resolve_report_dir(path: Path) -> Path:
    """Accept either a report bundle or the session dir that holds it — `process` prints both paths, and typing the session dir is the easy mistake."""
    path = Path(path).resolve()
    if (path / "report_data.json").exists():
        return path
    nested = path / "report"
    if (nested / "report_data.json").exists():
        return nested
    raise UploadError(f"no report bundle at {path} (report_data.json not found)", "run `playtest-pipeline process <session_dir>` first")


def read_kit(report_dir: Path) -> Kit:
    """The kit files if `process` wrote them, else rebuilt from `report_data.json` — a report bundle from before the kit existed is still uploadable."""
    kit_dir = report_dir / KIT_DIR_NAME
    title_file, description_file = kit_dir / "title.txt", kit_dir / "description.txt"
    if title_file.exists() and description_file.exists():
        title = title_file.read_text(encoding="utf-8").strip()
        description = description_file.read_text(encoding="utf-8").rstrip("\n")
        if title:
            return Kit(title, description, "kit files", kit_dir)
    data = _read_report_data(report_dir)
    return Kit(kit_mod.build_title(data), kit_mod.build_description(data), "report_data.json", report_dir / "report_data.json")


def _read_report_data(report_dir: Path) -> dict[str, Any]:
    path = report_dir / "report_data.json"
    if not path.exists():
        raise UploadError(f"no report bundle at {report_dir} (report_data.json not found)", "run `playtest-pipeline process <session_dir>` first")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise UploadError(f"{path} is not valid JSON ({err})", "re-run `playtest-pipeline process --force`") from err
    if not isinstance(data, dict):
        raise UploadError(f"{path} is not a report bundle")
    return data


def resolve_video(report_dir: Path, override: str | None = None) -> Path:
    """`condensed.mp4` in the bundle, or `--video`. A bundle whose video is `kind: original` holds only a `file://` reference to a recording that may be long gone, so it asks for the path instead of guessing."""
    if override:
        path = Path(override).expanduser().resolve()
        if not path.exists():
            raise UploadError(f"no video at {path}")
        return path
    condensed = report_dir / "condensed.mp4"
    if condensed.exists():
        return condensed
    kind = str(_read_report_data(report_dir).get("video", {}).get("kind", "?"))
    raise UploadError(f"no condensed.mp4 in {report_dir} (the report references the {kind} recording)", "pass the recording explicitly: --video <path to the OBS mp4>")


def build_body(
    kit: Kit,
    *,
    privacy: str = "unlisted",
    category_id: str = CATEGORY_GAMING,
    tags: Iterable[str] = DEFAULT_TAGS,
    made_for_kids: bool = False,
    embeddable: bool = True,
) -> dict[str, Any]:
    """The `videos.insert` request body. `selfDeclaredMadeForKids=False` is required — YouTube rejects an upload that declares nothing — and `embeddable=True` is what lets the Notion page play it inline."""
    if privacy not in PRIVACY_CHOICES:
        raise UploadError(f"unknown privacy status {privacy!r}", f"one of: {', '.join(PRIVACY_CHOICES)}")
    return {
        "snippet": {
            "title": kit.title,
            "description": kit.description,
            "tags": list(tags),
            "categoryId": category_id,
        },
        "status": {
            "privacyStatus": privacy,
            "embeddable": embeddable,
            "selfDeclaredMadeForKids": made_for_kids,
        },
    }


def watch_url(video_id: str) -> str:
    return f"https://youtu.be/{video_id}"


def studio_url(video_id: str) -> str:
    return f"https://studio.youtube.com/video/{video_id}/edit"


def url_file(report_dir: Path) -> Path:
    return report_dir / KIT_DIR_NAME / URL_FILE_NAME


def read_url(report_dir: Path) -> str | None:
    """The URL of a previous upload of this bundle, if any — the CLI refuses to upload twice without `--force`."""
    path = url_file(report_dir)
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8").strip() or None


def write_url(report_dir: Path, url: str) -> Path:
    path = url_file(report_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(url + "\n", encoding="utf-8")
    return path


def audit_warning(status: str | None) -> str | None:
    """The line to print when `YOUTUBE_AUDIT_STATUS` is anything but `passed`. Google locks uploads from an unaudited project to private with no appeal; better to say so before an hour of upload than after."""
    if (status or "").strip().lower().startswith("passed"):
        return None
    seen = f" (YOUTUBE_AUDIT_STATUS={status.strip()})" if status and status.strip() else " (YOUTUBE_AUDIT_STATUS is unset)"
    return f"the compliance audit has not passed{seen} — YouTube will lock this upload to PRIVATE regardless of privacyStatus, and it stays uploadable/editable in Studio"


def upload_video(
    video: Path,
    body: dict[str, Any],
    credentials: Any,
    *,
    chunk_size: int = CHUNK_SIZE,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Resumable `videos.insert`, returning the inserted resource (`id`, `snippet`, `status`).

    `MediaFileUpload(resumable=True)` owns the 308/`Content-Range` dance; this only drives `next_chunk`, reports progress, and retries the transient 5xx and socket errors the API guide calls retriable — a dropped chunk on a long upload should not throw away the session.
    """
    try:
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError
        from googleapiclient.http import MediaFileUpload
    except ImportError as err:
        raise UploadError(f"the Google client libraries are not installed ({err.name})", 'pip install -e "pipeline[youtube]"') from err

    if not video.exists():
        raise UploadError(f"no video at {video}")
    total = video.stat().st_size
    if total == 0:
        raise UploadError(f"{video} is empty")

    youtube = build("youtube", "v3", credentials=credentials, cache_discovery=False)
    media = MediaFileUpload(str(video), chunksize=chunk_size, resumable=True, mimetype="video/*")
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)

    response = None
    errors = 0
    while response is None:
        try:
            progress, response = request.next_chunk()
        except HttpError as err:
            if err.resp.status in RETRIABLE_STATUS and errors < MAX_RETRIES:
                errors += 1
                continue
            raise UploadError(_http_message(err), _http_hint(err)) from err
        except OSError as err:  # dropped connection mid-chunk: the resumable session survives it
            if errors >= MAX_RETRIES:
                raise UploadError(f"upload failed after {MAX_RETRIES} retries: {err}", "re-run the command — a resumable upload restarts cheaply") from err
            errors += 1
            continue
        if on_progress:
            sent = int(progress.resumable_progress) if progress else total
            on_progress(min(sent, total), total)
    if on_progress:
        on_progress(total, total)
    if not isinstance(response, dict) or not response.get("id"):
        raise UploadError(f"the API returned no video id: {response!r}")
    return response


def _http_message(err: Any) -> str:
    status = getattr(getattr(err, "resp", None), "status", "?")
    detail = ""
    try:
        payload = json.loads(err.content.decode("utf-8"))
        detail = str(payload.get("error", {}).get("message") or "")
    except Exception:
        detail = (getattr(err, "content", b"") or b"").decode("utf-8", "replace")[:300]
    return f"YouTube API error {status}: {detail}".strip()


def _http_hint(err: Any) -> str:
    """The three failures worth naming: an unenabled API, the daily quota (an upload costs ~1 600 of the default 10 000 units), and a consent screen that has not been granted the upload scope."""
    status = getattr(getattr(err, "resp", None), "status", 0)
    body = (getattr(err, "content", b"") or b"").decode("utf-8", "replace")
    if "quotaExceeded" in body or "uploadLimitExceeded" in body:
        return "the project's daily quota is spent (an upload costs ~1600 of 10000 units) — try again after the quota resets at midnight Pacific"
    if "accessNotConfigured" in body or "SERVICE_DISABLED" in body:
        return "enable YouTube Data API v3 for this Cloud project, then re-run"
    if status in (401, 403):
        return "the token may be stale or missing the upload scope — `playtest-youtube auth --reauth`, and check the channel exists on that Google account"
    return ""
