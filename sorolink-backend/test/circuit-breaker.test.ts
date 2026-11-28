import { afterEach, describe, expect, it, vi } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import { CircuitBreaker, CircuitOpenError } from "../src/circuit-breaker.js";
import type { ValidatedScenario } from "../src/domain.js";
import { StellarTestnetGateway } from "../src/stellar-gateway.js";

/** Manual clock: the breaker is time-derived, so no real or fake timers are needed. */
function manualClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

const fail = () => Promise.reject(new Error("Horizon down"));
const ok = () => Promise.resolve("ok");

async function failTimes(breaker: CircuitBreaker, count: number, clock?: { advance(ms: number): void }, stepMs = 0) {
  for (let i = 0; i < count; i += 1) {
    await expect(breaker.execute(fail)).rejects.toThrow("Horizon down");
    clock?.advance(stepMs);
  }
}

describe("CircuitBreaker", () => {
  it("opens after 5 consecutive failures within 60 s", async () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker("Horizon", { now: clock.now });

    await failTimes(breaker, 4, clock, 10_000);
    expect(breaker.state).toBe("closed");
    await failTimes(breaker, 1);

    expect(breaker.state).toBe("open");
    expect(breaker.snapshot().opens).toBe(1);
  });

  it("does not open when the failures are spread beyond the 60 s window", async () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker("Horizon", { now: clock.now });

    await failTimes(breaker, 5, clock, 15_001);

    expect(breaker.state).toBe("closed");
  });

  it("resets the consecutive count on success", async () => {
    const breaker = new CircuitBreaker("Horizon", { now: manualClock().now });

    await failTimes(breaker, 4);
    await breaker.execute(ok);
    await failTimes(breaker, 4);

    expect(breaker.state).toBe("closed");
  });

  it("fails fast with CIRCUIT_OPEN while open without invoking the operation", async () => {
    const breaker = new CircuitBreaker("Horizon", { now: manualClock().now });
    await failTimes(breaker, 5);
    const operation = vi.fn(ok);

    const error = await breaker.execute(operation).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(error).toMatchObject({ report: { code: "CIRCUIT_OPEN", retryable: true } });
    expect(operation).not.toHaveBeenCalled();
    expect(breaker.snapshot().rejectedCalls).toBe(1);
  });

  it("transitions to half-open after the default 30 s cooldown and closes on a successful probe", async () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker("Horizon", { now: clock.now });
    await failTimes(breaker, 5);

    clock.advance(29_999);
    expect(breaker.state).toBe("open");
    clock.advance(1);
    expect(breaker.state).toBe("half_open");

    await expect(breaker.execute(ok)).resolves.toBe("ok");
    expect(breaker.state).toBe("closed");
  });

  it("honours a configurable cooldown", async () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker("Horizon", { now: clock.now, cooldownMs: 5_000 });
    await failTimes(breaker, 5);

    clock.advance(5_000);

    expect(breaker.state).toBe("half_open");
  });

  it("re-opens when the half-open probe fails", async () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker("Horizon", { now: clock.now });
    await failTimes(breaker, 5);
    clock.advance(30_000);

    await failTimes(breaker, 1);

    expect(breaker.state).toBe("open");
    expect(breaker.snapshot().opens).toBe(2);
  });

  it("admits only one concurrent half-open probe", async () => {
    const clock = manualClock();
    const breaker = new CircuitBreaker("Horizon", { now: clock.now });
    await failTimes(breaker, 5);
    clock.advance(30_000);
    let release!: () => void;
    const probe = breaker.execute(() => new Promise<void>((resolve) => { release = resolve; }));

    await expect(breaker.execute(ok)).rejects.toMatchObject({ report: { code: "CIRCUIT_OPEN" } });
    release();
    await probe;

    expect(breaker.state).toBe("closed");
  });

  it("does not count errors the classifier treats as healthy responses", async () => {
    const breaker = new CircuitBreaker("Horizon", { now: manualClock().now });

    for (let i = 0; i < 10; i += 1) {
      await expect(breaker.execute(fail, () => false)).rejects.toThrow();
    }

    expect(breaker.state).toBe("closed");
  });
});

describe("StellarTestnetGateway with a Horizon circuit breaker", () => {
  const scenario: ValidatedScenario = {
    schemaVersion: 1,
    id: "horizon-circuit",
    version: 1,
    name: "Horizon circuit",
    description: "Exercises the Horizon circuit breaker",
    network: "testnet",
    contentHash: "sha256:circuit",
    accounts: [{ id: "alice", generate: true, fund: false }],
    assets: [{ id: "xlm", type: "native" }],
    steps: [],
    assertions: [{ type: "accountExists", account: "alice" }],
  };
  const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

  afterEach(() => { vi.restoreAllMocks(); });

  function gateway(breaker: CircuitBreaker) {
    return new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", {
      horizonRetry: { maxRetries: 0 },
      sleep: async () => {},
      horizonCircuitBreaker: breaker,
    });
  }

  it("fast-fails Horizon calls with CIRCUIT_OPEN after 5 consecutive 503s", async () => {
    const loadAccount = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockRejectedValue(httpError(503));
    const breaker = new CircuitBreaker("Horizon", { now: manualClock().now });
    const subject = gateway(breaker);

    for (let i = 0; i < 5; i += 1) {
      await expect(subject.execute(scenario)).rejects.toMatchObject({ report: { code: "HORIZON_UNAVAILABLE" } });
    }
    await expect(subject.execute(scenario)).rejects.toMatchObject({ report: { code: "CIRCUIT_OPEN" } });

    expect(loadAccount).toHaveBeenCalledTimes(5);
    expect(breaker.state).toBe("open");
  });

  it("does not retry while the circuit is open", async () => {
    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockRejectedValue(httpError(503));
    const breaker = new CircuitBreaker("Horizon", { now: manualClock().now, failureThreshold: 1 });
    const sleep = vi.fn(async () => {});
    const subject = new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", {
      horizonRetry: { maxRetries: 3 },
      sleep,
      horizonCircuitBreaker: breaker,
    });

    await expect(subject.execute(scenario)).rejects.toMatchObject({ report: { code: "CIRCUIT_OPEN" } });

    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("treats 404 responses as a healthy Horizon", async () => {
    vi.spyOn(Horizon.Server.prototype, "loadAccount").mockRejectedValue(httpError(404));
    const breaker = new CircuitBreaker("Horizon", { now: manualClock().now });
    const subject = gateway(breaker);

    for (let i = 0; i < 6; i += 1) {
      const result = await subject.execute(scenario);
      expect(result.assertions[0]).toMatchObject({ status: "failed" });
    }

    expect(breaker.state).toBe("closed");
  });
});
