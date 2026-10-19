import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter, TmuxCreationResult, NativeCreationContext, NativeCreationReceipt } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import type { PersistedEvent } from "./types.js";
import { validateSessionName, deriveSessionName } from "./session-name.js";
import {
  startTranscriptRotation,
  getTranscriptRotationOptionsFromEnv,
} from "./transcript-rotation.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import { observeSolePane, paneObservationVerdict } from "./pane-binding-observation.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import type { OccupantKind } from "./session-registry.js";
import { mergeSeatEnv, seatEnvLaunchVars, type SeatEnv } from "./seat-env.js";
import { SEAT_PROJECT_DIR_ENV, seatCorePluginDir, withCorePlugin } from "./claude-core-plugin-env.js";

import type { Session, Binding } from "./types.js";

export type LaunchResult =
  | { ok: true; sessionName: string; session: Session; binding: Binding; warnings?: string[]; creation?: NativeCreationReceipt }
  | { ok: false; code: string; message: string };

interface LaunchOpts {
  sessionName?: string;
  cwd?: string;
  /**
   * Per-seat silence window override (seconds). Currently inert: the
   * live SeatActivityService poller uses the global default (3s) and
   * does not read per-seat windows. Retained for future per-seat-poller
   * decision. Caller plumbs from AgentSpec.profile.activity.
   */
  silenceWindowSeconds?: number;
  /** A deliberate fresh occupant is distinct from initial rig boot in the tenure ledger. */
  occupantKind?: OccupantKind;
  /** Synchronous retirement after an accepted native receipt, before successor state is published. */
  beforeNativeBinding?: () => void;
  /** One-off env for this launch only (`rig up --env`); wins over the spec's env and is not saved. */
  env?: SeatEnv;
  /** The seat's resolved plugin locations (what the profile resolver selected for it, or a snapshot saved). A Claude
   *  seat whose selection includes the vendored openrig-core plugin loads it. Without this the node's saved startup
   *  context is read. */
  pluginPaths?: readonly string[];
}

interface NodeLauncherDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  transcriptStore?: TranscriptStore;
  sessionEnv?: Record<string, string | undefined>;
  /** Extra launch env for one runtime only (OMP's provider keys), merged over
   *  sessionEnv so other runtimes' seats never receive it. */
  runtimeSessionEnv?: Record<string, Record<string, string | undefined>>;
  /** Where the daemon vendors its plugins; default is `plugins` under the OpenRig home (tests). */
  pluginsDir?: string;
  /** Default silence window (seconds). Currently used only as the
   *  SeatActivityService global default (3s). Per-seat override via
   *  LaunchOpts is currently inert. */
  defaultSilenceWindowSeconds?: number;
  /**
   * OPR.0.4.6.02 S1 — the SHARED tmux option-defaults applier (mouse/status
   * session-scope + set-clipboard/copy-command server-scope), applied to the
   * just-created session at launch. Injected from startup so the same
   * instance (and its once-per-daemon server-defaults memo) is shared with
   * SuccessorSessionLauncher. When omitted (most unit tests), the launch path
   * skips option application entirely.
   */
  tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
}

export class NodeLauncher {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private transcriptStore: TranscriptStore | null;
  private sessionEnv: Record<string, string>;
  private runtimeSessionEnv: Record<string, Record<string, string | undefined>>;
  private pluginsDir: string | undefined;
  private defaultSilenceWindowSeconds: number;
  private tmuxOptionDefaults: TmuxOptionDefaultsApplier | null;

  constructor(deps: NodeLauncherDeps) {
    // Hard runtime invariant: all domain services must share the same db handle.
    // Without this, db.transaction() in launchNode cannot span all writes atomically.
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("NodeLauncher: rigRepo must share the same db handle");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("NodeLauncher: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("NodeLauncher: eventBus must share the same db handle");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.transcriptStore = deps.transcriptStore ?? null;
    this.sessionEnv = compactEnv(deps.sessionEnv ?? {});
    this.runtimeSessionEnv = deps.runtimeSessionEnv ?? {};
    this.pluginsDir = deps.pluginsDir;
    this.defaultSilenceWindowSeconds = deps.defaultSilenceWindowSeconds ?? 3;
    this.tmuxOptionDefaults = deps.tmuxOptionDefaults ?? null;
  }

  async launchNode(
    rigId: string,
    logicalId: string,
    opts?: LaunchOpts
  ): Promise<LaunchResult> {
    // 1. Validate node exists and is unbound
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "node_not_found", message: `Rig ${rigId} not found` };
    }

    const node = rig.nodes.find((n) => n.logicalId === logicalId);
    if (!node) {
      return { ok: false, code: "node_not_found", message: `Node ${logicalId} not found in rig` };
    }

    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(node.id)) {
      return guard.lifecycle([node.id], () => this.launchNode(rigId, logicalId, opts));
    }

    if (node.binding !== null) {
      return { ok: false, code: "already_bound", message: `Node ${logicalId} is already bound` };
    }

    // 2. Derive or validate session name
    const sessionName = opts?.sessionName ?? deriveSessionName(rig.rig.name, logicalId);
    if (!validateSessionName(sessionName)) {
      return {
        ok: false,
        code: "invalid_session_name",
        message: `Derived session name "${sessionName}" does not match OpenRig naming pattern`,
      };
    }

    // 3. Reserve the source-bound occupant generation before the process starts. Reservation is
    // side-effect-free and fail-open: an unavailable ledger yields null and the launch remains valid.
    const occupantGeneration = this.sessionRegistry.reserveOccupantGeneration();

    // Create tmux session with OpenRig identity env vars. A duplicate is a
    // collision, never authority to kill an unmanaged same-name session.
    const specEnv = this.rigRepo.getEffectiveSeatEnv(node.id);
    const corePluginDir = seatCorePluginDir(node, this.db, opts?.pluginPaths, this.pluginsDir);
    const sessionCwd = opts?.cwd ?? node.cwd ?? undefined;
    const launchEnv = (oneOff?: SeatEnv) => compactEnv({
      OPENRIG_NODE_ID: node.id,
      OPENRIG_SESSION_NAME: sessionName,
      OPENRIG_RUNTIME: node.runtime ?? undefined,
      ...this.sessionEnv,
      ...(node.runtime ? this.runtimeSessionEnv[node.runtime] : undefined),
      ...seatEnvLaunchVars(withCorePlugin(mergeSeatEnv(specEnv, oneOff), corePluginDir)),
      // The launch project of a seat that loads the plugin, so a Claude started elsewhere inside the seat is not taken for it.
      [SEAT_PROJECT_DIR_ENV]: corePluginDir ? sessionCwd : undefined,
      OPENRIG_OCCUPANT_GENERATION: occupantGeneration ?? undefined,
    });
    const openRigEnv = launchEnv(opts?.env);
    let nativeContext: NativeCreationContext | undefined;
    if (this.tmuxAdapter.usesCheckedCreation?.()) {
      if (opts?.env && Object.keys(opts.env).length > 0) return { ok: false, code: "native_one_off_env_unsupported", message: "Native one-off environment cleanup is not epoch-bound; no session was created." };
      const root = this.tmuxAdapter.nativeCreationRoot();
      if (!root) return { ok: false, code: "native_creation_root_unverified", message: "Native creation requires a canonical private backend root; no session was created." };
      if (this.unresolvedNativeCreation(node.id)) return { ok: false, code: "native_create_unresolved", message: "A prior native creation attempt is unresolved; reconcile it before another launch. No retry was attempted." };
      nativeContext = { attempt: randomUUID(), root };
      try { this.eventBus.emit({ type: "native.creation_attempt", rigId, nodeId: node.id, name: sessionName, ...nativeContext }); }
      catch { return { ok: false, code: "native_creation_journal_failed", message: "Could not record the creation attempt; no creation was dispatched." }; }
    }
    let tmuxResult: TmuxCreationResult;
    try { tmuxResult = await this.tmuxAdapter.createSession(sessionName, sessionCwd, openRigEnv, nativeContext); }
    catch (error) {
      if (!nativeContext) throw error;
      tmuxResult = { ok: false, code: "native_create_unknown", message: "Creation completion is unknown; no retry or name cleanup was attempted.", creationOutcome: "unknown" };
    }
    if (!tmuxResult.ok) {
      if (nativeContext) {
        this.nativeCreationResult(rigId, node.id, sessionName, nativeContext, tmuxResult.creationOutcome ?? "unknown", null,
          tmuxResult.creationAttempt?.pid ?? null, tmuxResult.creationAttempt?.birth ?? null);
      }
      return { ok: false, code: tmuxResult.code, message: tmuxResult.message };
    }
    const creation = tmuxResult.creation;
    if (nativeContext && !creation) {
      this.nativeCreationResult(rigId, node.id, sessionName, nativeContext, "unknown");
      return { ok: false, code: "native_create_unknown", message: "Creation did not return its own qualified epoch; nothing was bound." };
    }
    if (creation && opts?.beforeNativeBinding) {
      try { opts.beforeNativeBinding(); }
      catch {
        const stopped = await this.tmuxAdapter.stopCreatedSession(creation, node.id);
        this.nativeCreationResult(rigId, node.id, sessionName, creation, stopped.ok ? "stopped" : "unknown", creation.pane);
        return { ok: false, code: "native_retirement_failed", message: "Prior occupant retirement failed; the original creation was compensated without publishing a successor binding." };
      }
    }
    if (creation && !this.nativeCreationResult(rigId, node.id, sessionName, creation, "created", creation.pane)) {
      // The started record remains unresolved. Never use the name to repair it.
      await this.tmuxAdapter.stopCreatedSession(creation, node.id);
      return { ok: false, code: "native_creation_journal_failed", message: "Could not retain the creation receipt; its started attempt remains unresolved." };
    }

    // A one-off `rig up --env` value is on the first pane's command line and, because that is how
    // `new-session -e` works, in the session environment, which a respawned pane (a handover
    // successor) inherits. The first pane has already started with it, so take it back out of the
    // session: the spec's or OpenRig's own value for a name they set, no value for the rest.
    if (opts?.env && Object.keys(opts.env).length > 0) {
      const failed = await this.dropOneOffFromSession(sessionName, Object.keys(opts.env), launchEnv());
      if (failed) {
        // The first pane has already started with the one-off, so this is a stopped launch, not an
        // undone one. Say whether the new session (the one this launch just created) is gone, and
        // never include tmux's text or a value.
        let removed = false;
        try { removed = (await this.tmuxAdapter.killSession(sessionName)).ok; } catch { /* not confirmed */ }
        return {
          ok: false,
          code: "seat_env_cleanup_failed",
          message: removed
            ? `Could not take the --env setting ${failed} out of the new session "${sessionName}" environment, so the launch was stopped and the session was removed. Run it again.`
            : `Could not take the --env setting ${failed} out of the new session "${sessionName}" environment, so the launch was stopped, and the session could not be confirmed removed. It may still hold the --env values in its terminal and environment and nothing is bound to it: check it and remove it before running this again.`,
        };
      }
    }

    // The session's own non-fatal warnings (#771: the parent-session identity cleanup).
    const launchWarnings: string[] = [...(tmuxResult.warnings ?? [])];

    // Observe the pane before the DB transaction. A concrete pane is committed
    // with session+binding; an unresolved pane gets a durable named verdict in
    // that same transaction rather than carrying an unexplained NULL forward.
    const paneObservation = creation ? { ok: true as const, pane: creation.pane } : await observeSolePane(this.tmuxAdapter, sessionName);

    // 3a2. OPR.0.4.6.02 S1 — apply the daemon's tmux option defaults to the
    // JUST-CREATED session via the shared applier (mouse/status session-scope
    // + set-clipboard/copy-command server-scope). Touches only this new
    // session, never an existing one (BR-1 never-retro). Option-set failures
    // come back as non-fatal launch warnings.
    if (creation && this.tmuxOptionDefaults) launchWarnings.push("Native option defaults were not applied: epoch-bound option mutation is unavailable.");
    if (!creation && this.tmuxOptionDefaults) {
      launchWarnings.push(...(await this.tmuxOptionDefaults.applyToFreshSession(sessionName)));
    }

    // 3b. Start transcript rotation (V1 pre-release CLI/daemon Item 1:
    // bounded capture-pane overwrite replaces the unbounded pipe-pane
    // mechanism). Failures inside individual rotation ticks are silent
    // (best-effort); only the transcript directory not being writable
    // surfaces a launch warning.
    if (creation && this.transcriptStore?.enabled) launchWarnings.push("Native transcript rotation was not started: epoch-bound capture is unavailable.");
    if (!creation && this.transcriptStore?.enabled) {
      const dirOk = this.transcriptStore.ensureTranscriptDir(rig.rig.name);
      if (dirOk) {
        const transcriptPath = this.transcriptStore.getTranscriptPath(rig.rig.name, sessionName);
        startTranscriptRotation(
          this.tmuxAdapter,
          sessionName,
          transcriptPath,
          getTranscriptRotationOptionsFromEnv(),
          getTranscriptRotationOptionsFromEnv,
        );
      } else {
        launchWarnings.push(`Transcript directory creation failed for rig ${rig.rig.name}`);
      }
    }

    // 4. DB transaction: session + binding + event (atomic)
    let persistedEvent: PersistedEvent;
    let createdSessionId: string | null = null;
    let nativeBoundEvent: PersistedEvent | null = null;
    try {
      const txn = this.db.transaction(() => {
        const session = this.sessionRegistry.registerSession(
          node.id,
          sessionName,
          opts?.occupantKind ?? "initial",
          occupantGeneration,
        );
        createdSessionId = session.id;
        this.sessionRegistry.updateStatus(session.id, "running");
        this.sessionRegistry.updateBinding(node.id, {
          tmuxSession: sessionName,
          ...(paneObservation.ok ? { tmuxPane: paneObservation.pane } : {}),
        });
        if (!paneObservation.ok) {
          new SeatIdentityStore(this.db).upsert(paneObservationVerdict({
            nodeId: node.id,
            sessionId: session.id,
            sessionName,
            observation: paneObservation,
          }));
        }
        if (creation) {
          nativeBoundEvent = this.eventBus.persistWithinTransaction({ type: "native.creation_result", rigId, nodeId: node.id,
            ...creation, status: "bound", pid: null, birth: null });
          this.eventBus.registerPersistedWithinActiveEnvelope(nativeBoundEvent);
        }
        return this.eventBus.persistWithinTransaction({
          type: "node.launched",
          rigId,
          nodeId: node.id,
          logicalId: node.logicalId,
          sessionName,
        });
      });
      persistedEvent = txn();
    } catch (err) {
      // Native compensation stays on the original receipt, never a reused name.
      if (creation) {
        const stopped = await this.tmuxAdapter.stopCreatedSession(creation, node.id);
        this.nativeCreationResult(rigId, node.id, sessionName, creation, stopped.ok ? "stopped" : "unknown", creation.pane);
      } else await this.tmuxAdapter.killSession(sessionName);
      return {
        ok: false,
        code: "db_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(node.id);
    this.tmuxAdapter.finishLaunchBinding?.(sessionName);

    // 5. Notify subscribers (best-effort, after commit)
    this.eventBus.notifySubscribers(persistedEvent);
    if (nativeBoundEvent) this.eventBus.notifySubscribers(nativeBoundEvent);

    // 6. Fetch the created session + binding for the caller
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);
    const session = sessions.find((s) => s.id === createdSessionId);
    const binding = this.sessionRegistry.getBindingForNode(node.id);

    return {
      ok: true,
      sessionName,
      session: session!,
      binding: binding!,
      warnings: launchWarnings.length > 0 ? launchWarnings : undefined,
      ...(creation ? { creation } : {}),
    };
  }

  private unresolvedNativeCreation(nodeId: string): boolean {
    try {
      const rows = this.db.prepare("SELECT type,payload FROM events WHERE node_id=? AND type IN ('native.creation_attempt','native.creation_result') ORDER BY seq").all(nodeId) as Array<{ type: string; payload: string }>;
      const pending = new Map<string, string>();
      for (const row of rows) {
        const value = JSON.parse(row.payload) as { attempt: string; status?: string };
        if (typeof value.attempt !== "string") return true;
        pending.set(value.attempt, row.type === "native.creation_attempt" ? "started" : value.status ?? "unknown");
      }
      return [...pending.values()].some(status => !["bound", "stopped", "collision", "not_started"].includes(status));
    } catch { return true; }
  }

  private nativeCreationResult(rigId: string, nodeId: string, name: string, context: NativeCreationContext,
    status: "created" | "collision" | "not_started" | "unknown" | "stopped", pane: string | null = null,
    pid: string | null = null, birth: string | null = null): boolean {
    try { this.eventBus.emit({ type: "native.creation_result", rigId, nodeId, name, ...context, status, pane, pid, birth }); return true; }
    catch { return false; } // The started record remains unresolved and blocks another create.
  }

  /**
   * Put each one-off name back to what the session would have had without it: `baseline` has the
   * value the spec or OpenRig set for it, and a name with none is unset (the server's own value, if
   * it has one, is what a later pane gets). `TMUX` and `TMUX_PANE` belong to tmux and are left alone.
   * Returns the name that could not be restored, or undefined when all were. The message built from
   * it carries no value: tmux errors repeat the command line.
   */
  private async dropOneOffFromSession(session: string, names: string[], baseline: Record<string, string>): Promise<string | undefined> {
    for (const name of names) {
      if (name === "TMUX" || name === "TMUX_PANE") continue;
      try {
        const value = baseline[name];
        if (value !== undefined) await this.tmuxAdapter.setSessionEnv(session, name, value);
        else await this.tmuxAdapter.unsetSessionEnv(session, name);
      } catch {
        return name;
      }
    }
    return undefined;
  }
}

function compactEnv(input: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}
