#!/usr/bin/env bash
# Take the README's pictures again: screenshots of the demo day and a GIF of
# a triage pass, from the fixture reader with its invented papers.
#
#   tools/readme-images.sh
#
# Needs Playwright's Chromium (pnpm exec playwright install chromium) and
# ffmpeg. Writes docs/images/*.png and docs/images/triage.gif. Run it after a
# change to the reader that the pictures should show.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
OUT=docs/images
LITSCOUT_README=1 LITSCOUT_DEMO=1 pnpm exec playwright test \
  apps/web/e2e/readme.spec.ts --project=desktop
# Two passes: the first builds a palette from the recording, so the GIF
# keeps the reader's colours at a small size.
ffmpeg -y -v error -ss 0.8 -i "$OUT/.recording.webm" -vf \
  "fps=6,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  "$OUT/triage.gif"
rm -rf "$OUT/.recording" "$OUT/.recording.webm"
ls -l "$OUT"
