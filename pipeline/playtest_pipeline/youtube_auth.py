"""OAuth for the YouTube uploader (PLAN M2.4 step 3): the installed-app loopback flow against the Desktop-app client JSON the M2.4 wizard drops in `%APPDATA%\\playtest-recorder\\`, with the resulting token cached beside it as `youtube-token.json`.

Nothing here talks to the YouTube Data API — `youtube_upload.py` does that — so the CLI can say where the credentials live and whether they look usable without importing `google-api-python-client` at all (`playtest-youtube status` and `--dry-run` work on a bare install).

Scope is `youtube.upload` only: the tool writes one video and reads nothing back, which is what the privacy page and the compliance-audit form both claim. While the consent screen is in *Testing* Google expires the refresh token after 7 days, so the browser flow reappearing weekly is expected, not a bug.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
CLIENT_JSON_NAME = "youtube-client.json"
TOKEN_JSON_NAME = "youtube-token.json"
CONFIG_DIR_ENV_VAR = "PLAYTEST_CONFIG_DIR"
INSTALL_HINT = 'pip install -e "pipeline[youtube]"'
WIZARD_HINT = "bash verification/wizards/wizard-m2.4-youtube-api.sh"
REVOKE_URL = "https://myaccount.google.com/permissions"


class AuthError(RuntimeError):
    """A credential problem the user can fix, carrying the fix as `hint`."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.hint = hint


def config_dir() -> Path:
    """`%APPDATA%\\playtest-recorder` on Windows (the recorder's own config dir, where the wizard leaves the client JSON), `~/.config/playtest-recorder` elsewhere. `PLAYTEST_CONFIG_DIR` overrides both, which is how the tests stay off the real machine."""
    override = os.environ.get(CONFIG_DIR_ENV_VAR)
    if override:
        return Path(override).expanduser()
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "playtest-recorder"
    return Path.home() / ".config" / "playtest-recorder"


def client_json_path() -> Path:
    return config_dir() / CLIENT_JSON_NAME


def token_json_path() -> Path:
    return config_dir() / TOKEN_JSON_NAME


def read_client(path: Path) -> dict[str, Any]:
    """The `installed` block of a Desktop-app OAuth client. A Web-app client (`web`) is the usual mistake — it has no loopback redirect — so name that case."""
    if not path.exists():
        raise AuthError(f"no OAuth client JSON at {path}", f"run the wizard to create one: {WIZARD_HINT}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise AuthError(f"{path} is not valid JSON ({err})", "download the client JSON again from the Google Cloud console") from err
    if "web" in data and "installed" not in data:
        raise AuthError(f"{path} is a *Web application* OAuth client", "the loopback flow needs Application type: Desktop app — create one and download it again")
    installed = data.get("installed")
    if not isinstance(installed, dict) or not installed.get("client_id") or not installed.get("client_secret"):
        raise AuthError(f"{path} has no installed.client_id / installed.client_secret", f"re-run {WIZARD_HINT}")
    return installed


def _google_modules() -> tuple[Any, Any, Any]:
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError as err:
        raise AuthError(f"the Google client libraries are not installed ({err.name})", INSTALL_HINT) from err
    return Credentials, Request, InstalledAppFlow


@dataclass
class TokenInfo:
    """What `status` can say about the cached token without contacting Google."""

    path: Path
    exists: bool
    scopes: list[str]
    expiry: datetime | None
    has_refresh_token: bool

    @property
    def expired(self) -> bool:
        return self.expiry is not None and self.expiry <= datetime.now(timezone.utc)

    @property
    def scopes_ok(self) -> bool:
        return all(scope in self.scopes for scope in SCOPES)


def read_token(path: Path | None = None) -> TokenInfo:
    path = path or token_json_path()
    if not path.exists():
        return TokenInfo(path, False, [], None, False)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return TokenInfo(path, True, [], None, False)
    expiry = None
    raw_expiry = data.get("expiry")
    if isinstance(raw_expiry, str):
        try:
            parsed = datetime.fromisoformat(raw_expiry.replace("Z", "+00:00"))
            expiry = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            expiry = None
    return TokenInfo(path, True, list(data.get("scopes") or []), expiry, bool(data.get("refresh_token")))


def forget_token(path: Path | None = None) -> bool:
    """Delete the cached token. Access stays granted on Google's side until the user revokes it at `REVOKE_URL`, so the CLI says that rather than claiming more than it did."""
    path = path or token_json_path()
    if not path.exists():
        return False
    path.unlink()
    return True


def load_credentials(
    *,
    client_json: Path | None = None,
    token_json: Path | None = None,
    interactive: bool = True,
    reauth: bool = False,
    port: int = 0,
    open_browser: bool = True,
) -> tuple[Any, str]:
    """Credentials for `youtube.upload`, plus how they were obtained: `cached`, `refreshed`, or `browser`.

    Cached token first, silent refresh second, loopback browser flow last. `port=0` lets the OS pick, which keeps the redirect inside the `http://127.0.0.1:<port>` range a Desktop client already allows (nothing to register). `interactive=False` refuses the browser step, so an automated caller fails loudly instead of hanging on a consent screen nobody is watching.
    """
    Credentials, Request, InstalledAppFlow = _google_modules()
    client_json = client_json or client_json_path()
    token_json = token_json or token_json_path()
    read_client(client_json)  # fail on a missing or Web-app client before opening a browser

    creds = None
    if token_json.exists() and not reauth:
        try:
            creds = Credentials.from_authorized_user_file(str(token_json), SCOPES)
        except (ValueError, json.JSONDecodeError):
            creds = None  # a corrupt cache is not worth an error: fall through to the flow
    if creds and creds.valid:
        return creds, "cached"
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            _save(creds, token_json)
            return creds, "refreshed"
        except Exception:
            # Testing-mode refresh tokens are revoked after 7 days; that is a browser trip, not a failure.
            creds = None
    if not interactive:
        raise AuthError("no usable cached token and the browser flow is disabled", "run `playtest-youtube auth` once on this machine")
    flow = InstalledAppFlow.from_client_secrets_file(str(client_json), SCOPES)
    creds = flow.run_local_server(
        port=port,
        open_browser=open_browser,
        authorization_prompt_message="Opening your browser to authorize the upload…\n  If it did not open, visit this URL:\n  {url}",
        success_message="Playtest Recorder is authorized. You can close this tab and return to the terminal.",
    )
    _save(creds, token_json)
    return creds, "browser"


def _save(creds: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(creds.to_json(), encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)
