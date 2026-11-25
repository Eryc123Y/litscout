# ADR 0003: The vault owns research, LitScout owns papers

- Status: accepted (2026-11-17)
- Supersedes: spec §5.1 rows for ideas and working papers, §5.3 vault export of ideas and working papers, §5.5 two-way sync.

## Context

The owner's ideas, working papers, paper notes and projects already live in his Obsidian vault, with conventions of their own:

- capture in `Inbox.md`, then promotion into notes;
- paper notes in topic folders, with rich frontmatter;
- synthesis notes in a folder of their own;
- projects in a folder of their own.

LitScout is a personal tool built around that vault, with no commercial plan. Others can self-host it from the template.

The first spec made LitScout the owner of ideas and working papers and exported read-only copies to the vault. That would split the owner's research between two places, and it would put unpublished ideas on a server.

## Decision

Every piece of data has one writer.

- **Vault only:** the text of ideas, working papers and paper notes; Inbox; plans; private notes. None of it is uploaded. The scheduled run on the Mac reads it to rank papers and suggest ideas.
- **Vault, shown in LitScout:** an index of projects, idea notes, working papers and paper notes (titles, configured frontmatter keys, paths, hashes). It is read-only in the web app and refreshed by every `litscout sync`.
- **LitScout, copied into the vault:** papers, summaries, digests, library and quick notes. They are written as digest notes and inside `<!-- litscout:begin/end -->` blocks only.
- **Handoff:** ideas captured on the web and accepted suggestions go to `Inbox.md`. Links, status changes, reading-list additions and "make a vault note" are queued requests that the next sync applies. If the note changed meanwhile, the vault wins.

The Worker and web app never write to the vault; only `litscout sync` on the Mac does.

## Consequences

- The web app loses the idea and outline editors. Ideas become a board over the vault index, with capture and requests; working papers become a reading view. M3 shrinks.
- New tables: `vault_notes`, `idea_index`, `working_paper_index`, `captures`, `vault_requests`. `ideas`, `idea_links`, `working_papers`, `working_paper_ideas` and `profile_docs` with bodies are dropped from the plan.
- Remote MCP clients see the index only. Discussion of full ideas happens in Claude Code inside the vault.
- `profile sync` and `export vault` merge into one `litscout sync`, behind `VaultSource`/`VaultSink` interfaces, so a vault that moves later needs no schema change.
- Self-hosters without a vault keep the feed and library; ideas need a Markdown folder.
