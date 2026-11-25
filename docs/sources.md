# Paper sources and their keys

LitScout reads papers from public services. Most of them need nothing from
you. A few work better, or only, with a key or an account of your own. This
page lists every source, what LitScout uses it for, and where its key goes
in each way of running LitScout.

You can start with no keys at all: the arXiv feed, Hugging Face daily
papers, most journals and conferences, and keyword matching all work
without them. Add keys later, when a check or a log line asks for one.

## The sources

### Needs nothing

| Source                                                     | Used for                                                                           | Turned on by                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [arXiv](https://arxiv.org)                                 | The daily listing for your categories; abstracts and lookups by arXiv ID           | `sources.arxiv.categories` in the config                   |
| [Hugging Face daily papers](https://huggingface.co/papers) | Papers the community picks each day, and their upvotes                             | `sources.huggingface.dailyPapers` (on by default)          |
| [Crossref](https://www.crossref.org)                       | Journals by ISSN, proceedings by DOI prefix or title, abstracts and lookups by DOI | `issn`, `doi_prefix` or `container_title` in `venues.json` |
| [DataCite](https://datacite.org)                           | Proceedings whose DOIs DataCite registers, such as the Dagstuhl LIPIcs series      | `doi_prefix` in `venues.json`                              |
| [ACL Anthology](https://aclanthology.org)                  | ACL, EMNLP, NAACL, EACL, CoNLL, TACL, CL and MOL                                   | `acl_anthology` in `venues.json`                           |
| [PMLR](https://proceedings.mlr.press)                      | Proceedings series such as COLT and AISTATS                                        | `pmlr` in `venues.json`                                    |
| [JMLR](https://www.jmlr.org)                               | New JMLR papers, from its RSS feed                                                 | `jmlr: true` in `venues.json`                              |
| [Europe PMC](https://europepmc.org)                        | Missing abstracts, by DOI                                                          | Always tried when an abstract is missing                   |

Crossref asks clients to give a contact address. If you set one
([below](#the-contact-address)), LitScout sends it, and Crossref serves the
requests from its faster pool.

### Works better with a key

| Source                                              | Used for                                                                                                                                 | Without a key                                                                                                                                                                | Key                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| [OpenAlex](https://openalex.org)                    | Conferences by `openalex_source`; abstracts, open-access links and arXiv IDs for papers found by DOI; author records; search through MCP | A small daily allowance shared by every keyless client on your IP address. Conference reads fail once it runs out, and papers found by DOI go out without abstracts or links | `OPENALEX_API_KEY` |
| [Semantic Scholar](https://www.semanticscholar.org) | Abstracts, citations, references and authors; adding a paper by title; search through MCP                                                | One request every three seconds instead of one a second, and more refusals on busy days                                                                                      | `S2_API_KEY`       |
| [Unpaywall](https://unpaywall.org)                  | Open-access links when you add a paper to the library                                                                                    | No open-access links from Unpaywall                                                                                                                                          | An email address   |

### Needs a key or an account

| Source                                            | Used for                                                             | Without it                                                | Key                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| [OpenReview](https://openreview.net)              | Accepted papers of venues with an `openreview` id, such as ICLR      | Those venues are skipped, with a warning in the log       | `OPENREVIEW_USERNAME` and `OPENREVIEW_PASSWORD`, or `OPENREVIEW_TOKEN` |
| [CORE](https://core.ac.uk)                        | Open-access full-text links when you add a paper; search through MCP | Not used                                                  | `CORE_API_KEY`                                                         |
| [IEEE Xplore](https://developer.ieee.org)         | Missing abstracts of IEEE papers (DOIs starting `10.1109/`)          | Those abstracts stay empty unless another source has them | `IEEE_API_KEY`                                                         |
| [Springer Nature](https://dev.springernature.com) | Missing abstracts of Springer papers (`10.1007/`)                    | The same                                                  | `SPRINGER_API_KEY`                                                     |
| [Elsevier](https://dev.elsevier.com)              | Missing abstracts of Elsevier papers (`10.1016/`)                    | The same                                                  | `ELSEVIER_API_KEY`                                                     |

The publisher keys only matter if you watch journals from those publishers.
LitScout tries the free sources first (OpenAlex, Semantic Scholar, arXiv,
Crossref, Europe PMC) and asks a publisher only for what is still missing.
What a publisher key returns depends on the plan the publisher gave you.

### alphaXiv

The alphaXiv mirror is not a key. Claude Code reads your alphaXiv library
through the alphaXiv connector of your claude.ai account; see
[Mirror the alphaXiv library](runbook/daily.md#mirror-the-alphaxiv-library).

## Getting the keys

- **OpenAlex:** create a free account at [openalex.org](https://openalex.org)
  and copy the API key from your account settings.
- **Semantic Scholar:** fill in the request form on the
  [Semantic Scholar API page](https://www.semanticscholar.org/product/api).
  The key arrives by email; it can take a few days.
- **Unpaywall:** nothing to request. Use an email address you read; Unpaywall
  and Crossref only use it to contact you about heavy use.
- **OpenReview:** a normal [openreview.net](https://openreview.net/signup)
  account. LitScout logs in with it at the start of each run. A separate
  account just for LitScout is a sensible choice.
- **CORE:** register on the [CORE API page](https://core.ac.uk/services/api).
- **IEEE Xplore, Springer Nature, Elsevier:** register an application on the
  publisher's developer site linked in the table above.

## Where the keys go

Keys are read in two places, and each place has its own file:

- **The server** answers the reader, the API and MCP. It uses OpenAlex,
  Semantic Scholar and CORE when you add a paper, look one up or search, and
  Unpaywall for open-access links.
- **The daily run** (`litscout daily fetch`) reads the sources and fills in
  abstracts. It uses OpenAlex, Semantic Scholar, OpenReview and the
  publisher keys, taken from its environment.

So `OPENALEX_API_KEY` and `S2_API_KEY` usually go in both places.

| Key                                                              | The server | The daily run |
| ---------------------------------------------------------------- | :--------: | :-----------: |
| `OPENALEX_API_KEY`                                               |    yes     |      yes      |
| `S2_API_KEY`                                                     |    yes     |      yes      |
| `CORE_API_KEY`                                                   |    yes     |               |
| `OPENREVIEW_USERNAME`, `OPENREVIEW_PASSWORD`, `OPENREVIEW_TOKEN` |            |      yes      |
| `IEEE_API_KEY`, `SPRINGER_API_KEY`, `ELSEVIER_API_KEY`           |            |      yes      |

### The contact address

The contact address for Unpaywall and Crossref is not a secret, so it lives
in the config, and both places read it from there:

```ts
library: { unpaywallEmail: "YOUR_EMAIL_ADDRESS" },
```

The daily run uses it from its next run. The server picks it up on the next
`litscout deploy` on Cloudflare, or on the next `litscout server init
--force` and restart on your own server or in a trial. An `UNPAYWALL_EMAIL`
in the daily run's environment takes precedence over the config.

### On Cloudflare

**The server.** `litscout keys` asks for `S2_API_KEY`, `OPENALEX_API_KEY`
and `CORE_API_KEY` without echoing them and uploads them as Worker secrets.
Leave a prompt blank to skip that key. `litscout deploy` asks the same
questions unless you pass `--skip-keys`; `--keys-from-env` takes them from
the environment instead. Run it as the user who deployed: it finds the
Worker through `~/.config/litscout`.

```sh
litscout keys
```

**The daily run.** The scheduler starts `litscout daily fetch` with an
environment of its own, so keep the keys in a private file and load it in
the scheduled command. Create the file once:

```sh
mkdir -p ~/.config/litscout
install -m 600 /dev/null ~/.config/litscout/sources.env
```

Add one `KEY=value` line per key, with no `export`. Put a value in single
quotes if it holds spaces or characters such as `$`, as a password may:

```text
OPENALEX_API_KEY=...
S2_API_KEY=...
OPENREVIEW_USERNAME=YOUR_OPENREVIEW_EMAIL
OPENREVIEW_PASSWORD=...
```

Then load it in front of the command in your cron entry or scheduled task:

```sh
set -a; . "$HOME/.config/litscout/sources.env"; set +a; litscout daily fetch --json --config "$CONFIG"
```

Do the same in a terminal before a fetch by hand.

### On your own server

**The server** reads `etc/secrets.env`, which `litscout server init` created
with the management token. Add `S2_API_KEY`, `OPENALEX_API_KEY` or
`CORE_API_KEY` lines to it, in the same `KEY=value` form, then restart the
service:

```sh
sudo systemctl restart litscout-server
```

This file takes only those names and the ones `server init` wrote; any
other name stops the server from starting, and the error names it. The
daily-run keys belong in the next file.

**The daily run** reads `etc/sources.env` (mode 600, owner `litscout`). The
`litscout-daily@.service` unit loads it when it exists, so every key in the
daily-run column goes there, in the same `KEY=value` form. Create it as the
`litscout` user:

```sh
install -m 600 /dev/null ~/litscout/etc/sources.env
```

The next timer run picks it up; nothing needs a restart.

### In a trial on your own computer

**The server** reads `~/litscout/etc/secrets.env`. Add the server keys there
as above, stop `serve` with Ctrl-C and start it again.

**The daily run** reads the environment of the terminal or cron entry that
starts it: use a `sources.env` file as in [On Cloudflare](#on-cloudflare).

## Check which keys are in use

- `litscout status` shows, for the server, whether Semantic Scholar and
  OpenAlex run with a key and whether CORE is configured, and how much of
  the day's OpenAlex allowance is left.
- The daily run's log says when it skips something for lack of a key: an
  OpenReview venue without a login, or papers found by DOI that went out
  without OpenAlex abstracts.
- `litscout doctor` checks the config, the server and the scheduler token.

## Using the sources directly

Two commands expose the daily run's source work on its own. They print JSON
Lines on standard output and every message on standard error, and they read
the same environment variables as the daily run.

```sh
# Journal and conference papers from your watchlist, one JSON object per line
litscout watch --since 2026-11-01 --venues ./venues.json [--kinds journal,conference] [--until 2026-11-20]

# Missing abstracts: up to 200 lines of {"id", "doi"?, "arxiv"?, "title"?} in,
# one {"id", "abstract", "source"} out per input line, in the same order
litscout abstracts < items.jsonl
```

The [watchlist format](self-host.md#venue-watchlist) says which field each
kind of venue takes.
