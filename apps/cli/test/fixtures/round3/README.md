# Round 3 page and watch fixtures

`arxiv-new.html` and `arxiv-recent.html` were recorded from public arXiv pages
with requests spaced at least three seconds apart. URLs, times and SHA-256
hashes are in `pages-provenance.json`. The new page contains 91 retained papers
and labels them Monday, 16 November 2026, despite the UTC recording being
November 17. No contact strings required redaction.

`arxiv-friday-excerpt.html` is a DOM excerpt of the real Friday, November 13
block in that recent page, wrapped in `#dlpage` for parsing. It changes no
listing dates or paper records. A past Friday `/new` page cannot be fetched
from the current `/new` URL; this recorded excerpt tests staleness without
inventing a historical date or listing.

`venues.json` is the public 63-venue reference watch list. The venue tests replay
an actual LMCS record from the November 11 data-branch fixture; they do not make
live Crossref, OpenAlex or staging requests. They assert the first-run seven-day
window and compare the raw watch shape with the pipeline's normalized record.
