# SoroLink

**Test with confidence. Build on Stellar.**

SoroLink is an open-source scenario testing toolkit for Stellar payments and,
later, Soroban applications. It turns multi-step ledger flows into repeatable
tests with readable execution reports.

## Repositories

| Repository | Purpose |
| --- | --- |
| `sorolink-frontend` | Scenario dashboard and execution reports |
| `sorolink-backend` | Stellar Testnet scenario runner and API |
| `sorolink-contracts` | Soroban test fixtures and contracts |
| `sorolink-docs` | Product, architecture, API, and contributor documentation |
| `.github` | Shared organization standards and templates |

## Current scope

The MVP tests classic Stellar payment flows on Testnet: XLM payments, issued
assets, trustlines, expected failures, and balance assertions. SoroLink never uses
real funds or stores generated secret keys.

## Contributing

Start with a labelled, unassigned issue. Comment with a short implementation
plan and wait for assignment before opening a pull request. Read the shared
contribution and security guidance before working on an issue.

