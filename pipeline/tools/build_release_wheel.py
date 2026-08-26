"""Build and verify the Windows pipeline wheel with the selected BtbN LGPL FFmpeg asset."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parents[1]
MANIFEST_PATH = PIPELINE_DIR / "ffmpeg-release.json"
PACKAGE_BIN_DIR = PIPELINE_DIR / "playtest_pipeline" / "bin"
PLAYER_TEMPLATE_PATH = PIPELINE_DIR.parent / "packages" / "player-embed" / "report-template.html"
DIST_DIR = PIPELINE_DIR / "dist"
REQUIRED_FFMPEG_FILES = ("ffmpeg.exe", "ffprobe.exe", "LICENSE.txt")
REQUIRED_WHEEL_FILES = {f"playtest_pipeline/bin/{name}" for name in REQUIRED_FFMPEG_FILES} | {"playtest_pipeline/report-template.html"}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "playtest-recorder-release-builder"})
    print(f"Downloading {url}")
    try:
        with urllib.request.urlopen(request) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output)
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


def verify_archive(archive: Path, manifest: dict[str, object]) -> None:
    actual_size = archive.stat().st_size
    actual_sha256 = sha256(archive)
    if actual_size != manifest["size"] or actual_sha256 != manifest["sha256"]:
        raise RuntimeError(f"Selected archive does not match ffmpeg-release.json: size={actual_size}, sha256={actual_sha256}")
    print(f"Selected BtbN asset: {manifest['source_url']}")
    print(f"Archive SHA-256: {actual_sha256}")


def install_archive_files(archive: Path, asset: str) -> None:
    archive_root = Path(asset).stem
    members = {
        "ffmpeg.exe": f"{archive_root}/bin/ffmpeg.exe",
        "ffprobe.exe": f"{archive_root}/bin/ffprobe.exe",
        "LICENSE.txt": f"{archive_root}/LICENSE.txt",
    }
    PACKAGE_BIN_DIR.mkdir(parents=True, exist_ok=True)
    for stale in PACKAGE_BIN_DIR.iterdir():
        if stale.is_file():
            stale.unlink()
    with zipfile.ZipFile(archive) as bundle:
        missing = [member for member in members.values() if member not in bundle.namelist()]
        if missing:
            raise RuntimeError(f"Selected archive is missing required members: {missing}")
        for destination_name, member in members.items():
            with bundle.open(member) as source, (PACKAGE_BIN_DIR / destination_name).open("wb") as destination:
                shutil.copyfileobj(source, destination)
    license_text = (PACKAGE_BIN_DIR / "LICENSE.txt").read_text(encoding="utf-8")
    if "GNU LESSER GENERAL PUBLIC LICENSE" not in license_text:
        raise RuntimeError("Bundled LICENSE.txt is not an LGPL notice")


def run_tool(name: str, *args: str) -> str:
    result = subprocess.run([PACKAGE_BIN_DIR / name, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError(f"{name} {' '.join(args)} failed ({result.returncode}):\n{result.stderr}")
    return result.stdout + result.stderr


def verify_executables(manifest: dict[str, object]) -> None:
    ffmpeg_version = run_tool("ffmpeg.exe", "-version")
    ffprobe_version = run_tool("ffprobe.exe", "-version")
    license_output = run_tool("ffmpeg.exe", "-L")
    encoders = run_tool("ffmpeg.exe", "-hide_banner", "-encoders")
    configuration = next((line for line in ffmpeg_version.splitlines() if line.startswith("configuration:")), "")
    config_flags = configuration.split()
    encoder_names = {parts[1] for line in encoders.splitlines() if len(parts := line.split()) >= 2}
    checks = {
        "expected version": ffmpeg_version.startswith(f"ffmpeg version {manifest['ffmpeg_version']}"),
        "matching ffprobe build": ffprobe_version.startswith(f"ffprobe version {manifest['ffmpeg_version']}"),
        "BtbN build prefix": "--prefix=/ffbuild/prefix" in config_flags,
        "LGPL runtime notice": "GNU Lesser General Public License" in license_output,
        "no --enable-gpl": "--enable-gpl" not in config_flags,
        "explicit --disable-libx264": "--disable-libx264" in config_flags,
        "no libx264 encoder": "libx264" not in encoder_names,
    }
    failed = [name for name, passed in checks.items() if not passed]
    print(ffmpeg_version.splitlines()[0])
    print(configuration)
    print("Executable checks: " + ", ".join(f"{name}={'PASS' if passed else 'FAIL'}" for name, passed in checks.items()))
    if failed:
        raise RuntimeError(f"Bundled executable verification failed: {failed}")


def build_wheel() -> Path:
    DIST_DIR.mkdir(exist_ok=True)
    for old_wheel in DIST_DIR.glob("playtest_pipeline-*.whl"):
        old_wheel.unlink()
    command = [sys.executable, "-m", "pip", "wheel", "--no-deps", "--wheel-dir", str(DIST_DIR), str(PIPELINE_DIR)]
    print("Building wheel: " + " ".join(command))
    subprocess.run(command, check=True)
    wheels = list(DIST_DIR.glob("playtest_pipeline-*.whl"))
    if len(wheels) != 1:
        raise RuntimeError(f"Expected one release wheel, found: {wheels}")
    return wheels[0]


def verify_wheel(wheel: Path) -> None:
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        missing = REQUIRED_WHEEL_FILES - names
        if missing:
            raise RuntimeError(f"Wheel is missing required files: {sorted(missing)}")
        wheel_metadata_name = next(name for name in names if name.endswith(".dist-info/WHEEL"))
        wheel_metadata = archive.read(wheel_metadata_name).decode("utf-8")
        if "Tag: py3-none-win_amd64" not in wheel_metadata:
            raise RuntimeError(f"Wheel is not correctly tagged Windows-only:\n{wheel_metadata}")
        license_text = archive.read("playtest_pipeline/bin/LICENSE.txt").decode("utf-8")
        if "GNU LESSER GENERAL PUBLIC LICENSE" not in license_text:
            raise RuntimeError("Wheel's FFmpeg license notice is invalid")
        if archive.read("playtest_pipeline/report-template.html") != PLAYER_TEMPLATE_PATH.read_bytes():
            raise RuntimeError("Wheel's report template does not match the player template source")
    print(f"Verified wheel: {wheel}")
    for name in sorted(REQUIRED_WHEEL_FILES):
        print(f"  {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use an already-downloaded selected archive instead of pipeline/.release/<asset>")
    parser.add_argument("--no-download", action="store_true", help="Fail rather than download when the selected archive is absent")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    archive = args.archive or PIPELINE_DIR / ".release" / manifest["asset"]
    archive = archive.resolve()
    if not archive.is_file():
        if args.no_download:
            raise FileNotFoundError(archive)
        download(str(manifest["source_url"]), archive)
    verify_archive(archive, manifest)
    install_archive_files(archive, str(manifest["asset"]))
    verify_executables(manifest)
    wheel = build_wheel()
    verify_wheel(wheel)


if __name__ == "__main__":
    main()
