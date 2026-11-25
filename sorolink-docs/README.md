# SoroLink Docs

The documentation source for the SoroLink project.

## Product definition

- [MVP specification](./MVP.md)
- [System architecture](./ARCHITECTURE.md)
- [Backend API contract](./API.md)
- [Scenario format](./SCENARIOS.md)
- [Terminology glossary](./GLOSSARY.md)
- [Issued asset payment lifecycle](./LIFECYCLE_ISSUED_ASSET_PAYMENT.md)
- [Contributor backlog](./BACKLOG.md)
- [20 additional contributor issues — 19 October 2026](./ADDITIONAL_ISSUES_2026-10-19.md)

## Architecture Decision Records

Key decisions are documented as ADRs in [`adr/`](./adr/).

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-0001](./adr/0001-testnet-only-boundary.md) | Testnet-only network boundary | Accepted |
| [ADR-0002](./adr/0002-fastify-over-express.md) | Fastify over Express for the HTTP layer | Accepted |
| [ADR-0003](./adr/0003-in-memory-default-store.md) | In-memory store as the default persistence backend | Accepted |

New ADRs should follow the [template](./adr/0000-template.md).

## Planned content

- Product overview and quick start
- Scenario authoring guide
- Frontend and backend integration guides
- API reference
- Soroban contract reference
- Architecture and security decisions
- Maintainer and contributor guides

## Status

The MVP contract is defined. Implementation should follow the phases and exit
criteria in `MVP.md`.
