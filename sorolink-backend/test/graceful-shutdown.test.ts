import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, closeAfterDrain, type AppInstance } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { LedgerExecution, LedgerExecutionOptions, LedgerGateway, Scenario } from "../src/domain.js";
import { SafeRunError } from "../src/errors.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  horizonUrl: "https://horizon-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
  runTimeoutMs: 60_000,
  stepTimeoutMs: 1_000,
  maxConcurrentRuns: 2,
  metricsEnabled: true,
  maxConcurrentFriendbotRequests: 5,
  maxStoredRuns: 100,
  runRetentionMs: 60_000,
  rateLimitMax: 100,
  runRateLimitMax: 50,
  rateLimitWindowMs: 60_000,
  bodyLimitBytes: 16_384,
  persistenceMode: "disabled",
  runPersistenceEnabled: false,
  databasePoolMax: 5,
  databaseConnectionTimeoutMs: 5_000,
  databaseQueryTimeoutMs: 5_000,
  databaseIdleTimeoutMs: 10_000,
};

const passedExecution: LedgerExecution = {
  steps: [{ id: "send-xlm", type: "payment", status: "passed", message: "Confirmed." }],
  assertions: [{ type: "balanceEquals", status: "passed", expected: "5", actual: "5", message: "Balance matched." }],
};

/** A ledger whose executions stay pending until released, and reject when aborted. */
function controllableLedger() {
  const releases: Array<() => void> = [];
  const ledger: LedgerGateway = {
    execute: vi.fn((_scenario: Scenario, options: LedgerExecutionOptions = {}) => new Promise<LedgerExecution>((resolve, reject) => {
      releases.push(() => resolve(passedExecution));
      options.signal?.addEventListener("abort", () => reject(new SafeRunError({
        code: "SERVER_SHUTDOWN", message: "aborted", category: "internal", retryable: true,
      })), { once: true });
    })),
  };
  return { ledger, releaseAll: () => releases.splice(0).forEach((release) => release()) };
}

const apps: AppInstance[] = [];

async function startServer(ledger: LedgerGateway) {
  const app = buildApp({ config, ledger, readinessChecks: { horizon: async () => {} } });
  apps.push(app);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, address };
}

async function startRun(address: string): Promise<string> {
  const response = await fetch(`${address}/api/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId: "xlm-payment", inputs: {} }),
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { id: string }).id;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => {})));
});

describe("graceful shutdown", () => {
  it("stops accepting new requests, lets active runs finish, then closes cleanly", async () => {
    const { ledger, releaseAll } = controllableLedger();
    const { app, address } = await startServer(ledger);
    const runId = await startRun(address);
    await vi.waitFor(() => expect(ledger.execute).toHaveBeenCalledOnce());

    const closing = closeAfterDrain(app, 5_000);

    // New work is refused while draining; /health stays live.
    const rejected = await app.inject({ method: "POST", url: "/api/v1/runs", payload: { scenarioId: "xlm-payment", inputs: {} } });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json().error.code).toBe("SERVER_SHUTTING_DOWN");
    expect((await app.inject({ method: "GET", url: "/api/v1/scenarios" })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);

    releaseAll();
    await expect(closing).resolves.toEqual({ drained: true, cancelledRuns: 0 });

    expect(await app.runs.get(runId)).toMatchObject({ status: "passed" });
    expect(app.server.listening).toBe(false);
    await expect(fetch(`${address}/health`)).rejects.toThrow();
  });

  it("marks runs still active after the drain timeout as cancelled", async () => {
    const { ledger } = controllableLedger();
    const { app, address } = await startServer(ledger);
    const runIds = [await startRun(address), await startRun(address)];
    await vi.waitFor(() => expect(ledger.execute).toHaveBeenCalledTimes(2));

    const result = await closeAfterDrain(app, 25);

    expect(result).toEqual({ drained: false, cancelledRuns: 2 });
    for (const id of runIds) {
      expect(await app.runs.get(id)).toMatchObject({
        status: "cancelled",
        completedAt: expect.any(String),
        error: { code: "SERVER_SHUTDOWN", retryable: true },
      });
    }
    expect(app.runs.getMetrics()).toMatchObject({ activeRuns: 0, terminalRuns: { cancelled: 2 } });
    expect(app.server.listening).toBe(false);
  });

  it("closes immediately when no runs are active", async () => {
    const { ledger } = controllableLedger();
    const { app } = await startServer(ledger);

    await expect(closeAfterDrain(app, 5_000)).resolves.toEqual({ drained: true, cancelledRuns: 0 });
    expect(app.server.listening).toBe(false);
  });
});
