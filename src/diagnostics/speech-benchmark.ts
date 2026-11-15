/** Real browser/WASM benchmark. Audio and transcript stay local; exports contain timing only. */
export async function benchmarkSpeech(file: File, reportProgress: (text: string) => void, repeats = 10) {
  if (file.size > 10_000_000) throw new Error("Choose a short audio file smaller than 10 MB.");
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("Choose 1–20 repetitions.");
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try { decoded = await context.decodeAudioData(await file.arrayBuffer()); }
  finally { await context.close(); }
  if (decoded.duration < 0.3 || decoded.duration > 30) throw new Error("Choose an utterance between 0.3 and 30 seconds.");
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16_000), 16_000);
  const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
  const audio = (await offline.startRendering()).getChannelData(0);
  const worker = new Worker(new URL("../offscreen/stt/stt-worker.ts", import.meta.url), { type: "module" });
  const durations: number[] = [];
  const request = (message: unknown, expected: string, timeout: number): Promise<void> => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.removeEventListener("message", receive); worker.removeEventListener("error", crash); };
    const crash = (event: ErrorEvent) => { cleanup(); reject(new Error(event.message)); };
    const receive = (event: MessageEvent<{ type: string; message?: string }>) => {
      if (event.data.type === expected) { cleanup(); resolve(); }
      else if (event.data.type === "error") { cleanup(); reject(new Error(event.data.message ?? "Speech benchmark failed")); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Speech benchmark timed out")); }, timeout);
    worker.addEventListener("message", receive); worker.addEventListener("error", crash);
    worker.postMessage(message);
  });
  try {
    reportProgress("Opening speech model (cached or downloaded)…");
    const start = performance.now();
    await request({ type: "load", modelId: "onnx-community/whisper-tiny" }, "ready", 300_000);
    const initializationMs = performance.now() - start;
    for (let i = 0; i < repeats; i++) {
      reportProgress(`Measuring speech recognition ${i + 1}/${repeats}…`);
      const start = performance.now();
      await request({ type: "transcribe", audio: audio.slice() }, "result", 60_000);
      durations.push(performance.now() - start);
    }
    const warm = durations.slice(1).sort((a, b) => a - b);
    const percentile = (p: number) => warm.length ? warm[Math.ceil(warm.length * p) - 1] : null;
    return { schemaVersion: 1, engine: "Whisper tiny q8 WASM", cacheState: "not controlled", runtime: navigator.userAgent,
      durationSeconds: decoded.duration, sampleRate: 16_000, initializationMs, firstInferenceMs: durations[0],
      warmCount: warm.length, warmP50Ms: percentile(0.5), warmP95Ms: percentile(0.95), inferenceMs: durations,
      note: "Recognition-only timings. Excludes endpointing and browser actions; sample count is insufficient for a production SLO." };
  } finally { worker.terminate(); }
}
