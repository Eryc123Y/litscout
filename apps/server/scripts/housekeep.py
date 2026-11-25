#!/usr/bin/env python3
"""Keep LitScout's files on an own server within their limits.

Usage: housekeep.py BASE [--home HOME] [--dry-run] [--status-file FILE]

BASE is the LitScout folder (releases/, current, logs/, backups/, state/).
HOME is the LitScout user's home folder, by default the caller's. Everything
in it is LitScout's: BASE, Node, the agent CLIs and their state. The limits
follow ADR 0004 (decision 6):

- releases: the live one and the two most recently installed others (rollback targets);
- run logs and notification marks: 30 days, and at most 200 MB of run logs
  (oldest first, never the newest);
- agent transcripts: 14 days (Antigravity conversations and their brain
  folders, Codex sessions, Claude Code project logs);
- npm's download cache: emptied when it passes 200 MB (installs fetch again);
- snapshots: snapshot.py keeps its own count.

Prints one JSON object: the footprint of HOME (and BASE, when it lies
outside HOME) before and after, what was
removed (or would be, with --dry-run), and whether the footprint is over the
4 GB warning level or the 5 GB cap. The footprint counts file sizes, as
notify.py does.

--status-file writes the server's facts for Health and `doctor` (the
footprint, the newest snapshot and the newest run of each timer), which
`litscout server report FILE` sends to the Worker.
"""

import argparse
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone

DAY = 86400
WARN_BYTES = 4 * 1024**3
CAP_BYTES = 5 * 1024**3
KEEP_RELEASES = 3
LOG_DAYS = 30
LOG_BYTES = 200 * 1024**2
TRANSCRIPT_DAYS = 14
NPM_CACHE_BYTES = 200 * 1024**2


def tree_bytes(path: str) -> int:
    """Size of a file, or of every file under a folder; links count as links."""
    if not os.path.isdir(path) or os.path.islink(path):
        try:
            return os.lstat(path).st_size
        except OSError:
            return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def newest_change(path: str) -> float:
    """The latest modification time of a file, or of a folder and its contents."""
    try:
        newest = os.lstat(path).st_mtime
    except OSError:
        return time.time()
    if os.path.isdir(path) and not os.path.islink(path):
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                try:
                    newest = max(newest, os.lstat(os.path.join(root, name)).st_mtime)
                except OSError:
                    pass
    return newest


def entries(folder: str) -> list[str]:
    try:
        return sorted(os.path.join(folder, name) for name in os.listdir(folder))
    except OSError:
        return []


def installed_at(path: str) -> tuple[float, str]:
    """When a release was installed: its folder changes last when npm adds
    node_modules. Names are no guide: they have been stamped in local time and
    in UTC (11-25), which put the newest release first."""
    try:
        return (os.stat(path).st_mtime, path)
    except OSError:
        return (0.0, path)


def old_releases(base: str) -> list[str]:
    """Releases other than the live one and the most recently installed others
    to keep. Without a live release that is one of them, nothing is chosen."""
    folder = os.path.join(base, "releases")
    current = os.path.join(base, "current")
    if not os.path.islink(current):
        return []
    live = os.path.realpath(current)
    releases = [p for p in entries(folder) if os.path.isdir(p) and not os.path.islink(p)]
    if live not in (os.path.realpath(p) for p in releases):
        return []
    others = sorted((p for p in releases if os.path.realpath(p) != live), key=installed_at)
    return others[: max(0, len(others) - (KEEP_RELEASES - 1))]


def old_logs(base: str, now: float) -> list[tuple[str, str]]:
    folder = os.path.join(base, "logs")
    names = entries(folder)
    runs = [p for p in names if os.path.basename(p).startswith("run-") and p.endswith(".jsonl")]
    marks = [p for p in names if os.path.basename(p).startswith("notified-")]
    chosen = [
        (p, f"older than {LOG_DAYS} days")
        for p in runs[:-1] + marks
        if now - newest_change(p) > LOG_DAYS * DAY
    ]
    gone = {p for p, _ in chosen}
    # Run logs are named by start time, so name order is age order. The
    # newest is the run that is writing now.
    kept = [p for p in runs if p not in gone]
    size = sum(tree_bytes(p) for p in kept)
    for path in kept[:-1]:
        if size <= LOG_BYTES:
            break
        size -= tree_bytes(path)
        chosen.append((path, f"run logs over {LOG_BYTES // 1024**2} MB"))
    return chosen


def old_transcripts(home: str, now: float) -> list[str]:
    antigravity = os.path.join(home, ".gemini", "antigravity-cli")
    candidates = entries(os.path.join(antigravity, "conversations")) + entries(
        os.path.join(antigravity, "brain")
    )
    for folder in (
        os.path.join(home, ".codex", "sessions"),
        os.path.join(home, ".codex", "archived_sessions"),
        os.path.join(home, ".claude", "projects"),
    ):
        for root, _dirs, files in os.walk(folder):
            candidates += [os.path.join(root, f) for f in sorted(files) if f.endswith(".jsonl")]
    return [p for p in candidates if now - newest_change(p) > TRANSCRIPT_DAYS * DAY]


def plan(base: str, home: str, now: float) -> list[tuple[str, str]]:
    chosen = [(p, f"older than the {KEEP_RELEASES} releases kept") for p in old_releases(base)]
    chosen += old_logs(base, now)
    chosen += [(p, f"transcript older than {TRANSCRIPT_DAYS} days") for p in old_transcripts(home, now)]
    cache = os.path.join(home, ".npm", "_cacache")
    if tree_bytes(cache) > NPM_CACHE_BYTES:
        chosen.append((cache, f"npm cache over {NPM_CACHE_BYTES // 1024**2} MB"))
    return chosen


MODES = ("main", "retry", "final")
SNAPSHOT = re.compile(r"^litscout-state-(\d{8})-(\d{6})\.tar\.xz$")
RUN_LOG = re.compile(r"^run-(\d{8})T(\d{6})Z-(main|retry|final)\.jsonl$")


def stamp(day: str, clock: str) -> str:
    """A file name's UTC stamp (YYYYMMDD, HHMMSS) as an ISO time."""
    return f"{day[:4]}-{day[4:6]}-{day[6:]}T{clock[:2]}:{clock[2:4]}:{clock[4:]}Z"


def newest_snapshot(base: str) -> dict | None:
    found = [
        (m.group(1) + m.group(2), path, m)
        for path in entries(os.path.join(base, "backups"))
        if (m := SNAPSHOT.match(os.path.basename(path)))
    ]
    if not found:
        return None
    _key, path, m = max(found)
    return {"at": stamp(m.group(1), m.group(2)), "bytes": tree_bytes(path)}


def run_failed(path: str) -> bool:
    """A step exited with something other than 0 (done) or 2 (nothing to do)."""
    try:
        with open(path, encoding="utf-8") as log:
            for line in log:
                try:
                    if json.loads(line).get("exit") not in (0, 2):
                        return True
                except (ValueError, AttributeError):
                    return True
    except OSError:
        return True
    return False


def newest_runs(base: str) -> list[dict]:
    newest: dict[str, tuple[str, str, re.Match]] = {}
    for path in entries(os.path.join(base, "logs")):
        m = RUN_LOG.match(os.path.basename(path))
        if m and (m.group(3) not in newest or m.group(1) + m.group(2) > newest[m.group(3)][0]):
            newest[m.group(3)] = (m.group(1) + m.group(2), path, m)
    return [
        {"mode": mode, "startedAt": stamp(m.group(1), m.group(2)), "failed": run_failed(path)}
        for mode in MODES
        if mode in newest
        for _key, path, m in [newest[mode]]
    ]


def write_status(file: str, base: str, footprint_bytes: int) -> None:
    status = {
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "footprintBytes": footprint_bytes,
        "warningBytes": WARN_BYTES,
        "capBytes": CAP_BYTES,
        "snapshot": newest_snapshot(base),
        "runs": newest_runs(base),
    }
    partial = file + ".partial"
    with open(partial, "w", encoding="utf-8") as out:
        json.dump(status, out)
    os.replace(partial, file)


def shown(path: str, home: str) -> str:
    """A path as the report shows it: relative to HOME when inside it."""
    inside = os.path.commonpath([path, home]) == home
    return os.path.relpath(path, home) if inside else path


def remove(path: str) -> None:
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.remove(path)


def footprint(base: str, home: str) -> int:
    inside = os.path.commonpath([base, home]) == home
    return tree_bytes(home) + (0 if inside else tree_bytes(base))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Keep LitScout's files within their limits.")
    parser.add_argument("base")
    parser.add_argument("--home", default=os.path.expanduser("~"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--status-file")
    options = parser.parse_args(argv)
    base, home = os.path.realpath(options.base), os.path.realpath(options.home)
    if not any(os.path.isdir(os.path.join(base, name)) for name in ("logs", "releases")):
        print(json.dumps({"success": False, "data": {"message": f"{base} is not a LitScout folder"}}))
        return 1
    before = footprint(base, home)
    removed, failed = [], []
    for path, reason in plan(base, home, time.time()):
        size = tree_bytes(path)
        try:
            if not options.dry_run:
                remove(path)
        except OSError as error:
            failed.append({"path": shown(path, home), "error": error.strerror or str(error)})
            continue
        removed.append({"path": shown(path, home), "bytes": size, "reason": reason})
    freed = sum(item["bytes"] for item in removed)
    after = before - freed if options.dry_run else footprint(base, home)
    if options.status_file:
        # The facts as they stand now: a dry run has removed nothing.
        write_status(options.status_file, base, before if options.dry_run else after)
    print(json.dumps({
        "success": not failed,
        "data": {
            "dryRun": options.dry_run,
            "footprintBefore": before,
            "footprint": after,
            "freed": freed,
            "warningBytes": WARN_BYTES,
            "capBytes": CAP_BYTES,
            "overWarning": after > WARN_BYTES,
            "overCap": after > CAP_BYTES,
            "removed": removed,
            "failed": failed,
        },
    }))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
