# ADR-0003: In-memory store as the default persistence backend

**Status:** Accepted

**Date:** 2024-09-15

## Context

SoroLink needs to persist scenario run history so that the CLI and frontend
can display results after the scenario finishes. The question was whether to
require a PostgreSQL database as a hard dependency or make persistence
optional with a zero-configuration default.

Requiring PostgreSQL for a first run creates friction: contributors need a
running database before they can test even a basic scenario. The Docker Compose
file already provisions a database for integration testing, but that path is
not obvious to a developer cloning the repo for the first time.

An in-memory store satisfies all functional requirements for a single-process
development session. Run history is lost on restart, which is acceptable for
local development and CI where each run starts fresh anyway.

## Decision

Implement a `MemoryRunStore` that satisfies the `RunStore` interface and use it
as the default when `DATABASE_URL` is not set. When `DATABASE_URL` is set, the
backend substitutes `PostgresRunStore` at startup without any other
configuration change.

## Consequences

### Positive
- Zero external dependencies for `npm run dev` or a local `npm test`.
- The store interface is well-defined; swapping implementations is a single
  dependency injection point in `src/app.ts`.
- CI unit tests run entirely in memory with no database setup step.

### Negative / trade-offs
- Run history is lost on restart when using the in-memory store.
- Developers who run the backend in `--watch` mode and restart it will lose
  previous results, which can be confusing.
- The two store implementations can diverge silently; integration tests must
  be run against PostgreSQL before a release.

### Neutral
- Both stores are covered by the same abstract test suite
  (`test/run-store.spec.ts`) to prevent silent divergence.

## Alternatives considered

| Alternative | Reason not chosen |
|-------------|-------------------|
| Require PostgreSQL always | Too much friction for first-run; CI overhead |
| SQLite as default | Adds a native module dependency; not meaningful for ephemeral CI |
| File-system JSON store | Complicates cleanup in tests; in-memory is simpler |
