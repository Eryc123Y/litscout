#!/usr/bin/env python3
"""Compressed snapshot of a running server's state folder.

Usage: snapshot.py STATE_DIR OUT_DIR [--keep N]

Each SQLite file is copied with SQLite's online backup, so the copy is
consistent while the server keeps running; WAL and shared-memory files are
folded into it. Other files (KV blobs) are copied as they are. The disposable
cache folder is left out. The result is one xz-compressed tar in OUT_DIR,
mode 600; only the newest N snapshots are kept (default 7).
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tarfile
import tempfile
from datetime import datetime, timezone

SKIP_DIRS = {"cache"}
SKIP_SUFFIXES = ("-wal", "-shm", "-journal")
PREFIX = "litscout-state-"


def copy_sqlite(source: str, target: str) -> None:
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


def stage(state: str, work: str) -> int:
    count = 0
    for root, dirs, files in os.walk(state):
        rel_root = os.path.relpath(root, state)
        if rel_root == ".":
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        dirs.sort()
        for name in sorted(files):
            if name.endswith(SKIP_SUFFIXES) or name == ".lock":
                continue
            source = os.path.join(root, name)
            target = os.path.join(work, rel_root, name)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if name.endswith(".sqlite"):
                copy_sqlite(source, target)
            else:
                shutil.copy2(source, target)
            count += 1
    return count


def prune(out: str, keep: int) -> list[str]:
    snapshots = sorted(
        name for name in os.listdir(out) if name.startswith(PREFIX) and name.endswith(".tar.xz")
    )
    removed = snapshots[: max(0, len(snapshots) - keep)]
    for name in removed:
        os.remove(os.path.join(out, name))
    return removed


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Compressed snapshot of a state folder.")
    parser.add_argument("state")
    parser.add_argument("out")
    parser.add_argument("--keep", type=int, default=7)
    options = parser.parse_args(argv)
    if options.keep < 1:
        parser.error("--keep must be at least 1")
    state, out = os.path.abspath(options.state), os.path.abspath(options.out)
    keep = options.keep
    if not os.path.isdir(state):
        print(f"{state} is not a folder", file=sys.stderr)
        return 1
    os.umask(0o077)
    os.makedirs(out, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    final = os.path.join(out, f"{PREFIX}{stamp}.tar.xz")
    with tempfile.TemporaryDirectory(dir=out) as work:
        files = stage(state, os.path.join(work, "state"))
        partial = final + ".partial"
        with tarfile.open(partial, "w:xz") as tar:
            tar.add(os.path.join(work, "state"), arcname="state")
        os.replace(partial, final)
    removed = prune(out, keep)
    print(json.dumps({
        "snapshot": final,
        "bytes": os.path.getsize(final),
        "files": files,
        "removed": removed,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
