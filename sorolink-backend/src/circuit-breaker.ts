import { SafeRunError } from "./errors.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Default 5. */
  failureThreshold?: number;
  /** The consecutive failures must all fall inside this window. Default 60 s. */
  failureWindowMs?: number;
  /** Time the circuit stays open before allowing a half-open probe. Default 30 s. */
  cooldownMs?: number;
  /** Injectable clock so tests never depend on real timers. */
  now?: () => number;
}

export const DEFAULT_CIRCUIT_BREAKER_OPTIONS = {
  failureThreshold: 5,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
} as const;

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  opens: number;
  rejectedCalls: number;
}

export class CircuitOpenError extends SafeRunError {
  constructor(service: string) {
    super({
      code: "CIRCUIT_OPEN",
      message: `${service} is temporarily unavailable; calls are being rejected until it recovers.`,
      category: "network",
      retryable: true,
    });
    this.name = "CircuitOpenError";
  }
}

/**
 * Consecutive-failure circuit breaker.
 *
 * closed    → calls pass; N consecutive failures within the window open it.
 * open      → calls fail fast with CIRCUIT_OPEN until the cooldown elapses.
 * half_open → exactly one probe call is admitted; success closes the circuit,
 *             failure re-opens it for another cooldown.
 *
 * The state is time-derived (no timers), so it is fully driven by `now()`.
 */
export class CircuitBreaker {
  readonly #threshold: number;
  readonly #windowMs: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;
  #state: CircuitState = "closed";
  #failureTimestamps: number[] = [];
  #openedAt = 0;
  #probeInFlight = false;
  #opens = 0;
  #rejectedCalls = 0;

  constructor(readonly service: string, options: CircuitBreakerOptions = {}) {
    this.#threshold = Math.max(1, options.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_OPTIONS.failureThreshold);
    this.#windowMs = Math.max(0, options.failureWindowMs ?? DEFAULT_CIRCUIT_BREAKER_OPTIONS.failureWindowMs);
    this.#cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_CIRCUIT_BREAKER_OPTIONS.cooldownMs);
    this.#now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this.#state === "open" && this.#now() - this.#openedAt >= this.#cooldownMs) {
      this.#state = "half_open";
      this.#probeInFlight = false;
    }
    return this.#state;
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.#failureTimestamps.length,
      opens: this.#opens,
      rejectedCalls: this.#rejectedCalls,
    };
  }

  /**
   * Run `operation` through the breaker. `isFailure` decides which errors
   * count against the service (e.g. 5xx/timeouts) versus ordinary
   * application responses (e.g. 404, tx_failed) that prove it is healthy.
   */
  async execute<T>(operation: () => Promise<T>, isFailure: (error: unknown) => boolean = () => true): Promise<T> {
    const probe = this.#admit();
    try {
      const result = await operation();
      this.#onSuccess();
      return result;
    } catch (error) {
      if (isFailure(error)) this.#onFailure();
      else this.#onSuccess();
      throw error;
    } finally {
      if (probe) this.#probeInFlight = false;
    }
  }

  /** Returns true when the admitted call is the half-open probe. */
  #admit(): boolean {
    const state = this.state;
    if (state === "closed") return false;
    if (state === "half_open" && !this.#probeInFlight) {
      this.#probeInFlight = true;
      return true;
    }
    this.#rejectedCalls += 1;
    throw new CircuitOpenError(this.service);
  }

  #onSuccess(): void {
    this.#failureTimestamps = [];
    this.#state = "closed";
  }

  #onFailure(): void {
    const now = this.#now();
    if (this.#state === "half_open") {
      this.#open(now);
      return;
    }
    this.#failureTimestamps = this.#failureTimestamps.filter((at) => now - at < this.#windowMs);
    this.#failureTimestamps.push(now);
    if (this.#failureTimestamps.length >= this.#threshold) this.#open(now);
  }

  #open(now: number): void {
    this.#state = "open";
    this.#openedAt = now;
    this.#failureTimestamps = [];
    this.#opens += 1;
  }
}
