import { buildApp, closeAfterDrain } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = buildApp({ config, logger: true });

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ address }, "SoroLink backend is listening");
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

// ── Graceful-shutdown lifecycle ──────────────────────────────────────────────
//
// SIGTERM and SIGINT each trigger shutdown exactly once.  The sequence is:
//   1. Mark the RunService as draining: every new request except /health gets 503.
//   2. Wait for active executions, capped at SHUTDOWN_DRAIN_TIMEOUT_MS.
//   3. Mark runs still active after the deadline as cancelled (SERVER_SHUTDOWN).
//   4. Close Fastify (stops listening, waits for open connections, fires onClose
//      hooks that release DB pools / timers), then exit.

const DRAIN_TIMEOUT_MS = config.shutdownDrainTimeoutMs ?? 30_000;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info({ signal }, "Shutdown signal received — draining active runs");

  // Drain runs before Fastify's onClose hooks release persistence resources.
  try {
    const result = await closeAfterDrain(app, DRAIN_TIMEOUT_MS);
    app.log.info(result, "Shutdown complete");
    process.exit(0);
  } catch (closeError) {
    app.log.error(closeError, "Error while draining or closing the server");
    process.exit(1);
  }
}

process.once("SIGTERM", () => { shutdown("SIGTERM").catch((err) => { app.log.error(err, "Fatal during SIGTERM shutdown"); process.exit(1); }); });
process.once("SIGINT",  () => { shutdown("SIGINT").catch((err)  => { app.log.error(err, "Fatal during SIGINT shutdown");  process.exit(1); }); });
