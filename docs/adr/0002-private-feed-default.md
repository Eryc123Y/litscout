# ADR 0002: private feed by default

- Status: accepted by the M1b round 2 brief, 2026-11-17.
- Scope: config default, self-host template and instance discovery.

## Context

Public reading also exposes topic names. New installations must make that choice
explicitly; a private instance's sign-in landing does not need research settings.

## Decision

`instance.publicFeed` defaults to `false`. The template opts out, and publishing
requires explicit `true`. Signed-out instance discovery then returns only the
generic LitScout name. Verified Access or read-scoped bearer callers retain the
full instance payload. The browser treats an omitted public flag as false.

## Consequences

Existing explicit `true` configurations, including the owner's staging configuration,
keep their chosen public behaviour. Missing Worker vars continue to fail closed.
Public reads have a shared 60-per-minute IP limit; validation responses omit field
details. These changes require no schema migration and no deployed change here.
