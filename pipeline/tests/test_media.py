from pathlib import Path

from playtest_pipeline import media


def make_tool(directory: Path, name: str) -> Path:
    tool = directory / f"{name}.exe"
    tool.parent.mkdir(parents=True, exist_ok=True)
    tool.touch()
    return tool


def reset_resolution_cache() -> None:
    media.resolve_tool.cache_clear()


def test_resolution_order_is_override_then_bundle_then_path(tmp_path, monkeypatch):
    override = tmp_path / "override"
    bundle = tmp_path / "bundle"
    path_tool = tmp_path / "path" / "ffmpeg.exe"
    override_tool = make_tool(override, "ffmpeg")
    make_tool(bundle, "ffmpeg")
    make_tool(path_tool.parent, "ffmpeg")
    monkeypatch.setattr(media.sys, "platform", "win32")
    monkeypatch.setattr(media, "BUNDLED_BIN_DIR", bundle)
    monkeypatch.setattr(media.shutil, "which", lambda name: str(path_tool))
    monkeypatch.setenv(media.FFMPEG_DIR_ENV_VAR, str(override))
    reset_resolution_cache()
    assert media.resolve_tool("ffmpeg") == str(override_tool)
    assert media.tool_origin("ffmpeg").startswith("PLAYTEST_FFMPEG_DIR")

    monkeypatch.delenv(media.FFMPEG_DIR_ENV_VAR)
    reset_resolution_cache()
    assert media.resolve_tool("ffmpeg") == str(bundle / "ffmpeg.exe")
    assert media.tool_origin("ffmpeg").startswith("bundled")

    (bundle / "ffmpeg.exe").unlink()
    reset_resolution_cache()
    assert media.resolve_tool("ffmpeg") == str(path_tool)
    assert media.tool_origin("ffmpeg").startswith("PATH")
    reset_resolution_cache()


def test_missing_override_falls_back_to_bundle(tmp_path, monkeypatch):
    bundle = tmp_path / "bundle"
    bundled_tool = make_tool(bundle, "ffprobe")
    monkeypatch.setattr(media.sys, "platform", "win32")
    monkeypatch.setattr(media, "BUNDLED_BIN_DIR", bundle)
    monkeypatch.setenv(media.FFMPEG_DIR_ENV_VAR, str(tmp_path / "missing"))
    reset_resolution_cache()
    assert media.resolve_tool("ffprobe") == str(bundled_tool)
    reset_resolution_cache()
