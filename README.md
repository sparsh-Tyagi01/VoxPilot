# VoxPilot 🎙️

> **Autonomous on-device voice AI agent for Chrome** — control any web page by voice, with all speech recognition, reasoning, and speech synthesis running entirely on your device.

[![CI](https://github.com/sparsh/voxpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/sparsh/voxpilot/actions)
![MV3](https://img.shields.io/badge/Manifest-V3-blue)
![Privacy](https://img.shields.io/badge/data-100%25%20on--device-green)
![License](https://img.shields.io/badge/license-MIT-purple)

---

For the performance redesign, hardware strategy, target architecture, and prioritized engineering backlog, read the [architecture and optimization roadmap](docs/ARCHITECTURE_AND_OPTIMIZATION_ROADMAP.md).

Implementation progress, benchmark instructions, and unfinished roadmap items are tracked in [implementation status](docs/IMPLEMENTATION_STATUS.md).

## Popup and background listening

Click the toolbar icon to open the compact popup. Start listening, then close the popup to keep using voice control; Pause or **Alt+V** turns the microphone off. Models loaded during setup stay available across mic pauses. Loading saved models is shown separately from downloading files.

See [release readiness and troubleshooting](docs/RELEASE_READINESS.md) for verification commands, Chrome smoke tests, and remaining release gaps. Run `npm run check` to validate source and create `dist/`. After rebuilding, reload the extension at `chrome://extensions` and refresh target webpages. Silero VAD runs locally in a CPU/WASM worker; speech output uses local browser SpeechSynthesis voices. Kokoro/Piper TTS remains planned. Silence and unrecognized voice input do not speak the direct-command tutorial.

The proposed [site-aware agent architecture](docs/SITE_AWARE_AGENT_ARCHITECTURE.md) describes open-ended requests, capability discovery, per-site guardrails, verified actions, implementation phases, and the tradeoffs behind those decisions.

The initial [site-aware task runner](docs/SITE_AGENT_IMPLEMENTATION.md) is available with Assist and larger AI profiles. It observes the current page, asks for missing information, checks each action and inspects the result. Essential remains the lightweight basic-control mode. Run `npm run test:browser` for the controlled Chrome task and popup smoke tests.

## What is VoxPilot?

VoxPilot is a Manifest V3 Chrome extension that lets you operate web pages entirely by voice — filling forms, clicking buttons, scrolling, navigating, and running multi-step workflows — without any data ever leaving your device.

**Zero cloud. Zero accounts. Zero telemetry.**

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Service Worker (sw.ts)  — stateless orchestrator        │
│  Hotkey routing · Offscreen lifecycle · Message relay    │
└──────────────────┬──────────────────────────────────────┘
                   │ chrome.runtime (only path between zones)
       ┌───────────┴───────────┐
       │  Offscreen Document   │  reasons: USER_MEDIA, AUDIO_PLAYBACK, WORKERS
       │  ┌─────────────────┐  │
       │  │ AudioCapture    │  │  getUserMedia + echo cancellation
       │  │ VAD             │  │  Silero VAD (ONNX)
       │  │ STT Worker      │  │  Whisper tiny/base (ONNX Runtime Web)
       │  │ LLM Worker      │  │  Llama 3.2 1B via WebLLM (WebGPU)
       │  │ TTS             │  │  Kokoro / Piper on-device
       │  │ AgentCore       │  │  State machine · intent router · plan validator
       │  └─────────────────┘  │
       └───────────────────────┘
                   │ via SW relay
       ┌───────────┴───────────┐
       │  Content Scripts      │  per frame, per tab
       │  SnapshotBuilder      │  DOM → compact JSON (≤50ms for 5k nodes)
       │  ActionExecutor       │  click/type/scroll/navigate/tab
       │  OverlayManager       │  closed shadow root (page-isolated)
       │    ├── Badges         │  SOM numbered badges (#2563eb)
       │    └── Confirmation   │  R3/R4 confirm dialog (focus-trapped)
       └───────────────────────┘

Extension Pages:
  src/panel/panel.html       — Compact toolbar popup (mic, transcript, confirmation)
  src/onboarding/            — Permission grant, model download, vault setup
  src/settings/              — Voice, model, vault, privacy dashboard
```

---

## Features

| Feature | Detail |
|---------|--------|
| 🎙️ **Voice control** | Wake on Alt+V or push-to-talk; VAD endpoint detection |
| 🔒 **100% on-device** | Whisper STT · Llama 3.2 1B · Kokoro TTS — no cloud |
| ⚡ **Fast path** | Regex-based command router for <1.5s p50 latency |
| 🧠 **LLM planner** | Constrained JSON output via WebLLM + schema validation |
| 🛡️ **Safety tiers** | R0–R4 risk classification; R3/R4 require explicit confirmation |
| 🔐 **Encrypted vault** | AES-GCM-256 + PBKDF2 (600k iterations); auto-lock 5 min |
| ♿ **Accessibility** | WCAG 2.2 AA; screen reader support; keyboard navigation |
| 🏗️ **Framework-aware** | React/Vue/Angular synthetic event strategy ladder |
| 🔏 **Prompt injection** | Page content sandboxed; LLM never trusts page text as instructions |

---

## Voice Commands

| Say | Action |
|-----|--------|
| `"scroll down"` | Scroll the page |
| `"click Sign In"` | Click a button by label |
| `"type hello@example.com in the email field"` | Fill a form field |
| `"fill the form"` | Auto-fill from encrypted vault |
| `"open new tab"` | Tab management |
| `"go back"` | Browser navigation |
| `"read the page"` | Speak page content via TTS |
| `"undo"` | Revert last action |
| `"stop"` | Cancel immediately (all states) |
| `"remember this as 'weekly report'"` | Save a voice macro |

---

## Model Profiles

| Mode | Planner | Speech | Loading policy |
|---|---|---|---|
| **Essential (default)** | None | Whisper tiny, CPU/WASM | Speech only; no GPU needed |
| **Assist** | Optional Llama 3.2 1B | Whisper tiny | Planner loads on the first complex request |
| **Advanced** | Optional Llama 3.2 3B | Whisper base | Planner loads on demand |
| **Expert** | Optional Llama 3.1 8B | Whisper base | Explicit choice for capable GPUs |

Idle planners release GPU resources after two minutes. Old stored profile names remain supported. Downloaded weights and initialized inference engines have different lifetimes. Real latency and hardware requirements must be measured; see [implementation status](docs/IMPLEMENTATION_STATUS.md).

---

## Development Setup

```bash
# Prerequisites: Node.js 20.9+, Chrome with WebGPU enabled

git clone https://github.com/sparsh/voxpilot
cd voxpilot

npm install

# Generate extension icons
node scripts/generate-icons.mjs

# Development build (watch mode)
npm run dev

# Production build
npm run build
```

### Loading in Chrome

1. Navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `dist/` folder
4. Click the VoxPilot icon or press **Alt+V** on any page

---

## Project Structure

```
src/
├── sw/              Service worker (stateless orchestrator)
├── offscreen/
│   ├── audio/       Mic capture, VAD, TTS
│   ├── stt/         Whisper STT web worker
│   ├── llm/         WebLLM web worker
│   └── agent/       State machine, intent router, planner, risk classifier
├── content/         DOM snapshot, action executor, shadow overlay
├── panel/           Side panel UI
├── onboarding/      Setup wizard
├── settings/        Settings + privacy dashboard
├── vault/           AES-GCM-256 encrypted profile store
└── shared/          Types, messages, schema, constants
```

---

## Security & Privacy

- **Prompt injection defence**: Page content is wrapped in `<page_data>` tags and the system prompt explicitly forbids the LLM from following instructions found there.
- **No network calls from content scripts**: IR-COM-02. Only the offscreen document makes the one-time model download.
- **Vault isolation**: Vault values are resolved by the vault service and injected directly into DOM fields — the LLM only references field *names*, never values.
- **Closed shadow root**: All overlay UI is inaccessible to page scripts.
- **Risk tiers**: R3/R4 actions (form submission, payments) always require explicit user confirmation before execution.

---

## Licence

Code: MIT © 2026 Sparsh  
Bundled models: [Llama 3.2 Community Licence](https://llama.meta.com/llama3_2/), [Whisper MIT](https://github.com/openai/whisper)

