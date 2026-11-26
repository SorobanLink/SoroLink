# Rate Limiting

SoroLink's backend enforces two independent rate limits on every request:

| Variable | Default | Applies to |
|----------|---------|------------|
| `RATE_LIMIT_MAX` | `100` | All API requests (per IP, per window) |
| `RUN_RATE_LIMIT_MAX` | `10` | Scenario run starts (`POST /runs`) only |
| `RATE_LIMIT_WINDOW_MS` | `60000` (1 minute) | Both limits use the same window |

Both limits use a **fixed-window** counter. At the start of each window, counters
reset for all IPs.

## How the limits interact

A single `POST /runs` request increments **both** counters: the general counter
(toward `RATE_LIMIT_MAX`) and the run-specific counter (toward
`RUN_RATE_LIMIT_MAX`). All other requests (polling, listing, health) only
increment the general counter.

Practical consequence: a user who sends 10 `POST /runs` in one minute can still
make up to 90 more non-run requests in that window (if `RATE_LIMIT_MAX=100`),
but cannot start another run until the window resets.

## Per-IP, per-process

Both limits are enforced **per originating IP** and are stored **in-process**
(Node.js memory by default). They are **not** shared across multiple backend
replicas. If you deploy multiple backend instances behind a load balancer, each
instance enforces the limits independently — the effective combined limit from
the client's perspective is `RATE_LIMIT_MAX × number-of-replicas`.

For shared-state enforcement across replicas, configure `RATE_LIMIT_STORE=redis`
and set `REDIS_URL` (see `.env.example`).

## 429 response format

When a limit is exceeded the backend responds with:

```
HTTP 429 Too Many Requests
Retry-After: <seconds until the window resets>
Content-Type: application/json

{ "error": "Too many requests", "retryAfter": <seconds> }
```

The `Retry-After` header is an integer number of seconds. Clients should
honour it and not retry before it elapses.

## Example configurations

### Single-user local development

```dotenv
RATE_LIMIT_MAX=1000
RUN_RATE_LIMIT_MAX=50
RATE_LIMIT_WINDOW_MS=60000
```

One developer, no need for strict limits. High values avoid false positives
during rapid test iteration.

### Small team (3–10 developers sharing one backend)

```dotenv
RATE_LIMIT_MAX=500
RUN_RATE_LIMIT_MAX=30
RATE_LIMIT_WINDOW_MS=60000
```

Gives each of 10 concurrent users roughly 50 general requests and 3 runs per
minute before hitting the IP-level limit. Adjust upward if developers need
more CI throughput.

### Public or demo deployment

```dotenv
RATE_LIMIT_MAX=60
RUN_RATE_LIMIT_MAX=5
RATE_LIMIT_WINDOW_MS=60000
```

Conservative defaults. Five run starts per minute per IP prevents abuse of the
Testnet Friendbot while still allowing a demo user to explore the product. For
unauthenticated public access, consider a lower `RUN_RATE_LIMIT_MAX` of 2–3.

## Troubleshooting 429 errors

See the [Troubleshooting guide](./TROUBLESHOOTING.md#rate-limiting--429-too-many-requests)
for step-by-step resolution.
