#!/usr/bin/env python3
"""Push a notification after a scheduled run, only when the owner should act.

Usage: notify.py RUN_LOG MODE [--state DIR] [--url-file FILE] [--home DIR] [--dry-run]

Reads the JSON-lines log that daily-run.sh writes and sends one ntfy message
listing what needs attention:

- a step failed (exit code other than 0 or 2, or status error);
- a client failed its login check, or the run fell back to another client;
- a client's usage limit paused the run;
- after the final run, the day has no digest;
- the LitScout user's home passed its 4 GB warning level or the 5 GB cap
  (--home; housekeep.py keeps the files within their limits).

The same item is sent once a day (state/notified-YYYY-MM-DD). Without a URL
file nothing is sent. --dry-run prints the message instead.
"""

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

DIGEST_OK = {"written", "exists", "written-no-batch", "no-new-batch", "sunday-stop"}
WARN_BYTES = 4 * 1024**3
CAP_BYTES = 5 * 1024**3


def parse(output: str):
    try:
        return json.loads(output)
    except ValueError:
        start = output.find("{")
        if start < 0:
            return None
        try:
            return json.JSONDecoder().raw_decode(output[start:])[0]
        except ValueError:
            return None


def folder_bytes(folder: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(folder):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def items(log_path: str, mode: str, home: str | None):
    found: list[str] = []
    day = None
    for line in open(log_path, encoding="utf-8"):
        record = json.loads(line)
        step, code = record["step"], record["exit"]
        result = parse(record["output"]) or {}
        data = result.get("data") if isinstance(result.get("data"), dict) else {}
        status = data.get("status")
        day = data.get("day") or data.get("targetDay") or day
        if code not in (0, 2) or status == "error" or result.get("success") is False:
            message = data.get("message") or status or f"exit {code}"
            found.append(f"{step} failed: {str(message)[:160]}")
        for check in data.get("preflight") or []:
            if isinstance(check, dict) and check.get("usable") is False:
                found.append(f"{check.get('client')} login check failed: {check.get('reason')}")
        for switch in data.get("fallback") or []:
            if isinstance(switch, dict):
                found.append(
                    f"{step} fell back from {switch.get('from')} to {switch.get('to')}: {str(switch.get('reason'))[:120]}"
                )
        # "chunk budget" is the per-run chunk limit; the next run continues.
        if status == "paused" and data.get("stopped") != "chunk budget":
            found.append(f"{step} paused: a client's usage limit was reached")
        if mode == "final" and step == "digest" and status not in DIGEST_OK:
            found.append(f"no digest for {data.get('day') or day} after the last retry ({status})")
    if home and os.path.isdir(home):
        used = folder_bytes(home)
        if used > CAP_BYTES:
            found.append(f"storage at {used / 1024**3:.1f} GB, over the 5 GB cap")
        elif used > WARN_BYTES:
            found.append(f"storage at {used / 1024**3:.1f} GB (warning level 4 GB)")
    # Keep order, drop repeats.
    return list(dict.fromkeys(found)), day


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("log")
    parser.add_argument("mode")
    parser.add_argument("--state", default=None)
    parser.add_argument("--url-file", default=None)
    parser.add_argument("--home", default=None)
    parser.add_argument("--dry-run", action="store_true")
    options = parser.parse_args(argv)
    found, day = items(options.log, options.mode, options.home)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    seen_file = os.path.join(options.state, f"notified-{today}") if options.state else None
    seen = set()
    if seen_file and os.path.exists(seen_file):
        seen = set(open(seen_file, encoding="utf-8").read().splitlines())
    fresh = [item for item in found if item not in seen]
    if not fresh:
        return 0
    body = "\n".join(f"- {item}" for item in fresh)
    title = f"LitScout {options.mode} run" + (f" ({day})" if day else "")
    if options.dry_run:
        print(title)
        print(body)
        return 0
    url = None
    if options.url_file and os.path.exists(options.url_file):
        url = open(options.url_file, encoding="utf-8").read().strip()
    if not url:
        return 0
    failed = any("failed" in item or "no digest" in item for item in fresh)
    request = urllib.request.Request(
        url,
        data=body.encode("utf-8"),
        method="POST",
        headers={
            "Title": title,
            "Priority": "high" if failed else "default",
            "Tags": "warning" if failed else "information_source",
            "User-Agent": "litscout-server",
        },
    )
    urllib.request.urlopen(request, timeout=20).read()
    if seen_file:
        os.makedirs(os.path.dirname(seen_file), exist_ok=True)
        with open(seen_file, "a", encoding="utf-8") as out:
            out.write("".join(f"{item}\n" for item in fresh))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
