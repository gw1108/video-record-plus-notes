from pathlib import Path

from setuptools import setup
from setuptools.command.bdist_wheel import bdist_wheel


BUNDLED_FFMPEG = Path(__file__).parent / "playtest_pipeline" / "bin" / "ffmpeg.exe"


class WindowsBundledWheel(bdist_wheel):
    """Tag wheels containing the Windows FFmpeg executables as Windows-only."""

    def get_tag(self) -> tuple[str, str, str]:
        if BUNDLED_FFMPEG.is_file():
            return "py3", "none", "win_amd64"
        return super().get_tag()


setup(cmdclass={"bdist_wheel": WindowsBundledWheel})
