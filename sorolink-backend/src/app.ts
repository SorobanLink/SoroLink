import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import type { LedgerGateway, RunReport, ValidatedScenario } from "./domain.js";
import { RunCapacityError, RunAlreadyTerminalError, RunNotFoundError } from "./errors.js";
import { DatabaseUnavailableError } from "./database.js";
import { openApiDocument } from "./openapi.js";
import { FixedWindowRateLimiter } from "./rate-limiter.js";
import { RunService, type RunLifecycleLogger } from "./run-service.js";
import { InMemoryRunStore, type RunExportRow } from "./run-store.js";
import { parseScenario, prepareScenario, parseScenarioSchemaOnly, prepareScenarioSchemaOnly, canonicalJson } from "./scenario-loader.js";
import { scenarioSchemaV1, ScenarioValidationError, semverVersion } from "./scenario-schema.js";
import { createScenarioRegistry } from "./scenarios.js";
import { StellarTestnetGateway } from "./stellar-gateway.js";
import { PersistenceCoordinator } from "./persistence.js";
import { ScenarioIntegrityError } from "./published-scenarios.js";
import { IdempotencyStore } from "./idempotency-store.js";
import { CircuitBreaker } from "./circuit-breaker.js";

export type AppInstance = FastifyInstance & { runs: RunService; horizonCircuit: CircuitBreaker };

export interface DrainableApp {
  close: () => Promise<void>;
  runs: Pick<RunService, "drain"> & Partial<Pick<RunService, "cancelActive">>;
}

export interface DrainResult {
  /** True when every active run finished before the drain deadline. */
  drained: boolean;
  /** Runs force-cancelled with SERVER_SHUTDOWN after the deadline expired. */
  cancelledRuns: number;
}

/**
 * Graceful shutdown:
 *   1. RunService enters draining mode; the onRequest gate now rejects every
 *      new request (except /health) with 503 SERVER_SHUTTING_DOWN.
 *   2. Active runs may complete, bounded by `timeoutMs`.
 *   3. Runs still active at the deadline are marked cancelled (SERVER_SHUTDOWN).
 *   4. Fastify closes: the listener stops, in-flight requests finish, idle
 *      keep-alive sockets close, and onClose hooks release the database pool.
 */
export async function closeAfterDrain(app: DrainableApp, timeoutMs: number): Promise<DrainResult> {
  const draining = app.runs.drain().then(() => true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  let drained: boolean;
  try {
    drained = await Promise.race([draining, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const cancelledRuns = !drained && app.runs.cancelActive ? await app.runs.cancelActive() : 0;
  await app.close();
  return { drained, cancelledRuns };
}

export type ReadinessCheck = (signal: AbortSignal) => Promise<unknown>;
type ServiceStatus = "ready" | "unavailable" | "disabled";

interface BuildAppOptions {
  config: AppConfig;
  ledger?: LedgerGateway;
  logger?: boolean;
  runLogger?: RunLifecycleLogger;
  clock?: () => number;
  /** Shared Horizon circuit breaker; one is created from config when omitted. */
  horizonCircuit?: CircuitBreaker;
  /** Overrides for /ready dependency probes (used by tests to avoid real I/O). */
  readinessChecks?: { horizon?: ReadinessCheck; database?: ReadinessCheck };
}

const runBodySchema = {
  type: "object", additionalProperties: false, required: ["scenarioId"],
  properties: {
    scenarioId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" },
    scenarioVersion: semverVersion,
    inputs: { type: "object", additionalProperties: false, default: {} },
  },
} as const;

const scenarioIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId"],
  properties: { scenarioId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" } },
} as const;

const versionParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId", "version"],
  properties: {
    scenarioId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" },
    version: { type: "string", minLength: 1, maxLength: 10, pattern: "^[1-9][0-9]*$" },
  },
} as const;

const historyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "string", minLength: 1, maxLength: 3, pattern: "^[0-9]+$" },
    cursor: { type: "string", minLength: 1, maxLength: 10, pattern: "^[0-9]+$" },
  },
} as const;

/** Issue #41: runs listing pagination bounds. */
const RUNS_PAGE_DEFAULT_LIMIT = 20;
const RUNS_PAGE_MAX_LIMIT = 100;
const RUNS_PAGE_MAX_OFFSET = 2_147_483_647;

const runsListQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "string", minLength: 1, maxLength: 10 },
    offset: { type: "string", minLength: 1, maxLength: 10 },
  },
} as const;

const exportQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { format: { type: "string", enum: ["json", "yaml"] } },
} as const;

const runExportQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { format: { type: "string", enum: ["json", "csv"], default: "json" } },
} as const;

const validateQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { dryRun: { type: "string", enum: ["true", "false"] } },
} as const;

/** Maximum Idempotency-Key length accepted (issue #72). */
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Maximum number of in-flight idempotency entries (issue #72). */
const IDEMPOTENCY_MAX_ENTRIES = 1_000;

/**
 * Retention window for idempotency entries: 24 h (issue #72).
 * Entries older than this are pruned lazily on the next lookup.
 */
const IDEMPOTENCY_RETENTION_MS = 86_400_000;

export function buildApp(options: BuildAppOptions): AppInstance {
  const clock = options.clock ?? Date.now;
  const app = Fastify({
    // Issue #43: structured JSON logs (level, msg, timestamp, requestId) at LOG_LEVEL.
    logger: options.logger ? structuredLoggerOptions(options.config.logLevel) : false,
    // Issue #43: one correlation ID per request; a well-formed X-Request-ID header is honoured.
    requestIdHeader: false,
    requestIdLogLabel: "requestId",
    genReqId: (request) => incomingRequestId(request.headers["x-request-id"]) ?? randomUUID(),
    bodyLimit: options.config.bodyLimitBytes,
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });
  app.addContentTypeParser(["application/yaml", "application/x-yaml", "text/yaml"], { parseAs: "string" }, (_request, body, done) => done(null, body));
  // Issue #77: fastify's default text/plain parser would otherwise accept
  // (and then fail validation on) bodies with unsupported content types such
  // as text/plain, masking the real problem behind a 400. Removing it lets
  // every content type we don't explicitly support fall through to fastify's
  // own FST_ERR_CTP_INVALID_MEDIA_TYPE path, which the error handler below
  // maps to a stable 415 UNSUPPORTED_MEDIA_TYPE.
  app.removeContentTypeParser("text/plain");
  const registry = createScenarioRegistry(options.config.scenarioDirectory);
  const persistence = new PersistenceCoordinator(options.config, registry);
  app.addHook("onReady", async () => persistence.initialize());
  app.addHook("onClose", async () => persistence.close());
  const limiter = new FixedWindowRateLimiter(options.config.rateLimitWindowMs);

  // Idempotency store shared across both run-creation endpoints (issue #72).
  // RunService.start returns Promise<RunReport>, so T = RunReport.
  const idempotency = new IdempotencyStore<RunReport>(
    IDEMPOTENCY_MAX_ENTRIES,
    IDEMPOTENCY_RETENTION_MS,
  );

  // Graceful shutdown gate: once draining starts, refuse new work. /health
  // stays answerable so orchestrators see the process as alive while it drains.
  app.addHook("onRequest", async (request, reply) => {
    if (!runs.draining || request.url.split("?")[0] === "/health") return;
    reply.header("connection", "close");
    return reply.code(503).send(apiError("SERVER_SHUTTING_DOWN", "The server is shutting down and is not accepting new requests.", request.id));
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    // Issue #85: /health is a cheap liveness probe that must stay reachable
    // even when a client address has exhausted its application quota. Skip
    // rate-limiting for this route entirely; all other routes, including the
    // explicit readiness probe at /ready, continue to be covered.
    if (path === "/health") return;
    const isRunCreation = request.method === "POST" && (path === "/api/v1/runs" || path === "/api/v1/runs/definitions");
    const limit = isRunCreation ? options.config.runRateLimitMax : options.config.rateLimitMax;
    const result = limiter.consume(`${isRunCreation ? "run" : "global"}:${request.ip}`, limit);
    reply.header("x-ratelimit-limit", limit).header("x-ratelimit-remaining", result.remaining);
    if (!result.allowed) { reply.header("retry-after", result.retryAfterSeconds); return reply.code(429).send(apiError("RATE_LIMITED", "Request limit exceeded. Try again later.", request.id)); }
  });
  const horizonCircuit = options.horizonCircuit ?? new CircuitBreaker("Horizon", {
    ...(options.config.horizonCircuitCooldownMs !== undefined && { cooldownMs: options.config.horizonCircuitCooldownMs }),
    now: clock,
  });
  const ledger = options.ledger ?? new StellarTestnetGateway(options.config.horizonUrl, options.config.friendbotUrl, {
    fundingConcurrency: options.config.maxConcurrentFriendbotRequests,
    horizonCircuitBreaker: horizonCircuit,
  });
  const runs = new RunService(persistence.runStore ?? new InMemoryRunStore(options.config.maxStoredRuns, options.config.runRetentionMs, clock), ledger, {
    maxConcurrentRuns: options.config.maxConcurrentRuns, runTimeoutMs: options.config.runTimeoutMs, stepTimeoutMs: options.config.stepTimeoutMs,
  }, clock, options.runLogger ?? {
    // Issue #43: lifecycle events carry runId, scenarioId, and the originating requestId.
    info: (fields) => app.log.info(fields, fields.event),
  });

  app.get("/health", async () => ({ status: "ok", network: "testnet" }));
  if (options.config.metricsEnabled) {
    app.get("/metrics", async (_request, reply) => {
      const metrics = runs.getMetrics();
      const body = [
        "# HELP sorolink_active_runs Number of currently admitted active runs.",
        "# TYPE sorolink_active_runs gauge",
        `sorolink_active_runs ${metrics.activeRuns}`,
        "# HELP sorolink_terminal_runs_total Completed runs by fixed outcome.",
        "# TYPE sorolink_terminal_runs_total counter",
        `sorolink_terminal_runs_total{outcome="passed"} ${metrics.terminalRuns.passed}`,
        `sorolink_terminal_runs_total{outcome="failed"} ${metrics.terminalRuns.failed}`,
        `sorolink_terminal_runs_total{outcome="cancelled"} ${metrics.terminalRuns.cancelled}`,
        "# HELP sorolink_rejected_run_starts_total Rejected starts by fixed reason.",
        "# TYPE sorolink_rejected_run_starts_total counter",
        `sorolink_rejected_run_starts_total{reason="capacity"} ${metrics.rejectedStarts.capacity}`,
        `sorolink_rejected_run_starts_total{reason="draining"} ${metrics.rejectedStarts.draining}`,
        "# HELP sorolink_run_duration_seconds Duration of terminal runs in seconds.",
        "# TYPE sorolink_run_duration_seconds summary",
        `sorolink_run_duration_seconds_sum ${metrics.runDuration.totalMilliseconds / 1_000}`,
        "# HELP sorolink_run_duration_seconds_count Number of terminal runs included in duration.",
        "# TYPE sorolink_run_duration_seconds_count counter",
        `sorolink_run_duration_seconds_count ${metrics.runDuration.count}`,
        ...circuitMetrics(horizonCircuit),
        "",
      ].join("\n");
      return reply
        .header("Cache-Control", "no-store")
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(body);
    });
  }
  // Readiness: verify each dependency, unlike /health (pure liveness).
  const readinessTimeoutMs = options.config.readinessTimeoutMs ?? 3_000;
  const horizonCheck: ReadinessCheck = options.readinessChecks?.horizon ?? (async (signal) => {
    const response = await fetch(new URL("/fee_stats", options.config.horizonUrl), { signal });
    if (!response.ok) throw new Error(`Horizon readiness probe returned ${response.status}`);
  });
  const databaseCheck: ReadinessCheck | undefined = options.readinessChecks?.database ?? (persistence.database
    ? async () => { if (!(await persistence.check())) throw new Error("Database readiness probe failed"); }
    : undefined);
  app.get("/ready", async (_request, reply) => {
    const [horizon, database] = await Promise.all([
      probe(horizonCheck, readinessTimeoutMs),
      databaseCheck ? probe(databaseCheck, readinessTimeoutMs) : Promise.resolve<ServiceStatus>("disabled"),
    ]);
    const ready = horizon === "ready" && database !== "unavailable";
    const body = { status: ready ? "ready" : "unavailable", network: "testnet", database, services: { horizon, database } };
    return ready ? body : reply.code(503).send(body);
  });
  app.get("/openapi.json", async () => openApiDocument());

  // ── Issue #70: canonical schema endpoint ──────────────────────────────────
  app.get("/api/v1/schemas/scenario-v1.json", async (_request, reply) => {
    return reply.type("application/json").send(scenarioSchemaV1);
  });

  // ── Issue #69: conditional GET for scenario catalogue ─────────────────────
  app.get("/api/v1/scenarios", async (request, reply) => {
    const items = persistence.repository ? await persistence.repository.list() : registry.list();
    const etag = catalogueETag(items);
    // Always include explicit revalidation directives so both browsers and
    // reverse proxies know the resource must be revalidated before reuse.
    reply.header("ETag", etag).header("Cache-Control", "no-cache");
    const ifNoneMatch = (request.headers["if-none-match"] as string | undefined)?.trim();
    if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === `W/${etag}`)) {
      return reply.code(304).send();
    }
    return { items };
  });

  app.get<{ Params: { scenarioId: string } }>("/api/v1/scenarios/:scenarioId", async (request, reply) => {
    const scenario = persistence.repository ? await persistence.repository.latest(request.params.scenarioId) : registry.find(request.params.scenarioId);
    if (!scenario) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
    return scenario;
  });
  app.get<{ Params: { scenarioId: string }; Querystring: { limit?: string; cursor?: string } }>("/api/v1/scenarios/:scenarioId/versions", { schema: { params: scenarioIdParamsSchema, querystring: historyQuerySchema } }, async (request, reply) => {
    const limit = request.query.limit === undefined ? 20 : parseBoundedInt(request.query.limit, 1, 100);
    if (limit === undefined) return reply.code(400).send(apiError("INVALID_REQUEST", "limit must be an integer between 1 and 100.", request.id));
    let cursor: number | undefined;
    if (request.query.cursor !== undefined) {
      cursor = parseBoundedInt(request.query.cursor, 1, 2_147_483_647);
      if (cursor === undefined) return reply.code(400).send(apiError("INVALID_REQUEST", "cursor must be an integer between 1 and 2147483647.", request.id));
    }
    if (!persistence.repository) return reply.code(503).send(apiError("PERSISTENCE_REQUIRED", "Scenario version history requires published persistence mode.", request.id));
    const history = await persistence.repository.history(request.params.scenarioId, limit, cursor);
    if (!history.items.length && cursor === undefined) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
    return history;
  });
  app.get<{ Params: { scenarioId: string; version: string } }>("/api/v1/scenarios/:scenarioId/versions/:version", { schema: { params: versionParamsSchema } }, async (request, reply) => {
    const version = parseBoundedInt(request.params.version, 1, 2_147_483_647);
    if (version === undefined) return reply.code(400).send(apiError("INVALID_REQUEST", "version must be an integer between 1 and 2147483647.", request.id));
    if (!persistence.repository) return reply.code(503).send(apiError("PERSISTENCE_REQUIRED", "Exact scenario versions require published persistence mode.", request.id));
    const scenario = await persistence.repository.version(request.params.scenarioId, version);
    if (!scenario) return reply.code(404).send(apiError("SCENARIO_VERSION_NOT_FOUND", "The requested scenario version is not available.", request.id));
    return scenario;
  });
  app.get<{ Params: { scenarioId: string; version: string }; Querystring: { format?: "json" | "yaml" } }>("/api/v1/scenarios/:scenarioId/versions/:version/export", { schema: { params: versionParamsSchema, querystring: exportQuerySchema } }, async (request, reply) => {
    const version = parseBoundedInt(request.params.version, 1, 2_147_483_647);
    if (version === undefined) return reply.code(400).send(apiError("INVALID_REQUEST", "version must be an integer between 1 and 2147483647.", request.id));
    if (!persistence.repository) return reply.code(503).send(apiError("PERSISTENCE_REQUIRED", "Scenario export requires published persistence mode.", request.id));
    const format = request.query.format ?? "json";
    const exported = await persistence.repository.export(request.params.scenarioId, version, format);
    if (!exported) return reply.code(404).send(apiError("SCENARIO_VERSION_NOT_FOUND", "The requested scenario version is not available.", request.id));
    return reply.type(format === "json" ? "application/json" : "application/yaml").header("content-disposition", `attachment; filename=${request.params.scenarioId}-v${version}.${format}`).send(exported);
  });
  app.post<{ Querystring: { dryRun?: "true" | "false" } }>("/api/v1/scenarios/validate", { schema: { querystring: validateQuerySchema } }, async (request) => {
    const dryRun = request.query.dryRun === "true";
    const scenario = dryRun
      ? submittedScenario(request.body, request.headers["content-type"])
      : submittedScenarioSchemaOnly(request.body, request.headers["content-type"]);
    return {
      valid: true,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      schemaVersion: scenario.schemaVersion,
      contentHash: scenario.contentHash,
      ...(dryRun ? { dryRun: true } : {}),
    };
  });

  // ── Issue #71: exact version run creation + Issue #72: idempotency ────────
  app.post<{ Body: { scenarioId: string; scenarioVersion?: string; inputs?: Record<string, never> } }>("/api/v1/runs", { schema: { body: runBodySchema } }, async (request, reply) => {
    const { scenarioId, scenarioVersion } = request.body;

    // Resolve the scenario from the active catalogue source (issue #71).
    let scenario: ValidatedScenario | undefined;
    if (persistence.repository) {
      // Published mode: resolve from the persistent catalogue.
      if (scenarioVersion !== undefined) {
        scenario = await persistence.repository.semanticVersion(scenarioId, scenarioVersion);
        if (!scenario) return reply.code(404).send(apiError("SCENARIO_VERSION_NOT_FOUND", `Scenario ${scenarioId} version ${scenarioVersion} is not available in the published catalogue.`, request.id));
      } else {
        scenario = await persistence.repository.latest(scenarioId);
        if (!scenario) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
      }
    } else {
      // Disabled (bundled) mode: bundled registry holds exactly one version.
      scenario = registry.find(scenarioId);
      if (!scenario) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
      if (scenarioVersion !== undefined && scenario.version !== scenarioVersion) {
        // The bundled definition's version does not match the caller's
        // expectation. Reject explicitly so the caller is not silently
        // executing a different definition than the one they saw.
        return reply.code(409).send(apiError(
          "SCENARIO_VERSION_MISMATCH",
          `Bundled scenario ${scenarioId} is at version ${scenario.version}, not version ${scenarioVersion}. Omit scenarioVersion to always execute the current bundled definition.`,
          request.id,
        ));
      }
    }

    // Idempotency (issue #72).
    const idempotencyKey = extractIdempotencyKey(request.headers["idempotency-key"]);
    if (idempotencyKey) {
      const fingerprint = requestFingerprint({ scenarioId, scenarioVersion });
      const outcome = idempotency.insert(idempotencyKey, fingerprint, () => runs.start(scenario, request.id));
      if (outcome.status === "conflict") {
        return reply.code(409).send(apiError("IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used with a different request body.", request.id));
      }
      if (outcome.status === "capacity") {
        return reply.code(503).send(apiError("IDEMPOTENCY_CAPACITY", "The idempotency store is at capacity. Retry without an Idempotency-Key or try again later.", request.id));
      }
      // Both "created" and "existing" return the settled result of the original
      // promise, which may be from a concurrent or prior request.
      return reply.code(202).send(await outcome.entry.result);
    }

    return reply.code(202).send(await runs.start(scenario, request.id));
  });

  app.post("/api/v1/runs/definitions", async (request, reply) => {
    const scenario = submittedScenario(request.body, request.headers["content-type"]);

    // Idempotency (issue #72).
    const idempotencyKey = extractIdempotencyKey(request.headers["idempotency-key"]);
    if (idempotencyKey) {
      // The canonical fingerprint covers the entire definition so any field
      // change produces a different fingerprint.
      const fingerprint = requestFingerprint(scenario);
      const outcome = idempotency.insert(idempotencyKey, fingerprint, () => runs.start(scenario, request.id));
      if (outcome.status === "conflict") {
        return reply.code(409).send(apiError("IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used with a different request body.", request.id));
      }
      if (outcome.status === "capacity") {
        return reply.code(503).send(apiError("IDEMPOTENCY_CAPACITY", "The idempotency store is at capacity. Retry without an Idempotency-Key or try again later.", request.id));
      }
      return reply.code(202).send(await outcome.entry.result);
    }

    return reply.code(202).send(await runs.start(scenario, request.id));
  });

  // ── Issue #41: paginated runs listing ─────────────────────────────────────
  app.get<{ Querystring: { limit?: string; offset?: string } }>("/api/v1/runs", { schema: { querystring: runsListQuerySchema } }, async (request, reply) => {
    const { limit: rawLimit, offset: rawOffset } = request.query;
    const limit = rawLimit === undefined ? RUNS_PAGE_DEFAULT_LIMIT : parseIntegerText(rawLimit, 1, RUNS_PAGE_MAX_LIMIT);
    if (limit === undefined) {
      return reply.code(400).send(apiError("INVALID_REQUEST", `limit must be an integer between 1 and ${RUNS_PAGE_MAX_LIMIT}.`, request.id, [`limit: received "${rawLimit}"`]));
    }
    const offset = rawOffset === undefined ? 0 : parseIntegerText(rawOffset, 0, RUNS_PAGE_MAX_OFFSET);
    if (offset === undefined) {
      return reply.code(400).send(apiError("INVALID_REQUEST", `offset must be an integer between 0 and ${RUNS_PAGE_MAX_OFFSET}.`, request.id, [`offset: received "${rawOffset}"`]));
    }
    const page = await runs.list(limit, offset);
    return {
      items: page.items.map((run) => withRetentionMetadata(run, options.config.runRetentionMs)),
      limit,
      offset,
      ...(page.hasMore && { nextOffset: offset + page.items.length }),
    };
  });

  // ── Issue #41: bulk run export (CSV/JSON) ───────────────────────────────────
  app.get<{ Querystring: { format?: "json" | "csv" } }>("/api/v1/runs/export", { schema: { querystring: runExportQuerySchema } }, async (request, reply) => {
    if (!persistence.runStore) {
      return reply.code(501).send(apiError(
        "PERSISTENCE_REQUIRED",
        "Bulk run export requires persistent run history.",
        request.id,
      ));
    }
    const format = request.query.format ?? "json";
    reply.header("content-disposition", `attachment; filename=sorolink-runs.${format}`);
    if (format === "csv") {
      reply.type("text/csv; charset=utf-8");
      const stream = Readable.from(csvRunExport(persistence.runStore.exportRows()));
      return reply.send(stream);
    }
    reply.type("application/json; charset=utf-8");
    const stream = Readable.from(jsonRunExport(persistence.runStore.exportRows()));
    return reply.send(stream);
  });

  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", async (request, reply) => {
    const run = await runs.get(request.params.runId);
    if (!run) return reply.code(404).send(apiError("RUN_NOT_FOUND", "The requested run does not exist.", request.id));
    return sendConditionalRunReport(request, reply, withRetentionMetadata(run, options.config.runRetentionMs));
  });
  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/report", async (request, reply) => {
    const run = await runs.get(request.params.runId);
    if (!run) return reply.code(404).send(apiError("RUN_NOT_FOUND", "The requested run does not exist.", request.id));
    if (run.status !== "passed" && run.status !== "failed" && run.status !== "cancelled") return reply.code(409).send(apiError("RUN_NOT_COMPLETE", "The requested run is not complete.", request.id));
    reply.header("content-disposition", `attachment; filename=sorolink-run-${run.id}.json`);
    return sendConditionalRunReport(request, reply, withRetentionMetadata(run, options.config.runRetentionMs));
  });

  // ── Issue #40: run cancellation endpoint ──────────────────────────────────
  app.delete<{ Params: { runId: string } }>("/api/v1/runs/:runId", async (request, reply) => {
    try {
      const cancelled = await runs.cancel(request.params.runId);
      return reply.code(200).send(withRetentionMetadata(cancelled, options.config.runRetentionMs));
    } catch (error) {
      if (error instanceof RunNotFoundError) return reply.code(404).send(apiError("RUN_NOT_FOUND", "The requested run does not exist.", request.id));
      if (error instanceof RunAlreadyTerminalError) return reply.code(409).send(apiError("RUN_ALREADY_TERMINAL", `Run is already in terminal state: ${error.status}.`, request.id));
      throw error;
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RunCapacityError) return reply.code(503).send({ error: { ...error.report, requestId: request.id, details: [] } });
    if (error instanceof DatabaseUnavailableError) return reply.code(503).send(apiError("DATABASE_UNAVAILABLE", "The persistent scenario catalogue is temporarily unavailable.", request.id));
    // Issue #81: a persisted scenario row failed its integrity re-check. Respond with a
    // sanitized availability error — never the underlying ScenarioIntegrityError detail.
    if (error instanceof ScenarioIntegrityError) return reply.code(503).send(apiError("CATALOGUE_INTEGRITY_ERROR", "The published scenario catalogue is temporarily unavailable.", request.id));
    if (error instanceof ScenarioValidationError) {
      const base = apiError("INVALID_SCENARIO", error.message, request.id, error.issues);
      if (isDryRunRequest(request.url)) {
        const errors = error.issues.map((message) => {
          const ajvPath = /^\/[^ ]+/.exec(message)?.[0];
          return { code: "INVALID_SCENARIO", ...(ajvPath ? { path: ajvPath } : {}), message };
        });
        return reply.code(400).send({ valid: false, errors, error: { ...base.error, errors } });
      }
      return reply.code(400).send(base);
    }
    if (isInvalidJsonBodyError(error)) {
      if (isScenarioDefinitionPath(request.url)) {
        const base = apiError("INVALID_SCENARIO", "Scenario definition is invalid.", request.id, ["definition is not valid JSON"]);
        if (isDryRunRequest(request.url)) {
          const errors = [{ code: "INVALID_SCENARIO", message: "definition is not valid JSON" }];
          return reply.code(400).send({ valid: false, errors, error: { ...base.error, errors } });
        }
        return reply.code(400).send(base);
      }
      return reply.code(400).send(apiError("INVALID_REQUEST", "The request body is invalid.", request.id, ["request body is not valid JSON"]));
    }
    if (hasStatus(error, 429)) return reply.code(429).send(apiError("RATE_LIMITED", "Request limit exceeded. Try again later.", request.id));
    if (hasStatus(error, 413)) return reply.code(413).send(apiError("INVALID_REQUEST", "The request body exceeded the allowed size.", request.id));
    if (isUnsupportedMediaTypeError(error)) return reply.code(415).send(apiError("UNSUPPORTED_MEDIA_TYPE", "The request content type is not supported.", request.id));
    if (isValidationError(error)) {
      const base = apiError("INVALID_REQUEST", "The request did not match the API schema.", request.id);
      if (isDryRunRequest(request.url)) {
        const errors = [{ code: "INVALID_REQUEST", message: "The request did not match the API schema." }];
        return reply.code(400).send({ valid: false, errors, error: { ...base.error, errors } });
      }
      return reply.code(400).send(base);
    }
    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send(apiError("INTERNAL_ERROR", "The request could not be completed.", request.id));
  });
  const instance = app as unknown as AppInstance;
  instance.runs = runs;
  instance.horizonCircuit = horizonCircuit;
  return instance;
}

async function probe(check: ReadinessCheck, timeoutMs: number): Promise<ServiceStatus> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Readiness probe timed out")); }, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([check(controller.signal), timeout]);
    return "ready";
  } catch {
    return "unavailable";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function circuitMetrics(breaker: CircuitBreaker): string[] {
  const snapshot = breaker.snapshot();
  return [
    "# HELP sorolink_horizon_circuit_state Horizon circuit breaker state (1 for the current state).",
    "# TYPE sorolink_horizon_circuit_state gauge",
    ...(["closed", "open", "half_open"] as const).map((state) => `sorolink_horizon_circuit_state{state="${state}"} ${snapshot.state === state ? 1 : 0}`),
    "# HELP sorolink_horizon_circuit_opens_total Times the Horizon circuit has opened.",
    "# TYPE sorolink_horizon_circuit_opens_total counter",
    `sorolink_horizon_circuit_opens_total ${snapshot.opens}`,
    "# HELP sorolink_horizon_circuit_rejected_calls_total Horizon calls fast-failed with CIRCUIT_OPEN.",
    "# TYPE sorolink_horizon_circuit_rejected_calls_total counter",
    `sorolink_horizon_circuit_rejected_calls_total ${snapshot.rejectedCalls}`,
  ];
}

// ── Issue #69: deterministic ETag for catalogue responses ─────────────────
/**
 * Produce a deterministic ETag for the given catalogue items.
 * The hash covers the sorted canonical JSON of every summary so that any
 * change to a version number or content hash produces a different ETag,
 * regardless of the order in which items are returned from the database.
 */
function catalogueETag(items: { id: string; version: string; contentHash: string }[]): string {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash("sha256")
    .update(canonicalJson(sorted.map(({ id, version, contentHash }) => ({ id, version, contentHash }))))
    .digest("hex");
  return `"${digest}"`;
}

function sendConditionalRunReport(
  request: FastifyRequest,
  reply: FastifyReply,
  report: RunReport,
) {
  const body = JSON.stringify(report);
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  reply.header("ETag", etag);
  reply.header("Cache-Control", "no-cache");

  const ifNoneMatchHeader = request.headers["if-none-match"];
  const ifNoneMatch = Array.isArray(ifNoneMatchHeader) ? ifNoneMatchHeader.join(",") : ifNoneMatchHeader;
  if (ifNoneMatch && ifNoneMatch.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || (tag.startsWith("W/") ? tag.slice(2) : tag) === etag;
  })) {
    return reply.code(304).send();
  }

  return reply.type("application/json").send(body);
}

// ── Issue #72: idempotency helpers ─────────────────────────────────────────
function extractIdempotencyKey(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  if (!trimmed || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) return undefined;
  return trimmed;
}

/**
 * Canonical JSON fingerprint of the run-creation request body.
 * Used to detect conflicts when the same key is reused with a different body.
 */
function requestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/**
 * Parses a query/path string that has already matched the strict positive-
 * integer text pattern (issue #78) and checks it against numeric bounds that
 * the pattern alone cannot express (e.g. the int32 ceiling). Returns
 * undefined — rather than throwing — so callers can map out-of-range values
 * to the same INVALID_REQUEST envelope used for shape failures.
 */
function parseBoundedInt(value: string, minimum: number, maximum: number): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return undefined;
  return parsed;
}

/** Issue #41: strict non-negative integer text (no signs, decimals, or exponents) within bounds. */
function parseIntegerText(value: string, minimum: number, maximum: number): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  return parseBoundedInt(value, minimum, maximum);
}

// ── Issue #43: structured logging helpers ─────────────────────────────────
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Accept a proxy-supplied X-Request-ID only when it is a single, safe token. */
function incomingRequestId(header: string | string[] | undefined): string | undefined {
  return typeof header === "string" && REQUEST_ID_PATTERN.test(header) ? header : undefined;
}

/**
 * Pino options for JSON log lines shaped as
 * `{"level":"info","timestamp":"…","requestId":"…","msg":"…"}`. Request and
 * response serializers keep only non-sensitive fields so headers (and any
 * credentials or idempotency keys they carry) never reach the logs.
 */
function structuredLoggerOptions(level: string) {
  return {
    level,
    messageKey: "msg",
    base: undefined,
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: { level: (label: string) => ({ level: label }) },
    serializers: {
      req: (request: { method?: string; url?: string }) => ({ method: request.method, url: request.url?.split("?", 1)[0] }),
      res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
    },
    redact: { paths: ["req.headers", "headers", "*.secret", "*.secretKey", "*.seed"], remove: true },
  };
}

// ── Issue #76: run retention metadata ──────────────────────────────────────
/**
 * Adds an `expiresAt` hint to terminal run responses, derived from the
 * configured retention window and the time the run became terminal.
 * Active (non-terminal) runs never get this field — claiming a terminal
 * expiry while a run is still in progress would be misleading.
 *
 * Note (documented limitation, not a bug): the in-memory run store may
 * evict a terminal run earlier than this hint under capacity pressure, and
 * no run state survives a process restart. `expiresAt` is a best-effort
 * upper bound, not a guarantee.
 */
function withRetentionMetadata<T extends RunReport>(run: T, retentionMs: number): T & { expiresAt?: string } {
  if ((run.status !== "passed" && run.status !== "failed" && run.status !== "cancelled") || !run.completedAt) return run;
  const expiresAt = new Date(Date.parse(run.completedAt) + retentionMs).toISOString();
  return { ...run, expiresAt };
}

async function* jsonRunExport(rows: AsyncIterable<RunExportRow>): AsyncGenerator<string> {
  yield "[";
  let first = true;
  for await (const row of rows) {
    if (!first) yield ",";
    yield JSON.stringify(row.report);
    first = false;
  }
  yield "]";
}

async function* csvRunExport(rows: AsyncIterable<RunExportRow>): AsyncGenerator<string> {
  yield "runId,scenarioId,status,createdAt,completedAt,durationMs\r\n";
  for await (const row of rows) {
    const values = [
      row.runId,
      row.scenarioId,
      row.status,
      row.createdAt,
      row.completedAt ?? "",
      String(row.durationMs),
    ];
    yield `${values.map(csvField).join(",")}\r\n`;
  }
}

function csvField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

// ── Issue #77: unsupported content type ────────────────────────────────────
function isUnsupportedMediaTypeError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" &&
    "statusCode" in error && error.statusCode === 415;
}

function submittedScenario(body: unknown, contentType: string | undefined): ValidatedScenario {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/yaml" || mediaType === "application/x-yaml" || mediaType === "text/yaml") {
    if (typeof body !== "string") throw new ScenarioValidationError(["YAML request body must be text"]);
    return parseScenario(body, "yaml");
  }
  return prepareScenario(body);
}

function submittedScenarioSchemaOnly(body: unknown, contentType: string | undefined): ValidatedScenario {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/yaml" || mediaType === "application/x-yaml" || mediaType === "text/yaml") {
    if (typeof body !== "string") throw new ScenarioValidationError(["YAML request body must be text"]);
    return parseScenarioSchemaOnly(body, "yaml");
  }
  return prepareScenarioSchemaOnly(body);
}
function apiError(code: string, message: string, requestId: string, details: string[] = []) { return { error: { code, message, requestId, details: details.slice(0, 50) } }; }
function isValidationError(error: unknown): error is { validation: unknown } { return typeof error === "object" && error !== null && "validation" in error; }
function hasStatus(error: unknown, status: number): boolean { return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === status; }
function isInvalidJsonBodyError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "FastifyError" &&
    "code" in error && error.code === "FST_ERR_CTP_INVALID_JSON_BODY" &&
    "statusCode" in error && error.statusCode === 400;
}
function isScenarioDefinitionPath(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/api/v1/scenarios/validate" || path === "/api/v1/runs/definitions";
}

function isDryRunRequest(url: string): boolean {
  const [path, query = ""] = url.split("?", 2);
  if (path !== "/api/v1/scenarios/validate") return false;
  return new URLSearchParams(query).get("dryRun") === "true";
}
