"""
pytest configuration: add parent directory to sys.path so that
`shoplive.backend.*` is importable when running pytest from this directory.
"""
import os
import sys

import pytest

# ai创新挑战赛/ must be on sys.path so `import shoplive.backend.*` works.
_project_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_parent not in sys.path:
    sys.path.insert(0, _project_parent)


@pytest.fixture(autouse=True)
def _clear_module_caches():
    """Reset module-level caches before each test to prevent cross-test contamination."""
    try:
        from shoplive.backend.api.video_edit_api import _ASR_CACHE
        _ASR_CACHE.clear()
    except ImportError:
        pass
    yield
