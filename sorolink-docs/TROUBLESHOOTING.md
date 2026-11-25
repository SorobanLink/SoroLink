# SoroLink Troubleshooting Guide

This guide covers the most common failure modes when running SoroLink locally or
on a hosted deployment, with symptoms, causes, and resolution steps.

See also [TESTNET_RESET_RECOVERY.md](./TESTNET_RESET_RECOVERY.md) for Testnet
reset specific steps.

---

### Render cold start — first request takes 30–60 seconds

**Symptom:** The first page load or API call after a period of inactivity takes
30–60 seconds. Subsequent calls respond normally.

**Cause:** Render's free tier spins down services after 15 minutes of inactivity.
The first incoming request triggers a cold start.

**Resolution:**
- Use a free uptime monitor (UptimeRobot, Cron-job.org) to ping `GET /health`
  every 10–14 minutes.
- Upgrade to a paid Render plan for always-on behaviour.
- Accept the delay if the deployment is for occasional use only.

---

### Rate limiting — 429 Too Many Requests

**Symptom:** API calls return `HTTP 429` with a `Retry-After` header. The CLI
prints "rate limit exceeded" or exits with code 1.

**Cause:** `RATE_LIMIT_MAX` (default 100 requests per `RATE_LIMIT_WINDOW_MS`)
or `RUN_RATE_LIMIT_MAX` (default 10 scenario runs per window) has been reached
for the client IP. Limits are per-IP and per-process — they are **not** shared
across multiple replicas.

**Resolution:**
- Wait for the window to reset (see the `Retry-After` header value in seconds).
- Increase `RATE_LIMIT_MAX` or `RUN_RATE_LIMIT_MAX` in your `.env` file.
- Spread runs across time, or stagger CI jobs.
- See [RATE_LIMITING.md](./RATE_LIMITING.md) for per-deployment tuning guidance.

**429 response body:**
```json
{ "error": "Too many requests", "retryAfter": 42 }
```

---

### Sequence conflicts — scenario fails with `tx_bad_seq`

**Symptom:** A run fails mid-way with a Stellar `tx_bad_seq` error. This is
especially common when running concurrent scenarios against the same account.

**Cause:** Each Stellar transaction must reference the account's current
sequence number. If two operations submit against the same account
simultaneously, only one can succeed; the other references a stale sequence.

**Resolution:**
- SoroLink generates fresh ephemeral Testnet accounts per run. Sequence
  conflicts only appear if you have customised scenarios to reuse persistent
  keys.
- Do not reuse secret keys across concurrent scenarios.
- If running your own seeds in a scenario, add a short delay or use separate
  accounts per concurrent run.

---

### Testnet reset — funded accounts and published scenarios disappear

**Symptom:** Previously funded accounts return "Account not found". Published
scenarios reference balances or ledger states that no longer exist.

**Cause:** The Stellar Testnet is periodically reset (roughly quarterly). All
account balances and ledger state are wiped.

**Resolution:**
- SoroLink generates fresh accounts per run, so built-in scenarios self-recover.
- For published scenarios that reference persistent accounts, re-fund those
  accounts via Friendbot and republish.
- Check the [Testnet reset recovery guide](./TESTNET_RESET_RECOVERY.md) for
  full steps.

---

### Missing trustline — `op_no_trust`

**Symptom:** An issued-asset payment fails with `op_no_trust` or "No trust line
for asset" in the run report.

**Cause:** The receiving account has not established a trustline for the issued
asset before the payment is attempted.

**Resolution:**
- Use a scenario that includes a `createTrustline` step before the `payment`
  step (see `sorolink-docs/SCENARIOS.md`).
- The bundled `missing-trustline` scenario deliberately triggers this error to
  demonstrate controlled failure reporting — it is not a bug.

---

### Friendbot unavailable — funding step times out

**Symptom:** A run stalls or fails at "Fund accounts" with a network error or
timeout. The JSON report shows `status: "failed"` on the `fundAccounts` step.

**Cause:** Friendbot (the Stellar Testnet faucet) is temporarily unavailable,
rate-limited, or responding slowly.

**Resolution:**
- Retry the run after a few minutes. Friendbot outages are usually brief.
- Check [Stellar status](https://status.stellar.org) for active incidents.
- In CI, use a retry step (see [CI_INTEGRATION.md](./CI_INTEGRATION.md) for a
  retry example using `nick-invision/retry`).

---

### CORS errors — browser console shows "blocked by CORS policy"

**Symptom:** The frontend dashboard fails to reach the backend. The browser
console shows `Access to fetch at '…' from origin '…' has been blocked by CORS
policy`.

**Cause:** `CORS_ORIGIN` on the backend does not include the frontend's origin,
or the variable is missing.

**Resolution:**
- Set `CORS_ORIGIN` to the frontend's exact origin, e.g.
  `https://sorolink-testnet.vercel.app`.
- For local development, set `CORS_ORIGIN=http://localhost:3000`.
- Do not use `*` in production — it disables the same-origin restriction.

---

### Database migration failures — backend exits or fails readiness

**Symptom:** The backend starts but fails its readiness check, or exits
immediately with `migration check failed` or `role bootstrap required`.

**Cause:** `PERSISTENCE_MODE=published` requires a PostgreSQL database with the
correct schema. Missing `DATABASE_URL`, un-run migrations, or stale fixtures
all trigger this.

**Resolution:**
1. Run `psql "$DATABASE_URL" -f sorolink-backend/db/bootstrap-roles.sql` to
   create the required role.
2. Run `npm run db:migrate` from `sorolink-backend/`.
3. Run `npm run db:seed` to apply fixture reconciliation.
4. If you are developing without PostgreSQL, set
   `PERSISTENCE_MODE=disabled` and remove `DATABASE_URL` from your `.env`.

---

### CLI exit code confusion — CLI exits 0 but a step failed

**Symptom:** The CLI exits with code 0 even though a step shows as `failed` in
the report. CI passes when it should fail.

**Cause:** This happens when an *expected* failure scenario passes (the step
failed as designed, so the scenario is `passed`). Unexpected failures always
produce exit code 1.

**Resolution:**
- Review the scenario's `expectedFailure` field. If a step is expected to fail,
  a failure is a pass.
- Use `--output json` to inspect the `status` field on each step individually.
- See [SCENARIOS.md](./SCENARIOS.md) for the `expectedFailure` schema.

---

### Concurrent run limit — 429 on `POST /runs`

**Symptom:** Starting a new scenario run returns `HTTP 429` immediately,
regardless of the global rate limit.

**Cause:** `RUN_RATE_LIMIT_MAX` (default 10 per window) caps how many scenario
runs can be started per IP per window, independently of `RATE_LIMIT_MAX`.

**Resolution:**
- Reduce parallel test runs or stagger them across the window.
- Increase `RUN_RATE_LIMIT_MAX` for high-throughput CI environments.
- See [RATE_LIMITING.md](./RATE_LIMITING.md) for configuration examples.

---

### `npm run check:tokens` exits with no hint about which file is missing

**Symptom:** `npm run check:tokens` fails with a generic error and no file name.

**Cause:** A design token file is missing or malformed, but the check script
does not name the file.

**Resolution:**
- Run `npm run check:tokens -- --verbose` if supported, or examine the
  `sorolink-frontend/tokens/` directory for missing or empty files.
- Compare against the reference in `sorolink-docs/ARCHITECTURE.md`.
