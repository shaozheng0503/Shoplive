import os
import sys
from pathlib import Path

# Ensure the project root (parent of the `shoplive/` package) is on sys.path so
# that `shoplive.*` imports work regardless of the current working directory.
# parents: [0]=backend/, [1]=shoplive/, [2]=ai创新挑战赛/
_project_root = str(Path(__file__).resolve().parents[2])
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from shoplive.backend.app_factory import create_app


def _load_dotenv_if_present():
    env_file = Path(__file__).resolve().parents[1] / ".env"
    if not env_file.exists():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _ensure_ffmpeg_full():
    """Prefer ffmpeg-full (with drawtext/libfreetype) over system ffmpeg if available."""
    ffmpeg_full = "/opt/homebrew/opt/ffmpeg-full/bin"
    current_path = os.environ.get("PATH", "")
    if os.path.isdir(ffmpeg_full) and ffmpeg_full not in current_path:
        os.environ["PATH"] = ffmpeg_full + os.pathsep + current_path


def main():
    _load_dotenv_if_present()
    _ensure_ffmpeg_full()
    app = create_app()
    port = int(os.getenv("PORT", "8000"))
    host = os.getenv("HOST", "127.0.0.1")
    debug = os.getenv("DEBUG", "1") not in {"0", "false", "False"}
    app.run(host=host, port=port, debug=debug)


if __name__ == "__main__":
    main()

