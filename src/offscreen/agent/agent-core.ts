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
 * 1. Receives speech audio from VAD callbacks
 * 2. Sends audio to the STT worker and receives a transcript
 * 3. Routes to IntentRouter (fast-path) or Planner (LLM)
 * 4. Validates the resulting AgentPlan
 * 5. Requests confirmation for high-risk plans
 * 6. Dispatches the plan to the content script via SW
 * 7. Speaks the result via TTS
 */

import { AgentState, RiskTier } from "@shared/types.js";
import type { AgentPlan, PageSnapshot } from "@shared/types.js";
import { RISK_TIER_CONFIG, LLM_TIMEOUT_MS, STT_TIMEOUT_MS, DEFAULT_MODEL_PROFILE, MODEL_PROFILE_CONFIG } from "@shared/constants.js";
import { TTS } from "../audio/tts.js";
import { IntentRouter } from "./intent-router.js";
import { Planner } from "./planner.js";
import { PlanValidator } from "./plan-validator.js";
import { RiskClassifier } from "./risk-classifier.js";
import { UndoStack } from "./undo-stack.js";
import { sendToSW } from "../offscreen.js";

/** Configuration for AgentCore. */
export interface AgentCoreConfig {
  tts: TTS;
}

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

  /** STT Web Worker. */
  private sttWorker: Worker | null = null;

  /** LLM Web Worker. */
  private llmWorker: Worker | null = null;

  /** Most recently captured page snapshot for LLM context. */
  private currentSnapshot: PageSnapshot | null = null;

  /** Pending resolve for the STT transcription promise. */
  private sttResolve: ((result: { text: string; confidence: number; language: string }) => void) | null = null;
  private sttReject: ((err: Error) => void) | null = null;

  /** Pending resolve for the LLM plan promise. */
  private llmResolve: ((plan: AgentPlan) => void) | null = null;
  private llmReject: ((err: Error) => void) | null = null;

  /** Pending resolve for user answer (ask action). */
  private answerResolve: ((answer: string) => void) | null = null;

  constructor(config: AgentCoreConfig) {
    this.tts = config.tts;
    this.intentRouter = new IntentRouter();
    this.planner = new Planner();
    this.validator = new PlanValidator();
    this.riskClassifier = new RiskClassifier();
    this.undoStack = new UndoStack();
  }

  /**
   * Initialize the agent: load STT and LLM workers.
   * Called once when the offscreen document starts.
   */
  async initialize(): Promise<void> {
    console.log("[AgentCore] Initializing workers...");

    // Spawn STT worker
    this.sttWorker = new Worker(
      new URL("../stt/stt-worker.ts", import.meta.url),
      { type: "module" }
    );
    this.sttWorker.onmessage = this.handleSTTMessage.bind(this);
    this.sttWorker.onerror = (err) => {
      console.error("[AgentCore] STT worker error:", err);
      this.sttReject?.(new Error(`STT worker crashed: ${err.message}`));
    };

    // Spawn LLM worker
    this.llmWorker = new Worker(
      new URL("../llm/llm-worker.ts", import.meta.url),
      { type: "module" }
    );
    this.llmWorker.onmessage = this.handleLLMMessage.bind(this);
    this.llmWorker.onerror = (err) => {
      console.error("[AgentCore] LLM worker error:", err);
      this.llmReject?.(new Error(`LLM worker crashed: ${err.message}`));
    };

    // Load models
    const modelProfile = DEFAULT_MODEL_PROFILE;
    const modelConfig = MODEL_PROFILE_CONFIG[modelProfile];

    this.sttWorker.postMessage({ type: "load", modelId: "onnx-community/whisper-tiny" });
    this.llmWorker.postMessage({ type: "load", modelId: modelConfig.modelId });

    // TODO: await both workers' 'ready' messages before resolving
    console.log("[AgentCore] Workers spawned — model loading in progress.");
  }

  /**
   * Called by VAD when speech starts.
   * Transitions to Transcribing state and notifies SW.
   */
  onSpeechStart(): void {
    if (this.state !== AgentState.Listening) return;
    this.transitionTo(AgentState.Transcribing);
    // Interrupt TTS if speaking (barge-in)
    if (this.tts.isSpeaking) {
      this.tts.stop();
    }
  }

  /**
   * Called by VAD when speech ends with the full utterance audio.
   * Sends audio to STT worker and handles the result pipeline.
   */
  async onSpeechEnd(audio: Float32Array): Promise<void> {
    if (this.state !== AgentState.Transcribing) return;

    try {
      // ── Step 1: Transcribe ─────────────────────────────────────────────
      const transcript = await this.transcribe(audio);
      console.log(`[AgentCore] Transcript: "${transcript.text}" (confidence: ${transcript.confidence.toFixed(2)})`);

      await sendToSW({
        type: "TRANSCRIPT",
        text: transcript.text,
        confidence: transcript.confidence,
        language: transcript.language,
        isFinal: true,
      });

      this.transitionTo(AgentState.Routing);

      // ── Step 2: Intent Routing ─────────────────────────────────────────
      const fastPlan = this.intentRouter.route(transcript.text);

      let plan: AgentPlan;

      if (fastPlan) {
        // Fast path matched — skip LLM
        console.log("[AgentCore] Fast-path intent matched.");
        plan = fastPlan;
      } else {
        // ── Step 3: LLM Planning ─────────────────────────────────────────
        this.transitionTo(AgentState.Planning);

        // Request a fresh page snapshot
        const tabId = await this.getActiveTabId();
        await sendToSW({ type: "REQUEST_SNAPSHOT", tabId });

        // Wait for snapshot to arrive (via onPageSnapshot callback)
        await this.waitForSnapshot();

        plan = await this.planner.plan(transcript.text, this.currentSnapshot!);
      }

      // ── Step 4: Validate & Classify Risk ────────────────────────────────
      this.validator.validate(plan);
      const risk = this.riskClassifier.classify(plan);
      plan = { ...plan, risk };

      const riskConfig = RISK_TIER_CONFIG[risk];
      const needsConfirm = riskConfig.requiresConfirmation;
      plan = { ...plan, requiresConfirmation: needsConfirm };

      // Notify SW — it will handle confirmation UI and execution relay
      await sendToSW({ type: "PLAN_PRODUCED", plan });

      if (needsConfirm) {
        this.transitionTo(AgentState.Confirming);
      } else {
        this.transitionTo(AgentState.Executing);
      }

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[AgentCore] Pipeline error:", err);

      await sendToSW({
        type: "OFFSCREEN_ERROR",
        source: "agent",
        message,
        stack: err instanceof Error ? err.stack : undefined,
      });

      this.transitionTo(AgentState.Error);
    }
  }

  /**
   * Execute a confirmed/auto-approved plan.
   * Called by offscreen.ts when SW relays EXECUTE_PLAN.
   */
  async executePlan(plan: AgentPlan, _tabId: number): Promise<void> {
    // TODO: Dispatch each action to the content script via SW
    // For now, just log and transition back to listening
    console.log("[AgentCore] Executing plan:", plan.intent);
    this.transitionTo(AgentState.Executing);

    // Push to undo stack if reversible
    if (plan.risk <= RiskTier.R2) {
      this.undoStack.push({ plan, tabId: _tabId, timestamp: Date.now() });
    }

    // Speak confirmation
    this.transitionTo(AgentState.Speaking);
    try {
      await this.tts.speak(plan.actions.find(a => a.type === "done")
        ? (plan.actions.find(a => a.type === "done") as { summary: string }).summary
        : plan.intent
      );
    } finally {
      await sendToSW({ type: "TTS_DONE" });
      this.transitionTo(AgentState.Listening);
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

  /** Pending resolve for waitForSnapshot(). */
  private snapshotResolve: (() => void) | null = null;

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

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /** Update the agent state and log the transition. */
  private transitionTo(next: AgentState): void {
    console.log(`[AgentCore] ${this.state} → ${next}`);
    this.state = next;
  }

  /**
   * Send audio to the STT worker and await the transcript.
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
        resolve(result);
      };
      this.sttReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      this.sttWorker!.postMessage({ type: "transcribe", audio }, [audio.buffer]);
    });
  }

  /**
   * Wait for the current page snapshot to be delivered via onPageSnapshot().
   */
  private async waitForSnapshot(timeoutMs = 5_000): Promise<void> {
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
   * Get the current active tab ID from session state.
   * TODO: Read from chrome.storage.session via a SW request.
   */
  private async getActiveTabId(): Promise<number> {
    // Stub — the SW will handle routing to the correct tab
    return 0;
  }

  /** Handle messages from the STT worker. */
  private handleSTTMessage(event: MessageEvent): void {
    const msg = event.data as { type: string; text?: string; confidence?: number; language?: string; message?: string };

    switch (msg.type) {
      case "ready":
        console.log("[AgentCore] STT worker ready.");
        break;
      case "result":
        this.sttResolve?.({
          text: msg.text ?? "",
          confidence: msg.confidence ?? 0,
          language: msg.language ?? "en",
        });
        this.sttResolve = null;
        this.sttReject = null;
        break;
      case "error":
        this.sttReject?.(new Error(msg.message ?? "STT error"));
        this.sttResolve = null;
        this.sttReject = null;
        break;
      case "progress":
        // TODO: Forward progress to panel via SW
        break;
    }
  }

  /** Handle messages from the LLM worker. */
  private handleLLMMessage(event: MessageEvent): void {
    const msg = event.data as { type: string; plan?: AgentPlan; message?: string };

    switch (msg.type) {
      case "ready":
        console.log("[AgentCore] LLM worker ready.");
        break;
      case "result":
        if (msg.plan) {
          this.llmResolve?.(msg.plan);
        } else {
          this.llmReject?.(new Error("LLM returned no plan"));
        }
        this.llmResolve = null;
        this.llmReject = null;
        break;
      case "error":
        this.llmReject?.(new Error(msg.message ?? "LLM error"));
        this.llmResolve = null;
        this.llmReject = null;
        break;
      case "token":
        // TODO: stream tokens to panel for live display
        break;
    }
  }

  /** Current agent state (read-only). */
  get currentState(): AgentState {
    return this.state;
  }
}
