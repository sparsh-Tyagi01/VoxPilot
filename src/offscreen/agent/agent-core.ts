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

import { AgentState, RiskTier, ModelProfile } from "@shared/types.js";
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
  private sttReadyReject!: (err: Error) => void;

  /** Resolves when the LLM worker signals 'ready'. */
  private llmReady!: Promise<void>;
  private llmReadyResolve!: () => void;
  private llmReadyReject!: (err: Error) => void;

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

    // Transition to Listening as soon as STT worker is ready (Whisper loaded).
    // Fast-path commands ("scroll down", "click", "back", "stop", "undo") only need STT
    // and can execute immediately without waiting for the large LLM to download/compile.
    this.sttReady
      .then(async () => {
        console.log("[AgentCore] STT ready — transitioning to Listening.");
        this.transitionTo(AgentState.Listening);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
      })
      .catch((err: unknown) => {
        console.warn("[AgentCore] STT worker initialization failed, continuing in Listening mode for Web Speech fallback:", err);
        this.transitionTo(AgentState.Listening);
        void sendToSW({
          type: "OFFSCREEN_ERROR",
          source: "agent",
          message: `STT init warning: ${err instanceof Error ? err.message : String(err)}`,
        });
        void sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
      });

    // LLM loads in background for complex multi-step planning
    this.llmReady
      .then(() => {
        console.log("[AgentCore] LLM worker ready for complex planning.");
      })
      .catch((err: unknown) => {
        console.warn("[AgentCore] LLM worker unavailable (fast-path commands still functional):", err);
      });

    console.log("[AgentCore] Workers spawned — model loading in progress.");
  }

  // ─── VAD Callbacks ─────────────────────────────────────────────────────────

  /**
   * Called by VAD when speech starts.
   * Transitions to Transcribing state. Implements barge-in (SRS FR-VOICE-03).
   */
  onSpeechStart(): void {
    if (this.state !== AgentState.Listening && this.state !== AgentState.Idle) return;
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
      // Await STT worker readiness if model is still downloading
      await this.sttReady;

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

      await this.processUtterance(transcript.text);
    } catch (err: unknown) {
      this.handlePipelineError(err);
    }
  }

  /**
   * Execute a natural language text command directly (e.g. from Web Speech API fast-path).
   */
  async executeCommandText(text: string): Promise<void> {
    this.killRequested = false;
    await this.processUtterance(text);
  }

  /**
   * Core pipeline: takes transcribed text, checks safety/kill/undo,
   * performs intent routing / LLM planning, validates plan, and sends to SW.
   */
  private async processUtterance(text: string): Promise<void> {
    try {
      this.transitionTo(AgentState.Routing);

      // ── Step 2: Kill switch check ────────────────────────────────────────
      if (this.intentRouter.isKillCommand(text)) {
        this.handleKill();
        return;
      }

      // ── Step 2b: Undo check ──────────────────────────────────────────────
      if (this.intentRouter.isUndoCommand(text)) {
        await this.undo();
        this.transitionTo(AgentState.Listening);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
        return;
      }

      // ── Step 3: Intent Routing ────────────────────────────────────────────
      const fastPlan = this.intentRouter.route(text);

      let plan: AgentPlan;

      if (fastPlan) {
        console.log("[AgentCore] Fast-path intent matched — skipping LLM.");
        plan = fastPlan;
      } else {
        // ── Step 4: Autonomous Planning ─────────────────────────────────────
        this.transitionTo(AgentState.Planning);
        await sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Planning });

        // Request a fresh page snapshot
        const tabId = await this.getActiveTabId();
        await sendToSW({ type: "REQUEST_SNAPSHOT", tabId });
        await this.waitForSnapshot();

        if (this.killRequested) { this.handleKill(); return; }

        // Plan with Planner (uses Chrome AI -> WebLLM -> Autonomous Semantic Reasoner)
        plan = await this.planner.plan(text, this.currentSnapshot!);
      }

      if (this.killRequested) { this.handleKill(); return; }

      // ── Step 5: Validate & Classify Risk ─────────────────────────────────
      this.validator.validate(plan);
      const risk = this.riskClassifier.classify(plan);
      plan = { ...plan, risk };

      const riskConfig = RISK_TIER_CONFIG[risk];

      // ═══ SAFETY INVARIANT (NFR-REL-01) ═══════════════════════════════════
      // R3/R4 plans MUST ALWAYS require explicit user confirmation.
      const needsConfirm = risk >= RiskTier.R3
        ? true  // ← Hardcoded safety floor.
        : riskConfig.requiresConfirmation;

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
      this.handlePipelineError(err);
    }
  }

  private handlePipelineError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[AgentCore] Pipeline error:", err);

    const _stack = err instanceof Error ? err.stack : undefined;
    void sendToSW({
      type: "OFFSCREEN_ERROR",
      source: "agent",
      message,
      ...(_stack !== undefined ? { stack: _stack } : {}),
    });

    this.transitionTo(AgentState.Error);
    void sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Error });

    // Auto-recover to Listening after 3 seconds
    setTimeout(() => {
      if (this.state === AgentState.Error) {
        this.transitionTo(AgentState.Listening);
        void sendToSW({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
      }
    }, 3_000);
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
   * Undo the last reversible action (FR-SAFE-03).
   * Pops the top entry from the undo stack, computes inverse actions,
   * wraps them in an AgentPlan, and sends them to SW to execute in the tab.
   */
  async undo(): Promise<boolean> {
    const entry = this.undoStack.undo();
    if (!entry) {
      console.warn("[AgentCore] Nothing to undo.");
      await this.tts.speak("Nothing to undo.");
      return false;
    }

    const inverseActions = this.undoStack.buildInverseActions(entry);
    if (inverseActions.length === 0) {
      console.warn("[AgentCore] Action cannot be reversed.");
      await this.tts.speak("That action cannot be automatically undone.");
      return false;
    }

    const undoPlan: AgentPlan = {
      intent: `Undo: ${entry.plan.intent}`,
      risk: RiskTier.R1,
      requiresConfirmation: false,
      actions: [
        ...inverseActions,
        { type: "done", summary: `Undid: ${entry.plan.intent}` },
      ],
    };

    console.log("[AgentCore] Executing undo plan:", undoPlan.intent);
    await sendToSW({
      type: "RELAY_ACTION",
      tabId: entry.tabId,
      plan: undoPlan,
    });

    try {
      await this.tts.speak(`Undid ${entry.plan.intent}`);
    } finally {
      await sendToSW({ type: "TTS_DONE" });
    }

    return true;
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
  private async waitForSnapshot(timeoutMs = 3_000): Promise<void> {
    // If we already have a fresh snapshot, use it immediately.
    if (this.currentSnapshot) return;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.snapshotResolve = null;
        console.warn("[AgentCore] Snapshot wait timed out, continuing with fallback snapshot");
        this.currentSnapshot = {
          url: "",
          title: "Current Webpage",
          elements: [],
          capturedAt: Date.now(),
          truncated: false,
        };
        resolve();
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
    this.sttReady = new Promise<void>((resolve, reject) => {
      this.sttReadyResolve = resolve;
      this.sttReadyReject = reject;
    });
    this.llmReady = new Promise<void>((resolve, reject) => {
      this.llmReadyResolve = resolve;
      this.llmReadyReject = reject;
    });
  }

  /**
   * Explicitly load models for a given profile (e.g. from Onboarding).
   */
  async loadProfile(profile: ModelProfile): Promise<void> {
    const profileConfig = MODEL_PROFILE_CONFIG[profile] ?? MODEL_PROFILE_CONFIG[DEFAULT_MODEL_PROFILE];
    console.log(`[AgentCore] Loading profile "${profile}" (${profileConfig.label})…`);

    if (!this.sttWorker || !this.llmWorker) {
      await this.initialize();
      return;
    }

    this.resetReadinessPromises();
    this.sttWorker.postMessage({ type: "load", modelId: profileConfig.sttModelId });
    this.llmWorker.postMessage({ type: "load", modelId: profileConfig.modelId });

    await Promise.all([this.sttReady, this.llmReady]);
  }

  // ─── Worker Message Handlers ───────────────────────────────────────────────

  /** Handle messages from the STT worker. */
  private handleSTTMessage(event: MessageEvent<STTMessage>): void {
    const msg = event.data;

    switch (msg.type) {
      case "ready":
        console.log("[AgentCore] STT worker ready.");
        this.sttReadyResolve();
        void sendToSW({
          type: "MODEL_LOAD_PROGRESS",
          stt: { loaded: 100, total: 100 },
        } as any);
        break;

      case "result":
        this.sttResolve?.({ text: msg.text, confidence: msg.confidence, language: msg.language });
        break;

      case "error":
        this.sttReadyReject?.(new Error(msg.message));
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
        void sendToSW({
          type: "MODEL_LOAD_PROGRESS",
          progress: 1.0,
          phase: "ready",
          loaded: 100,
          total: 100,
          done: true,
          text: "Models ready!",
          llm: { loaded: 100, total: 100, text: "Models ready!" },
        } as any);
        break;

      case "progress":
        // Forward LLM download progress to panel and onboarding via SW.
        void sendToSW({
          type: "MODEL_LOAD_PROGRESS",
          progress: msg.loaded / 100,
          phase: "downloading",
          loaded: msg.loaded,
          total: msg.total,
          text: msg.text,
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
        if (!msg.requestId) {
          this.llmReadyReject?.(new Error(msg.message));
        }
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
