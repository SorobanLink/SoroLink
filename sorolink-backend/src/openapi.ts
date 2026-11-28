import { scenarioSchemaV1, semverVersion } from "./scenario-schema.js";
import { runReportSchemaV1 } from "./report-schema.js";

const runRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId"],
  properties: {
    scenarioId: { type: "string" },
    /**
     * Optional exact semantic version selector (issues #71, #42), e.g. "1.0.0".
     *
     * - Published mode: resolves the exact requested version from the active
     *   catalogue source. Returns 404 if that version does not exist.
     * - Disabled (bundled) mode: the bundled registry holds exactly one
     *   version per scenario. If scenarioVersion is supplied and does not
     *   match the bundled version number the request is rejected with 409
     *   SCENARIO_VERSION_MISMATCH so the caller can detect the discrepancy
     *   explicitly rather than silently executing a different definition.
     * - Omitting scenarioVersion always executes the latest definition from
     *   the active catalogue source.
     */
    scenarioVersion: semverVersion,
    inputs: { type: "object", additionalProperties: false },
  },
} as const;

export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: { title: "SoroLink API", version: "1.0.0", description: "Bounded declarative Stellar Testnet scenario execution." },
    servers: [{ url: "/" }],
    paths: {
      "/health": { get: { operationId: "getHealth", responses: { "200": { description: "Healthy", content: { "application/json": { schema: { type: "object", required: ["status", "network"], properties: { status: { const: "ok" }, network: { const: "testnet" } } } } } } } } },
      "/metrics": { get: { operationId: "getMetrics", description: "Optional Prometheus text-format process metrics, available only when METRICS_ENABLED=true.", responses: { "200": { description: "Prometheus metrics", content: { "text/plain": { schema: { type: "string" } } } }, "404": { description: "Metrics are disabled" } } } },
      "/ready": { get: { operationId: "getReadiness", description: "Readiness probe. Performs GET /fee_stats against Horizon and, in persistence mode, SELECT 1 against the database. Use /health for liveness.", responses: { "200": { description: "Ready", content: { "application/json": { schema: { type: "object", required: ["status", "network", "database", "services"], properties: { status: { const: "ready" }, network: { const: "testnet" }, database: { enum: ["disabled", "ready"] }, services: { type: "object", required: ["horizon", "database"], properties: { horizon: { enum: ["ready", "unavailable"] }, database: { enum: ["disabled", "ready", "unavailable"] } } } } } } } }, "503": { description: "Horizon or database unavailable", content: { "application/json": { schema: { type: "object", required: ["status", "network", "database", "services"], properties: { status: { const: "unavailable" }, network: { const: "testnet" }, database: { enum: ["disabled", "ready", "unavailable"] }, services: { type: "object", required: ["horizon", "database"], properties: { horizon: { enum: ["ready", "unavailable"] }, database: { enum: ["disabled", "ready", "unavailable"] } } } } } } } } } } },
      "/api/v1/scenarios": {
        get: {
          operationId: "listScenarios",
          description: "Returns the current scenario catalogue. Supports conditional GET: provide the ETag from a previous response in If-None-Match to receive 304 when the catalogue has not changed.",
          responses: {
            "200": {
              description: "Scenario catalogue",
              content: { "application/json": { schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/ScenarioSummary" } } } } } },
              headers: {
                "ETag": { schema: { type: "string" }, description: "Deterministic fingerprint of the catalogue contents. Changes whenever a version number or content hash changes." },
                "Cache-Control": { schema: { type: "string" }, description: "Cache revalidation directive." },
              },
            },
            "304": { description: "Catalogue unchanged — client's cached copy is still current." },
          },
        },
      },
      "/api/v1/scenarios/{scenarioId}": { get: { operationId: "getScenario", parameters: [{ name: "scenarioId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Scenario definition", content: { "application/json": { schema: { $ref: "#/components/schemas/ScenarioV1" } } } }, "404": { description: "Not found", ...apiErrorContent } } } },
      "/api/v1/schemas/scenario-v1.json": {
        get: {
          operationId: "getScenarioSchemaV1",
          summary: "Canonical scenario JSON Schema (v1)",
          description: [
            "Returns the machine-readable JSON Schema for scenario definitions at schema version 1.",
            "The schema is served directly from the authoritative TypeScript source — there is no secondary copy.",
            "Note: JSON Schema alone cannot express all semantic constraints. The following additional rules",
            "are enforced by the server at validation time but are not representable in JSON Schema:",
            "- Exactly one native asset must be present in `assets`.",
            "- All `id` references in `steps` and `assertions` must resolve to a declared account, asset, or step.",
            "- No duplicate `id` values are allowed within each of `accounts`, `assets`, or `steps`.",
            "- `changeTrust` may not target a native asset.",
            "- `trustlineExists`/`trustlineMissing` assertions may not target a native asset.",
            "- Amount values (decimal strings) must not exceed Stellar's signed 64-bit stroops limit.",
            "- Payment memo and transactionMemoEquals memo must contain valid Unicode and at most 28 UTF-8 bytes, not characters. Empty text is permitted; an omitted memo means no memo.",
            "- transactionMemoEquals must reference a payment step and compares the successful Horizon transaction's text memo, not the input definition.",
            "- Secret seeds and URLs are forbidden in all string fields.",
            "- The total serialized definition must not exceed 16 384 bytes.",
          ].join(" "),
          responses: {
            "200": {
              description: "Canonical v1 scenario schema",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/v1/scenarios/validate": { post: { operationId: "validateScenario", requestBody: definitionBody(), responses: { "200": { description: "Validated scenario and content hash", content: { "application/json": { schema: { type: "object", required: ["valid", "scenarioId", "scenarioVersion", "schemaVersion", "contentHash"], properties: { valid: { const: true }, scenarioId: { type: "string" }, scenarioVersion: semverVersion, schemaVersion: { const: 1 }, contentHash: { type: "string" } } } } } }, "400": { description: "Invalid scenario", ...apiErrorContent }, "415": { description: "UNSUPPORTED_MEDIA_TYPE — Content-Type is not application/json, application/yaml, application/x-yaml, or text/yaml (issue #77)", ...apiErrorContent } } } },
      "/api/v1/scenarios/{scenarioId}/versions": { get: { operationId: "listScenarioVersions", description: "Rejects unknown query parameters, duplicate query keys, and non-integer-text limit/cursor values (decimals, scientific notation, empty strings) with 400 INVALID_REQUEST (issue #78).", parameters: [scenarioIdParameter, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } }, { name: "cursor", in: "query", schema: { type: "integer", minimum: 1 } }], responses: { "200": { description: "Bounded immutable version history", content: { "application/json": { schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/ScenarioSummary" } }, nextCursor: { type: "integer" } } } } } }, "400": { description: "INVALID_REQUEST — malformed scenarioId, limit, or cursor, or unknown query parameter", ...apiErrorContent }, "503": { description: "Persistence not enabled or unavailable", ...apiErrorContent } } } },
      "/api/v1/scenarios/{scenarioId}/versions/{version}": { get: { operationId: "getScenarioVersion", description: "Rejects a non-integer-text version path segment with 400 INVALID_REQUEST (issue #78).", parameters: [scenarioIdParameter, versionParameter], responses: { "200": { description: "Exact immutable scenario version", content: { "application/json": { schema: { $ref: "#/components/schemas/ScenarioV1" } } } }, "400": { description: "INVALID_REQUEST — malformed scenarioId or version", ...apiErrorContent }, "404": { description: "Not found", ...apiErrorContent } } } },
      "/api/v1/scenarios/{scenarioId}/versions/{version}/export": { get: { operationId: "exportScenarioVersion", description: "Rejects unknown query parameters, a non-integer-text version, or an unrecognised format with 400 INVALID_REQUEST (issue #78).", parameters: [scenarioIdParameter, versionParameter, { name: "format", in: "query", schema: { type: "string", enum: ["json", "yaml"], default: "json" } }], responses: { "200": { description: "Canonical version export", content: { "application/json": { schema: { $ref: "#/components/schemas/ScenarioV1" } }, "application/yaml": { schema: { type: "string" } } } }, "400": { description: "INVALID_REQUEST — malformed scenarioId, version, or format, or unknown query parameter", ...apiErrorContent }, "404": { description: "Not found", ...apiErrorContent } } } },
      "/api/v1/runs": {
        post: {
          operationId: "startCataloguedRun",
          summary: "Start a run from the catalogue",
          description: [
            "Starts a run using a published or bundled scenario. Run reports are retained for the configured TTL and terminal reports may be evicted early when the bounded store reaches capacity.",
            "Run creation uses a fixed-window per-client-IP limit configured by RUN_RATE_LIMIT_MAX and RATE_LIMIT_WINDOW_MS; requests over quota receive 429 RATE_LIMITED.",
            "Supports idempotency via the",
            "Idempotency-Key header (issue #72): sending the same key with the same canonical",
            "request body within the retention window returns the original run without re-executing.",
            "Sending the same key with a different body returns 409 IDEMPOTENCY_CONFLICT.",
            "When the idempotency store is full the request is rejected with 503 IDEMPOTENCY_CAPACITY.",
          ].join(" "),
          parameters: [idempotencyKeyHeader],
          requestBody: { required: true, content: { "application/json": { schema: runRequestSchema } } },
          responses: {
            "202": { description: "Run accepted", content: { "application/json": { schema: { $ref: "#/components/schemas/RunReport" } } }, headers: rateLimitHeaders },
            "400": { description: "Invalid request", ...apiErrorContent },
            "404": { description: "Scenario not found", ...apiErrorContent },
            "409": { description: "SCENARIO_VERSION_MISMATCH — bundled version differs from requested, or IDEMPOTENCY_CONFLICT — same key, different body", ...apiErrorContent },
            "429": { description: "RATE_LIMITED — per-IP run creation quota exceeded", ...apiErrorContent, headers: rateLimitedHeaders },
            "503": { description: "IDEMPOTENCY_CAPACITY or RUNNER_AT_CAPACITY", ...apiErrorContent },
          },
        },
        get: {
          operationId: "listRuns",
          summary: "List retained runs",
          description: "Issue #41: offset-paginated list of retained runs, newest first. `nextOffset` is present only when more runs exist. Out-of-range or non-integer `limit`/`offset` values, and unknown query parameters, return 400 INVALID_REQUEST.",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
          ],
          responses: {
            "200": {
              description: "Page of run reports",
              content: { "application/json": { schema: { type: "object", required: ["items", "limit", "offset"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/RunReport" } }, limit: { type: "integer" }, offset: { type: "integer" }, nextOffset: { type: "integer" } } } } },
            },
            "400": { description: "INVALID_REQUEST — limit outside 1–100, negative or non-integer offset, or unknown query parameter", ...apiErrorContent },
          },
        },
      },
      "/api/v1/runs/definitions": {
        post: {
          operationId: "startDefinitionRun",
          description: [
            "Starts a run from an inline scenario definition. Supports idempotency via the",
            "Idempotency-Key header (issue #72): same semantics as POST /api/v1/runs.",
          ].join(" "),
          parameters: [idempotencyKeyHeader],
          requestBody: definitionBody(),
          responses: {
            "202": { description: "Declarative run accepted", content: { "application/json": { schema: { $ref: "#/components/schemas/RunReport" } } }, headers: rateLimitHeaders },
            "400": { description: "Invalid scenario", ...apiErrorContent },
            "409": { description: "IDEMPOTENCY_CONFLICT — same key, different body", ...apiErrorContent },
            "415": { description: "UNSUPPORTED_MEDIA_TYPE — Content-Type is not application/json, application/yaml, application/x-yaml, or text/yaml (issue #77)", ...apiErrorContent },
            "429": { description: "RATE_LIMITED — per-IP run creation quota exceeded", ...apiErrorContent, headers: rateLimitedHeaders },
            "503": { description: "IDEMPOTENCY_CAPACITY or RUNNER_AT_CAPACITY", ...apiErrorContent },
          },
        },
      },
      "/api/v1/runs/{runId}": {
        get: {
          operationId: "getRun",
          description: [
            "Returns the current run report. Terminal reports (status passed/failed) include an `expiresAt`",
            "hint (issue #76): the configured retention window measured from when the run became terminal.",
            "Active reports never include `expiresAt` — a running run has no terminal expiry to claim.",
            "`expiresAt` is a best-effort upper bound, not a guarantee: the in-memory run store may evict a",
            "terminal run earlier under capacity pressure, and no run state survives a process restart.",
            "Supports conditional GET with `If-None-Match`; a matching report returns 304 without a body.",
            "Responses include an ETag for the complete representation and `Cache-Control: no-cache`,",
            "so active reports are revalidated rather than treated as immutable.",
          ].join(" "),
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": {
              description: "Run report",
              content: { "application/json": { schema: { $ref: "#/components/schemas/RunReport" } } },
              headers: {
                "ETag": { schema: { type: "string" }, description: "Fingerprint of the complete run representation; changes when any report field changes." },
                "Cache-Control": { schema: { type: "string" }, description: "no-cache requires revalidation before reuse, including for active reports." },
              },
            },
            "304": { description: "Run report unchanged; no response body." },
            "404": { description: "Not found", ...apiErrorContent },
          },
        },
        delete: {
          operationId: "cancelRun",
          summary: "Cancel an active run",
          description: [
            "Transitions an active run (requested, validating, or running) to the cancelled terminal state.",
            "Returns 409 RUN_ALREADY_TERMINAL when the run is already in a terminal state (passed, failed, or cancelled).",
            "Returns 404 when the run does not exist.",
            "Cancellation signals the runner to stop after the current step completes; mid-step interruption is out of scope.",
          ].join(" "),
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": { description: "Run successfully cancelled; returns the final run report with status=cancelled." },
            "404": { description: "RUN_NOT_FOUND — run does not exist" },
            "409": { description: "RUN_ALREADY_TERMINAL — run is already in a terminal state" },
          },
        },
      },
      "/api/v1/runs/{runId}/report": {
        get: {
          operationId: "downloadRunReport",
          description: "Final JSON report for a terminal run, including the same best-effort `expiresAt` retention hint and ETag revalidation behavior as GET /api/v1/runs/{runId}.",
          parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: {
            "200": {
              description: "Final JSON report",
              content: { "application/json": { schema: { $ref: "#/components/schemas/RunReport" } } },
              headers: {
                "ETag": { schema: { type: "string" }, description: "Fingerprint of the complete report representation." },
                "Cache-Control": { schema: { type: "string" }, description: "no-cache requires revalidation before reuse." },
              },
            },
            "304": { description: "Report unchanged; no response body." },
            "409": { description: "Run incomplete", ...apiErrorContent },
            "404": { description: "Not found", ...apiErrorContent },
          },
        },
      },
    },
    components: {
      schemas: {
        ScenarioV1: scenarioSchemaV1,
        ScenarioSummary: {
          type: "object",
          required: ["id", "version", "name", "description", "contentHash"],
          properties: {
            id: { type: "string" },
            version: semverVersion,
            name: { type: "string" },
            description: { type: "string" },
            contentHash: { type: "string" },
          },
        },
        CataloguedRunRequest: runRequestSchema,
        RunReport: runReportSchemaV1,
        StellarErrorCode: {
          type: "string",
          description: "Stable SoroLink error code. Raw Stellar protocol result codes remain available in stellarTransactionCode and stellarOperationCodes.",
          enum: [
            "STELLAR_OPERATION_FAILED", "STELLAR_UNAUTHORIZED", "STELLAR_SOURCE_ACCOUNT_NOT_FOUND",
            "STELLAR_OPERATION_NOT_SUPPORTED", "STELLAR_TOO_MANY_SUBENTRIES", "STELLAR_WORK_LIMIT_EXCEEDED",
            "STELLAR_TRUSTLINE_NOT_FOUND", "STELLAR_INSUFFICIENT_BALANCE", "STELLAR_TRUSTLINE_LIMIT_EXCEEDED",
            "STELLAR_ISSUER_NOT_FOUND", "STELLAR_INSUFFICIENT_RESERVE", "STELLAR_ASSET_NOT_AUTHORIZED",
            "STELLAR_MALFORMED_OPERATION", "STELLAR_DESTINATION_NOT_FOUND", "STELLAR_SOURCE_NOT_AUTHORIZED",
            "STELLAR_SOURCE_TRUSTLINE_NOT_FOUND", "STELLAR_TRANSACTION_FAILED", "STELLAR_TRANSACTION_TOO_EARLY",
            "STELLAR_TRANSACTION_TOO_LATE", "STELLAR_TRANSACTION_MISSING_OPERATION", "STELLAR_BAD_SEQUENCE",
            "STELLAR_BAD_AUTHORIZATION", "STELLAR_INSUFFICIENT_FEE_BALANCE", "STELLAR_INSUFFICIENT_FEE",
            "STELLAR_NETWORK_INTERNAL_ERROR", "STELLAR_TRANSACTION_NOT_SUPPORTED",
          ],
        },
        ApiErrorEnvelope: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message", "requestId", "details"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                requestId: { type: "string" },
                details: { type: "array", items: { type: "string" }, maxItems: 50 },
              },
            },
          },
        },
      },
    },
  } as const;
}

const apiErrorContent = {
  content: { "application/json": { schema: { $ref: "#/components/schemas/ApiErrorEnvelope" } } },
} as const;

const rateLimitHeaders = {
  "X-RateLimit-Limit": { schema: { type: "integer" }, description: "Maximum requests allowed in the configured fixed window." },
  "X-RateLimit-Remaining": { schema: { type: "integer" }, description: "Requests remaining in the current window." },
} as const;

const rateLimitedHeaders = {
  ...rateLimitHeaders,
  "Retry-After": { schema: { type: "integer" }, description: "Seconds until a rejected request can be retried." },
} as const;

const scenarioIdParameter = { name: "scenarioId", in: "path", required: true, schema: { type: "string", pattern: "^[a-z0-9-]+$" } } as const;
const versionParameter = { name: "version", in: "path", required: true, schema: { type: "integer", minimum: 1 } } as const;
const idempotencyKeyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: 128 },
  description: "Optional client-generated key. Identical key + body within the retention window returns the original run. Identical key + different body returns 409.",
} as const;

/**
 * Mutation endpoints (issue #77) accept exactly: `application/json`,
 * `application/yaml`, `application/x-yaml`, and `text/yaml`. A charset
 * parameter (e.g. `application/yaml; charset=utf-8`) is accepted on the
 * YAML media types. Any other Content-Type is rejected with 415
 * UNSUPPORTED_MEDIA_TYPE — a stable, documented error code, not a generic
 * internal error.
 */
function definitionBody() {
  return {
    required: true,
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/ScenarioV1" } },
      "application/yaml": { schema: { type: "string" } },
      "application/x-yaml": { schema: { type: "string" } },
      "text/yaml": { schema: { type: "string" } },
    },
  } as const;
}
