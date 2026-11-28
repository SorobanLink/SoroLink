# ADR-0001: Testnet-only network boundary

**Status:** Accepted

**Date:** 2024-09-10

## Context

SoroLink is a developer tool for running Stellar scenarios against a live
network. Early contributors asked whether the runner should support Mainnet,
Futurenet, and custom RPC endpoints in addition to Testnet.

Supporting Mainnet would let accidental or malformed scenarios drain real
funds. Futurenet resets frequently, making reproducible CI results hard to
guarantee. Custom RPC endpoints add an authentication and secret-management
surface that is out of scope for a scenario-testing tool.

The official Testnet Friendbot funds generated accounts for free and resets
roughly quarterly, which is consistent with the tool's purpose: demonstrating
and validating flows, not operating production infrastructure.

## Decision

SoroLink's scenario runner only targets Stellar Testnet. The network field in
scenario definitions is accepted as a schema field but the backend rejects any
value other than `"testnet"` at validation time.

## Consequences

### Positive
- Zero risk of real-fund loss from scenario mistakes.
- No credential management for Mainnet keys.
- Friendbot integration is simple and always available on Testnet.
- CI runs are deterministic within a Testnet epoch.

### Negative / trade-offs
- Users who need Mainnet smoke tests cannot use SoroLink directly.
- Testnet resets (roughly quarterly) invalidate any state-dependent scenario
  that relies on previously submitted transactions.

### Neutral
- The `network` field is kept in the schema to allow future extension without
  a breaking schema change.

## Alternatives considered

| Alternative | Reason not chosen |
|-------------|-------------------|
| Support all networks via `network` field | Mainnet risk; scope creep |
| Support Futurenet | Frequent resets break reproducibility |
| Custom RPC endpoint | Auth/secret surface out of scope |
