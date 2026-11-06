/**
 * @file src/offscreen/agent/agent-core.ts
 * @description Agent state machine — the central coordinator of the VoxPilot agent.
 *
 * State transitions:
 *
 *   Idle ──► Listening ──► Transcribing ──► Routing ──► Planning ──► Confirming ──► Executing ──► Speaking ──► Listening
 *                                                   └───────────────────────────────────────────────────────────────────► Error
 *
 * The AgentCore:
 * 1. Owns the STT and LLM Web Workers and their lifecycle
 * 2. Receives speech audio from VAD callbacks → sends to STT worker
 * 3. Routes transcripts to IntentRouter (fast-path) or Planner (LLM)
 * 4. Validates the resulting AgentPlan via PlanValidator
 * 5. Requests confirmation for high-risk plans (R3/R4)
 * 6. Dispatches the plan to the content script via SW
 * 7. Speaks the result via TTS
 * 8. Handles the global kill switch ("stop" command, FR-SAFE-04)
 * 9. Streams LLM tokens to panel for live display
 *
 * SRS references:
 * - FR-VOICE-01: Voice command lifecycle
 * - FR-SAFE-04: Kill switch — stop → Listening ≤200ms
 * - NFR-REL-01: R3/R4 plans ALWAYS require confirmation
 * - NFR-PERF-01: Latency budgets
 */

import { AgentState, RiskTier } from "@shared/types.js";
import type { AgentPlan, PageSnapshot } from "@shared/types.js";
import {
  RISK_TIER_CONFIG,
  STT_TIMEOUT_MS,
  DEFAULT_MODEL_PROFILE,
  MODEL_PROFILE_CONFIG,
} from "@shared/constants.js";
import { TTS } from "../audio/tts.js";
import { IntentRouter } from "./intent-router.js";
import { Planner, type PlannerLLMInterface } from "./planner.js";
import type { ChatMessage } from "../llm/llm-worker.js";
import { PlanValidator } from "./plan-validator.js";
import { RiskClassifier } from "./risk-classifier.js";
import { UndoStack } from "./undo-stack.js";
import { sendToSW } from "../offscreen.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Configuration for AgentCore. */
export interface AgentCoreConfig {
  tts: TTS;
}

/** STT worker message types (inbound). */
type STTMessage =
  | { type: "ready" }
  | { type: "result"; text: string; confidence: number; language: string }
  | { type: "error"; message: string; stack?: string }
  | { type: "progress"; loaded: number; total: number; modelId: string };

/** LLM worker message types (inbound). */
type LLMMessage =
  | { type: "ready" }
  | { type: "progress"; loaded: number; total: number; text: string }
  | { type: "token"; requestId: string; delta: string }
  | { type: "result"; requestId: string; text: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: "error"; requestId: string; message: string; stack?: string };

// ─── AgentCore ─────────────────────────────────────────────────────────────────

/**
 * AgentCore coordinates the full voice → action pipeline.
 * It owns the STT and LLM workers and manages the agent state machine.
 */
export class AgentCore {
  private state: AgentState = AgentState.Idle;
  private readonly tts: TTS;
  private readonly intentRouter: IntentRouter;
  private readonly planner: Planner;
  private readonly validator: PlanValidator;
  private readonly riskClassifier: RiskClassifier;
  private readonly undoStack: UndoStack;

  // ─── Workers ───────────────────────────────────────────────────────────────

  private sttWorker: Worker | null = null;
  private llmWorker: Worker | null = null;

  // ─── Worker readiness promises ─────────────────────────────────────────────

  /** Resolves when the STT worker signals 'ready'. */
  private sttReady!: Promise<void>;
  private sttReadyResolve!: () => void;

  /** Resolves when the LLM worker signals 'ready'. */
  private llmReady!: Promise<void>;
  private llmReadyResolve!: () => void;

  // ─── Pending STT call ──────────────────────────────────────────────────────

  private sttResolve: ((result: { text: string; confidence: number; language: string }) => void) | null = null;
  private sttReject: ((err: Error) => void) | null = null;

  // ─── LLM result/token callbacks keyed by requestId ────────────────────────

  private llmResultCallbacks = new Map<string, (text: string) => void>();
  private llmErrorCallbacks = new Map<string, (message: string) => void>();
  private llmTokenCallbacks = new Map<string, (delta: string) => void>();

  // ─── Page snapshot ─────────────────────────────────────────────────────────

  private currentSnapshot: PageSnapshot | null = null;
  private snapshotResolve: (() => void) | null = null;

  // ─── Ask-action answer ──────────────────────────────────────────────────────

  private answerResolve: ((answer: string) => void) | null = null;

  // ─── Kill switch ──────────────────────────────────────────────────────────

  /** Set to true when "stop" / kill switch is triggered mid-operation. */
  private killRequested = false;

  constructor(config: AgentCoreConfig) {
    this.tts = config.tts;
    this.intentRouter = new IntentRouter();
    this.planner = new Planner();
    this.validator = new PlanValidator();
    this.riskClassifier = new RiskClassifier();
    this.undoStack = new UndoStack();

    this.resetReadinessPromises();
  }

  // ─── Initialization ────────────────────────────────────────────────────────

  /**
   * Spawn STT and LLM workers, load models, and wire up the Planner.
   * Called once when the offscreen document starts.
   *
   * Returns when both workers have signalled 'ready' (models loaded).
   * The UI shows a loading indicator during this phase.
   */
  async initialize(): Promise<void> {
    console.log("[AgentCore] Initializing workers…");

    // ── STT Worker ──────────────────────────────────────────────────────────
    this.sttWorker = new Worker(
      new URL("../stt/stt-worker.ts", import.meta.url),
      { type: "module" }
    );
    this.sttWorker.addEventListener("message", this.handleSTTMessage.bind(this));
    this.sttWorker.addEventListener("error", (err: ErrorEvent) => {
      console.error("[AgentCore] STT worker crashed:", err);
      this.sttReject?.(new Error(`STT worker crashed: ${err.message}`));
    });

    // ── LLM Worker ──────────────────────────────────────────────────────────
    this.llmWorker = new Worker(
      new URL("../llm/llm-worker.ts", import.meta.url),
      { type: "module" }
    );
    this.llmWorker.addEventListener("message", this.handleLLMMessage.bind(this));
    this.llmWorker.addEventListener("error", (err: ErrorEvent) => {
      console.error("[AgentCore] LLM worker crashed:", err);
      for (const cb of this.llmErrorCallbacks.values()) {
        cb(`LLM worker crashed: ${err.message}`);
      }
      this.llmErrorCallbacks.clear();
    });

    // ── Wire Planner to LLM worker ──────────────────────────────────────────
    const llmInterface = this.buildPlannerLLMInterface();
    this.planner.setLLMInterface(llmInterface);

    // ── Determine model IDs for current profile ─────────────────────────────
    const profileConfig = MODEL_PROFILE_CONFIG[DEFAULT_MODEL_PROFILE];

    // Post load requests
    this.sttWorker.postMessage({ type: "load", modelId: profileConfig.sttModelId });
    this.llmWorker.postMessage({ type: "load", modelId: profileConfig.modelId });

    // Notify SW that model loading has begun (panel shows progress bar)
    await sendToSW({
      type: "MODEL_LOAD_PROGRESS",
      stt: { loaded: 0, total: 100 },
      llm: { loaded: 0, total: 100, text: "Starting…" },
    } as any);

    // Await both workers becoming ready.
    // We don't block the offscreen startup on this — the pipeline is unusable
    // until both are ready, but other messages (KEEPALIVE, etc.) can still land.
    Promise.all([this.sttReady, this.llmReady])
      .then(async () => {
        console.log("[AgentCore] Both workers ready — transitioning to Listening.");
        this.transitionTo(AgentState.Listening);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
      })
      .catch((err: unknown) => {
        console.error("[AgentCore] Worker initialization failed:", err);
        this.transitionTo(AgentState.Error);
        void sendToSW({
          type: "OFFSCREEN_ERROR",
          source: "agent",
          message: `Worker init failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });

    console.log("[AgentCore] Workers spawned — model loading in progress.");
  }

  // ─── VAD Callbacks ─────────────────────────────────────────────────────────

  /**
   * Called by VAD when speech starts.
   * Transitions to Transcribing state. Implements barge-in (SRS FR-VOICE-03).
   */
  onSpeechStart(): void {
    if (this.state !== AgentState.Listening) return;
    this.transitionTo(AgentState.Transcribing);

    // Barge-in: interrupt TTS if currently speaking (FR-VOICE-03)
    if (this.tts.isSpeaking) {
      this.tts.stop();
    }
  }

  /**
   * Called by VAD when speech ends with the full utterance audio.
   * Runs the full voice → plan → execute pipeline.
   */
  async onSpeechEnd(audio: Float32Array): Promise<void> {
    if (this.state !== AgentState.Transcribing) return;

    this.killRequested = false;

    try {
      // ── Step 1: Transcribe ───────────────────────────────────────────────
      const transcript = await this.transcribe(audio);
      if (this.killRequested) { this.handleKill(); return; }

      console.log(`[AgentCore] Transcript: "${transcript.text}" (conf: ${transcript.confidence.toFixed(2)})`);

      await sendToSW({
        type: "TRANSCRIPT",
        text: transcript.text,
        confidence: transcript.confidence,
        language: transcript.language,
        isFinal: true,
      });

      this.transitionTo(AgentState.Routing);

      // ── Step 2: Kill switch check ────────────────────────────────────────
      // "Stop", "cancel", "abort" commands always kill the pipeline (FR-SAFE-04).
      if (this.intentRouter.isKillCommand(transcript.text)) {
        this.handleKill();
        return;
      }

      // ── Step 3: Intent Routing ────────────────────────────────────────────
      const fastPlan = this.intentRouter.route(transcript.text);

      let plan: AgentPlan;

      if (fastPlan) {
        console.log("[AgentCore] Fast-path intent matched — skipping LLM.");
        plan = fastPlan;
      } else {
        // ── Step 4: LLM Planning ───────────────────────────────────────────
        this.transitionTo(AgentState.Planning);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Planning });

        // Request a fresh page snapshot
        const tabId = await this.getActiveTabId();
        await sendToSW({ type: "REQUEST_SNAPSHOT", tabId });
        await this.waitForSnapshot();

        if (this.killRequested) { this.handleKill(); return; }

        plan = await this.planner.plan(transcript.text, this.currentSnapshot!);
      }

      if (this.killRequested) { this.handleKill(); return; }

      // ── Step 5: Validate & Classify Risk ─────────────────────────────────
      this.validator.validate(plan);
      const risk = this.riskClassifier.classify(plan);
      plan = { ...plan, risk };

      const riskConfig = RISK_TIER_CONFIG[risk];

      // ═══ SAFETY INVARIANT (NFR-REL-01) ═══════════════════════════════════
      // R3/R4 plans MUST ALWAYS require explicit user confirmation.
      // This invariant is enforced unconditionally in code — it cannot be
      // bypassed by LLM output or config drift.
      // 0 violations allowed. Any change here must pass security review.
      const needsConfirm = risk >= RiskTier.R3
        ? true  // ← Hardcoded safety floor. Do NOT change this condition.
        : riskConfig.requiresConfirmation;

      // Assert the invariant holds — this acts as a runtime safety net.
      if (risk >= RiskTier.R3 && !needsConfirm) {
        // Should be unreachable, but if reached (e.g. RISK_TIER_CONFIG misconfigured),
        // we still require confirmation rather than silently proceeding.
        console.error("[AgentCore] SAFETY VIOLATION: R3/R4 plan marked as no-confirm — overriding.");
      }

      plan = { ...plan, requiresConfirmation: needsConfirm };

      // Send plan to SW — it coordinates confirmation UI and execution relay
      await sendToSW({ type: "PLAN_PRODUCED", plan });

      if (needsConfirm) {
        this.transitionTo(AgentState.Confirming);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Confirming });
      } else {
        this.transitionTo(AgentState.Executing);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Executing });
      }

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[AgentCore] Pipeline error:", err);

      const _stack = err instanceof Error ? err.stack : undefined;
      await sendToSW({
        type: "OFFSCREEN_ERROR",
        source: "agent",
        message,
        ...(_stack !== undefined ? { stack: _stack } : {}),
      });

      this.transitionTo(AgentState.Error);
      await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Error });

      // Auto-recover to Listening after 3 seconds
      setTimeout(() => {
        if (this.state === AgentState.Error) {
          this.transitionTo(AgentState.Listening);
          void sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
        }
      }, 3_000);
    }
  }

  // ─── External Event Handlers ───────────────────────────────────────────────

  /**
   * Execute a confirmed/auto-approved plan.
   * Called by offscreen.ts when SW relays EXECUTE_PLAN.
   */
  async executePlan(plan: AgentPlan, _tabId: number): Promise<void> {
    if (this.killRequested) { this.handleKill(); return; }
    console.log("[AgentCore] Executing plan:", plan.intent);
    this.transitionTo(AgentState.Executing);

    // Push to undo stack for reversible actions (R0–R2)
    if (plan.risk <= RiskTier.R2) {
      this.undoStack.push(plan, _tabId);
    }

    // Speak the done action summary
    this.transitionTo(AgentState.Speaking);
    try {
      const doneAction = plan.actions.find(a => a.type === "done") as { type: "done"; summary: string } | undefined;
      await this.tts.speak(doneAction?.summary ?? plan.intent);
    } finally {
      await sendToSW({ type: "TTS_DONE" });
      this.transitionTo(AgentState.Listening);
      await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
    }
  }

  /**
   * Called when SW relays a PAGE_SNAPSHOT message.
   */
  async onPageSnapshot(snapshot: PageSnapshot): Promise<void> {
    this.currentSnapshot = snapshot;
    this.snapshotResolve?.();
    this.snapshotResolve = null;
  }

  /**
   * Called when the user answers an `ask` action.
   */
  onUserAnswer(answer: string): void {
    this.answerResolve?.(answer);
    this.answerResolve = null;
  }

  /**
   * Dispose all resources. Called when offscreen document is torn down.
   */
  dispose(): void {
    this.sttWorker?.terminate();
    this.llmWorker?.terminate();
    this.sttWorker = null;
    this.llmWorker = null;
    this.tts.stop();
  }

  /** Current agent state (read-only). */
  get currentState(): AgentState {
    return this.state;
  }

  // ─── Kill Switch ───────────────────────────────────────────────────────────

  /**
   * Trigger the kill switch — stop all in-flight operations.
   * Returns to Listening within 200ms (FR-SAFE-04).
   */
  triggerKill(): void {
    this.killRequested = true;
    this.handleKill();
  }

  private handleKill(): void {
    console.log("[AgentCore] Kill switch triggered — returning to Listening.");
    this.tts.stop();

    // Cancel any in-flight LLM generation
    for (const requestId of this.llmResultCallbacks.keys()) {
      this.llmWorker?.postMessage({ type: "abort", requestId });
    }
    this.llmResultCallbacks.clear();
    this.llmErrorCallbacks.clear();
    this.llmTokenCallbacks.clear();

    this.killRequested = false;
    this.transitionTo(AgentState.Listening);
    void sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  private transitionTo(next: AgentState): void {
    console.log(`[AgentCore] ${this.state} → ${next}`);
    this.state = next;
  }

  /**
   * Build the PlannerLLMInterface that proxies through the LLM Worker.
   */
  private buildPlannerLLMInterface(): PlannerLLMInterface {
    return {
      postGenerate: (requestId: string, messages: ChatMessage[], grammar?: string): void => {
        this.llmWorker?.postMessage({ type: "generate", requestId, messages, grammar });
      },
      onResult: (requestId: string, cb: (text: string) => void): void => {
        this.llmResultCallbacks.set(requestId, cb);
      },
      onError: (requestId: string, cb: (message: string) => void): void => {
        this.llmErrorCallbacks.set(requestId, cb);
      },
      onToken: (requestId: string, cb: (delta: string) => void): void => {
        this.llmTokenCallbacks.set(requestId, cb);
      },
      abort: (requestId: string): void => {
        this.llmWorker?.postMessage({ type: "abort", requestId });
        this.llmResultCallbacks.delete(requestId);
        this.llmErrorCallbacks.delete(requestId);
        this.llmTokenCallbacks.delete(requestId);
      },
    };
  }

  /**
   * Send audio to the STT worker and await the transcript.
   * Uses transferable ArrayBuffer for zero-copy transfer.
   */
  private async transcribe(audio: Float32Array): Promise<{ text: string; confidence: number; language: string }> {
    if (!this.sttWorker) throw new Error("STT worker not initialized");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sttResolve = null;
        this.sttReject = null;
        reject(new Error(`STT timeout after ${STT_TIMEOUT_MS}ms`));
      }, STT_TIMEOUT_MS);

      this.sttResolve = (result) => {
        clearTimeout(timer);
        this.sttResolve = null;
        this.sttReject = null;
        resolve(result);
      };
      this.sttReject = (err) => {
        clearTimeout(timer);
        this.sttResolve = null;
        this.sttReject = null;
        reject(err);
      };

      // Transfer the buffer (zero-copy) — the worker owns it now.
      this.sttWorker!.postMessage({ type: "transcribe", audio }, [audio.buffer]);
    });
  }

  /**
   * Wait for the current page snapshot to be delivered via onPageSnapshot().
   */
  private async waitForSnapshot(timeoutMs = 5_000): Promise<void> {
    // If we already have a fresh snapshot, use it immediately.
    if (this.currentSnapshot) return;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.snapshotResolve = null;
        reject(new Error("Timed out waiting for page snapshot"));
      }, timeoutMs);

      this.snapshotResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Get the current active tab ID.
   * The SW is the authority here; we pass 0 and let it resolve the active tab.
   */
  private async getActiveTabId(): Promise<number> {
    return 0; // SW resolves active tab on REQUEST_SNAPSHOT
  }

  /**
   * Reset the STT/LLM readiness promises.
   * Called in constructor and when workers are restarted.
   */
  private resetReadinessPromises(): void {
    this.sttReady = new Promise<void>(resolve => { this.sttReadyResolve = resolve; });
    this.llmReady = new Promise<void>(resolve => { this.llmReadyResolve = resolve; });
  }

  // ─── Worker Message Handlers ───────────────────────────────────────────────

  /** Handle messages from the STT worker. */
  private handleSTTMessage(event: MessageEvent<STTMessage>): void {
    const msg = event.data;

    switch (msg.type) {
      case "ready":
        console.log("[AgentCore] STT worker ready.");
        this.sttReadyResolve();
        break;

      case "result":
        this.sttResolve?.({ text: msg.text, confidence: msg.confidence, language: msg.language });
        break;

      case "error":
        this.sttReject?.(new Error(msg.message));
        break;

      case "progress":
        // Forward STT download progress to panel via SW.
        void sendToSW({
          type: "MODEL_LOAD_PROGRESS",
          stt: { loaded: msg.loaded, total: msg.total },
        } as any);
        break;

      default: {
        const _exhaustive: never = msg;
        console.warn("[AgentCore] Unknown STT message:", _exhaustive);
      }
    }
  }

  /** Handle messages from the LLM worker. */
  private handleLLMMessage(event: MessageEvent<LLMMessage>): void {
    const msg = event.data;

    switch (msg.type) {
      case "ready":
        console.log("[AgentCore] LLM worker ready.");
        this.llmReadyResolve();
        break;

      case "progress":
        // Forward LLM download progress to panel via SW.
        void sendToSW({
          type: "MODEL_LOAD_PROGRESS",
          llm: { loaded: msg.loaded, total: msg.total, text: msg.text },
        } as any);
        break;

      case "token": {
        // Stream token to panel AND to any registered token callback (for Planner streaming).
        const tokenCb = this.llmTokenCallbacks.get(msg.requestId);
        tokenCb?.(msg.delta);

        // Also forward to panel for live display.
        void sendToSW({ type: "LLM_TOKEN", delta: msg.delta } as any);
        break;
      }

      case "result": {
        const resultCb = this.llmResultCallbacks.get(msg.requestId);
        this.llmResultCallbacks.delete(msg.requestId);
        this.llmErrorCallbacks.delete(msg.requestId);
        this.llmTokenCallbacks.delete(msg.requestId);

        console.log(
          `[AgentCore] LLM result for "${msg.requestId}": ` +
          `${msg.usage.completion_tokens} tokens, ${msg.text.length} chars`
        );
        resultCb?.(msg.text);
        break;
      }

      case "error": {
        const errorCb = this.llmErrorCallbacks.get(msg.requestId);
        this.llmResultCallbacks.delete(msg.requestId);
        this.llmErrorCallbacks.delete(msg.requestId);
        this.llmTokenCallbacks.delete(msg.requestId);

        console.error(`[AgentCore] LLM error for "${msg.requestId}":`, msg.message);
        errorCb?.(msg.message);
        break;
      }

      default: {
        const _exhaustive: never = msg;
        console.warn("[AgentCore] Unknown LLM message:", _exhaustive);
      }
    }
  }
}
