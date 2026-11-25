# SoroLink vs alternatives

This document compares SoroLink with other tools commonly used to test and explore
Stellar payment flows: **Stellar Lab**, **Stellar Quickstart Docker**, and
**hand-written SDK tests**.

> **Note:** SoroLink is at MVP stage and is restricted to Stellar Testnet.
> The comparisons below reflect that scope honestly.

## Comparison table

| Attribute | SoroLink | Stellar Lab | Stellar Quickstart Docker | Hand-written SDK tests |
|-----------|----------|-------------|--------------------------|------------------------|
| **Automation** | Full — scenarios run end-to-end without manual clicks | None — every action is manual | None — provides a local node; test automation is DIY | Full — you write the automation |
| **Repeatability** | High — YAML scenarios are version-controlled and reproducible | Low — browser state is ephemeral; steps must be re-entered | Medium — node state resets on restart; tests still require manual or custom scripts | High — but repeatability depends entirely on test quality |
| **CI support** | First-class — CLI exits non-zero on failure; JSON output for parsing | None | None out of the box | Full — standard test runner integration |
| **Error messages** | Scenario-aware: reports which step failed, the assertion, expected vs actual | Raw Stellar API errors; no contextual help | Raw Stellar API errors | Depends on how much error handling you write |
| **Scenario sharing** | Yes — YAML files are human-readable and shareable via version control | No | No | Possible but requires sharing code, not config |
| **Learning curve** | Low — write YAML; no SDK knowledge required | Very low — GUI; no code required | Medium — Docker + partial SDK setup required | High — requires deep `@stellar/stellar-sdk` knowledge |
| **Testnet only** | Yes (MVP) | No — supports Mainnet | No — supports Mainnet (with caution) | No — depends on how you configure it |
| **Soroban / smart contract support** | Not in MVP | Yes | Yes | Yes |
| **Local network** | No — hits Stellar Testnet | No | Yes | No (by default) |

## When to use each tool

### Use SoroLink when

- You want to validate payment flows, trustline behaviour, and error scenarios
  automatically in CI without writing SDK code.
- You are running a contribution campaign or coordinating test coverage across a team.
- You want scenario definitions that non-engineers can read and review.

### Use Stellar Lab when

- You are exploring the Stellar API interactively for the first time.
- You need a quick one-off transaction and do not want to set anything up.
- You are debugging a specific API call and want immediate visual feedback.

### Use Stellar Quickstart Docker when

- You need a local, isolated Stellar network with no rate limits.
- You are developing against a custom or forked Stellar core version.
- You want deterministic ledger state without hitting shared Testnet.

### Use hand-written SDK tests when

- You need to test Soroban smart contracts or features outside SoroLink's MVP scope.
- You have complex, stateful scenarios that YAML cannot express.
- You are building a production system and need integration tests tightly coupled to
  your application's code.

## SoroLink limitations to be aware of

- **Testnet only** — there is no Mainnet mode and no plan to add one in MVP.
- **No Soroban support** — smart contract invocations are not supported yet.
- **No local network** — all runs hit the shared Stellar Testnet; Friendbot
  rate limits apply.
- **YAML expressiveness** — highly dynamic test logic (loops, conditionals,
  generated fixture data) is better expressed in code.

## See also

- [CI_INTEGRATION.md](./CI_INTEGRATION.md) — how to run SoroLink scenarios in
  GitHub Actions, GitLab CI, and CircleCI
- [SCENARIOS.md](./SCENARIOS.md) — full YAML scenario reference
- [Stellar Lab](https://lab.stellar.org) — interactive browser tool
- [Stellar Quickstart Docker](https://github.com/stellar/quickstart) — local node
