# Release readiness

For the subsequent CPU-first implementation, current feature limits, and remaining roadmap work, see [implementation status](IMPLEMENTATION_STATUS.md).

The automated checks cover request handling, worker recovery, model reuse, progress races, plan execution, and packaging. The compact popup was rendered in isolated Chrome at its shipped 340px width in paused, listening, confirmation, and error states with mocked runtime messages. A passing build does not verify real WebGPU inference or qualify this extension for a production release.

## Runtime changes

- The toolbar icon opens a 340px popup. It owns no microphone or inference workers; closing it leaves listening running. Pause or Alt+V releases the microphone and keeps loaded models resident for reuse. The toolbar ON badge shows background listening. Restarting Chrome or reloading the extension requires reopening cached models, which is shown as loading rather than a new download.
- Setup and listening reuse one offscreen AgentCore. Essential setup initializes CPU speech only; optional planners initialize on demand. The offscreen document uses USER_MEDIA and WORKERS reasons; it no longer gets closed on ordinary pause or inherits AUDIO_PLAYBACK's 30-second idle lifetime. Runtime messages explicitly target SW, offscreen, or UI, so popup state requests have a single responder.
- Setup subscribes before model preparation begins and restores the latest profile-specific status when reopened. Worker file progress is aggregated monotonically; 100% means the requested features are ready; Essential does not require a planner. Missing Content-Length does not invent a byte count. Cached initialization uses an indeterminate loading indicator.
- The offscreen Whisper worker is the only recognizer. Panel WebSpeech and its missing-language-pack loop have been removed. STT requests are single-flight; bounded barge-in speech can cancel a busy command without starting another one.
- Planner requests use a smaller prompt and grammar, a 60-second first-token deadline, a 20-second token-inactivity deadline, and a 120-second overall limit. An actively producing stream is not stopped at the old fixed 30-second boundary.
- Fast commands are grounded against a fresh page snapshot. Approved actions execute once in order in the original tab. Page-action failures are not retried by guessing a target or automatically submitting forms. Concurrent confirmations claim a plan atomically; pause/stop cancels remaining actions. Browser navigation uses an exact internal command allowlist.

- WebLLM receives a serialized AgentPlan schema. The installed runtime sends this directly to its native grammar compiler; a missing schema produces the reported non-string error.
- Engine loading and generation cannot overlap. Native failures invalidate and unload the engine before reuse. Cancellation calls `interruptGenerate`; a worker that does not acknowledge cancellation within two seconds is terminated and reloaded.
- Planner GPU context is capped at 4,096 tokens. Prefill batch size comes from the compiled model library; the previous `prefill_chunk_size: 128` override was ignored by WebLLM and has been removed. Prompt element descriptions have a separate character budget. Tokenization varies by content; an oversized request must fail safely rather than execute a partial plan.
- Whisper uses q8 WASM instead of sharing the GPU with WebLLM. Utterances are limited to 30 seconds and decoder output to 128 tokens. The 60-second transcription deadline recreates the worker; messages from the old worker cannot resolve a new request.
- Unknown handles, malformed actions, and empty plans fail validation. Local risk classification can escalate model risk, using the real snapshot label for model-generated clicks. Form values are omitted from planner prompts.
- Snapshot collection stops inspecting candidates when its time budget or element limit is reached. Handles use a WeakMap for constant-time registration. This reduces work but cannot guarantee a hard deadline for browser layout or DOM selector evaluation.

## Checks

Run `npm ci`, then `npm run check`. This runs TypeScript, ESLint, unit/regression tests, and the production build. Production output is in `dist/`, without source maps. CI runs tests, treats lint errors as failures, and blocks high/critical dependency advisories. Existing explicit `any` integration boundaries remain lint warnings and need further typing work.

Run `npm audit --omit=dev` with network access. The package override for Transformers.js's Node-side `sharp` dependency addresses the audited native image-processing advisories without migrating the inference library to a new major version. The browser speech path does not use sharp; verify Node-side image features separately before adding them. Vite was updated to the compatible patched 6.4 release. The final full audit reports six moderate advisories in the existing TypeScript ESLint/minimatch toolchain; the production dependency audit reports zero advisories.

## GPU device loss

Errors such as `mapAsync … [Device] is lost` invalidate the entire LLM worker immediately. The app no longer waits for dead-device `unload()` before reporting failure, and it stops advertising the failed planner as ready. One fresh-worker recovery loads `SmolLM2-360M-Instruct-q4f16_1-MLC`, which is present in the installed WebLLM model catalogue. The selected profile remains unchanged; the ready status explicitly says the compact planner is active. This model can require a one-time download and may produce less capable plans; schema/handle/risk validation remains enforced.

A failed command is not automatically replayed using an old page snapshot. Wait for **Models ready — compact planner active**, then repeat it. A second GPU loss or a five-minute recovery-load timeout stops complex planning while keeping Whisper and basic commands available. Mic pause/resume does not reset that limit. An explicit model setup retry or profile change can reopen planning after GPU resources have been freed or Chrome has restarted. Recovery timers and callbacks are disposed with the agent.

This handles browser/driver failure; it cannot guarantee that a device will not be lost again. GPU inference still needs real hardware testing. The installed [WebLLM engine source](https://github.com/mlc-ai/web-llm/blob/main/src/engine.ts) also recommends recreating the engine with a less resource-intensive model after device loss.

## Required Chrome smoke tests

1. Load unpacked `dist/` and wait for model readiness. Test both a fresh download and cached startup with the Fast profile.
2. Issue a simple scroll command and a complex page-summary command. Confirm real model JSON parses and only one plan executes per utterance.
3. During planning, say stop. Confirm no late plan executes, then issue another command. Repeat with a forced worker crash/device loss and verify recovery.
4. Force the STT and planner deadlines. Confirm the UI recovers, stale results are ignored, and the next command works after reloading.
5. Switch profiles during model download and inference. Confirm previous workers terminate and only current-model progress/results affect the session.
6. Test long speech, continuous background noise, silence, short clicks, denied microphone access, offline cached startup, and closing/reopening the popup.
7. On a large page, inspect snapshot duration, truncation, handle grounding, and main-thread responsiveness. Measure cold/warm inference latency and GPU memory on supported Windows/macOS/Linux hardware; no new latency guarantee has been measured here.
8. Verify high-risk actions require confirmation and cancellation prevents execution. Exercise forms, navigation, tabs, and multi-frame pages in a disposable browser profile.

## Remaining release work

- TTS uses local browser SpeechSynthesis voices; Kokoro/Piper is not implemented. Silero VAD is bundled and runs in a CPU/WASM worker, with a conservative energy fallback. Digital-silence browser execution has been smoke tested; microphone accuracy and representative noisy environments still need evaluation.
- Runtime and page execution are covered by mocked Chrome API regression tests. Complete real Chrome integration coverage for forms, multi-frame pages, browser lifecycle recovery, and permission prompts before release. Page commands currently target the top frame so handles cannot be confused across frames.
- Complete accessibility, permissions/privacy, and Chrome Web Store review. Automated unit tests do not establish those properties.

## Log interpretation

ONNX execution-provider placement and absent Content-Length messages are informational unless accompanied by failed inference or measured regressions. Shape operations may intentionally run on CPU, as the warning itself explains. Browser SpeechRecognition and its `language-not-supported` loop have been removed. Small snapshot deadline overruns no longer flood warning logs; collection reserves time for text extraction and reports materially slow builds. Metal device-loss reports require recovery and hardware testing; they cannot be ruled out by a successful JavaScript build.
