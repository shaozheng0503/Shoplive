"""
pytest configuration: add parent directory to sys.path so that
`shoplive.backend.*` is importable when running pytest from this directory.
"""
import os
import sys

# ai创新挑战赛/ must be on sys.path so `import shoplive.backend.*` works.
_project_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_parent not in sys.path:
    sys.path.insert(0, _project_parent)
