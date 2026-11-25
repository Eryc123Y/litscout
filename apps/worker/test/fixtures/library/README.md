# Library response fixtures

All tests use local files and mocked fetch. Only fields used by the resolver are
kept. The fixtures contain no credentials or request headers.

| File | Provenance |
| --- | --- |
| `openalex.json` | OpenAlex work lookup for DOI `10.1371/journal.pone.0000308`, 2026-11-18. |
| `crossref.json` | Crossref single-work response for the same DOI, 2026-11-18. |
| `semantic-scholar.json` | Paper record for `10.1093/mind/lix.236.433` from the [semanticscholar client test data](https://github.com/danielnsilva/semanticscholar/blob/master/tests/data/Paper.json). The existing replay fixtures also contain a real HTTP 429. |
| `unpaywall.json` | Response fields for `10.1103/physreve.88.012814` from the [Unpywall test response cache](https://github.com/unpywall/unpywall/blob/master/tests/unpaywall_cache). Extracted the public JSON response fields without loading the serialized objects. |
| `core.json` | CORE v3 work search by DOI `10.1371/journal.pone.0000308`, 2026-11-18. |

Purpose-built fixtures in the tests cover publisher redirects and citation
metadata, an edition collision, a forum response, throttling and size limits.
