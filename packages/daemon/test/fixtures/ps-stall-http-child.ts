// Real-HTTP child fixture for the D2 event-loop regression (slice-04,
// qitem-20260721000001-ps-stall-driver).
//
// buildStallApp(db) is the SHARED wiring used both in-process (D1/D3 via
// app.request) and by the child `main()` (D2 via a real localhost listener).
// PsProjectionService is wired WITH AgentActivityStore (createTestApp omits it),
// so the attention fold is exercised. SeatActivityService is intentionally ABSENT
// (copied-state environmental caveat) — never synthesized.
//
// Run as a child: `node --import tsx ps-stall-http-child.ts` — it seeds a
// host-shaped synthetic DB (27/198, exactly 219,541 events), serves on an
// ephemeral loopback port, and prints EXACTLY one readiness line `READY <port>`.
import { Hono, type MiddlewareHandler } from "hono";
import { serve } from "@hono/node-server";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { RigRepository } from "../../src/domain/rig-repository.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { AgentActivityStore } from "../../src/domain/agent-activity-store.js";
import { PsProjectionService } from "../../src/domain/ps-projection.js";
import { psRoutes } from "../../src/routes/ps.js";
import { rigsRoutes } from "../../src/routes/rigs.js";
import { createMigratedDb, seedHostShaped } from "../helpers/seed-host-shaped.js";
import { projectionLane } from "../../src/domain/projection-lane.js";

export function buildStallApp(db: Database.Database, diagnostics?: MiddlewareHandler): Hono {
  const repo = new RigRepository(db);
  const eventBus = new EventBus(db);
  const agentActivity = new AgentActivityStore({ db, eventBus });
  const psService = new PsProjectionService({ db, agentActivity }); // agentActivity REQUIRED; seatActivity ABSENT

  const app = new Hono();
  if (diagnostics) app.use("*", diagnostics);
  app.use("*", async (c, next) => {
    c.set("psProjectionService" as never, psService as never);
    c.set("rigRepo" as never, repo as never);
    c.set("eventBus" as never, eventBus as never);
    c.set("agentActivityStore" as never, agentActivity as never);
    await next();
  });
  app.route("/api/ps", psRoutes);
  app.route("/api/rigs", rigsRoutes);
  // Trivial diagnostic /healthz — NOT daemon health semantics; it measures pure
  // event-loop availability (a synchronous ps/summary handler blocks even this).
  app.get("/healthz", (c) => c.json({ ok: true, diagnostic_stub: true }));
  return app;
}

// Child-only, reporting-only: no per-job I/O and no production lane changes.
// Epoch coordinates permit approximate cross-process overlap; request IDs, not
// clock subtraction, join a parent probe to its child route. Wall time includes
// descheduling; CPU/ELU/delay do not identify host contention or a SQL statement.
function stallDiagnostics() {
  const context = new AsyncLocalStorage<{ id: number; route: string }>();
  const routes: { id: number; route: string; start: number; end: number }[] = [];
  const jobs: { id: number | null; route: string; queued: number; start: number; end: number; user: number; system: number }[] = [];
  const epoch = () => performance.timeOrigin + performance.now();
  const started = epoch(), cpu = process.cpuUsage(), elu = performance.eventLoopUtilization();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let routeCount = 0, jobCount = 0, maxJobMs = 0;
  const run = projectionLane.run.bind(projectionLane);
  projectionLane.run = <T>(job: () => T): Promise<T> => {
    const owner = context.getStore(), queued = epoch();
    return run(() => {
      const beforeCpu = process.cpuUsage(), start = epoch();
      try { return job(); }
      finally {
        const end = epoch(), used = process.cpuUsage(beforeCpu);
        jobCount++;
        maxJobMs = Math.max(maxJobMs, end - start);
        if (jobs.length < 64) jobs.push({ id: owner?.id ?? null, route: owner?.route ?? "unattributed",
          queued, start, end, user: used.user, system: used.system });
      }
    });
  };
  const middleware: MiddlewareHandler = async (c, next) => {
    const id = ++routeCount, route = c.req.path, start = epoch();
    await context.run({ id, route }, async () => {
      try { await next(); }
      finally {
        if (routes.length < 128) routes.push({ id, route, start, end: epoch() });
        if (route === "/healthz") c.header("x-stall-request-id", String(id));
      }
    });
  };
  return { middleware, finish: () => {
    delay.disable();
    const report = { version: 1, timeOrigin: performance.timeOrigin, started, ended: epoch(),
      cpuMicros: process.cpuUsage(cpu), elu: performance.eventLoopUtilization(elu), delayMaxMs: delay.max / 1e6,
      routeCount, jobCount, maxJobMs, droppedRoutes: routeCount - routes.length, droppedJobs: jobCount - jobs.length,
      routes, jobs };
    const encoded = JSON.stringify(report);
    // One bounded synchronous write AFTER measurement, before the existing exit;
    // no flush timer, extra HTTP call, or new teardown wait is introduced.
    const bounded = Buffer.byteLength(encoded) <= 48 * 1024 ? encoded
      : JSON.stringify({ ...report, routes: [], jobs: [], byteBoundExceeded: true });
    writeSync(1, `D2_TRACE ${bounded}\n`);
  } };
}

// ---- child entrypoint ----
const runAsChild = Boolean(process.argv[1] && process.argv[1].includes("ps-stall-http-child"));
if (runAsChild) {
  // The child OWNS both the server and the db: every exit path — setup throw,
  // signal, or uncaught error — closes both before exiting, so no listener or
  // sqlite handle is ever leaked.
  let db: Database.Database | null = null;
  let server: { close: (cb?: () => void) => void } | null = null;
  let closing = false;
  let reportDiagnostics = () => {};
  const closeAll = (code: number) => {
    if (closing) return; // idempotent: duplicate signal/error paths cannot close/exit twice
    closing = true;
    try { reportDiagnostics(); } catch { /* Missing diagnostics never replaces the original exit/closure proof. */ }
    const done = () => { try { db?.close(); } catch { /* noop */ } process.exit(code); };
    try { if (server) server.close(done); else done(); } catch { done(); }
  };
  process.on("SIGTERM", () => closeAll(0));
  process.on("SIGINT", () => closeAll(0));
  process.on("uncaughtException", (e) => { process.stderr.write(`child uncaught: ${(e as Error).message}\n`); closeAll(1); });
  try {
    db = createMigratedDb();
    seedHostShaped(db);
    const diagnostics = stallDiagnostics();
    reportDiagnostics = diagnostics.finish;
    const app = buildStallApp(db, diagnostics.middleware);
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      process.stdout.write(`READY ${info.port}\n`);
    });
  } catch (e) {
    process.stderr.write(`child setup failed: ${(e as Error).message}\n`);
    closeAll(1); // setup failure still closes the db
  }
}
