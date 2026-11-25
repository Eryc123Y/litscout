# Three complete archived feed days

These are complete raw JSONL files read with `git show` from the local
`litscout-daily` data-branch commit recorded in `provenance.json`. No checkout,
fetch or write occurred in the reference repository. The fixtures contain:

| Day | Raw papers | Venue papers |
|---|---:|---:|
| 2026-11-10 | 1,124 | 0 |
| 2026-11-11 | 838 | 283 |
| 2026-11-12 | 418 | 418 |

The November 11 file has three genuine LMCS DOI URLs containing parentheses,
including `10.46298/lmcs-22(4:18)2026`. These reproduce the failed conversion
before URL normalization. Original and copied hashes match; no public contact
strings required redaction. Fault-injection tests derive malformed rows from
these records in memory and do not alter the fixture files.

The CLI dry-run test creates its own temporary Git repository with a `data`
branch. It imports no vault content and makes no API/model calls. These new
fixtures cover raw listings; existing fixtures still cover bilingual summaries,
run logs and digest metadata.
