import { afterEach, expect, it, vi } from "vitest";
import { TTS } from "../src/offscreen/audio/tts.js";
afterEach(() => vi.unstubAllGlobals());
it("never selects a remote voice even if it was saved as preferred", async () => {
  const remote = { voiceURI: "remote", localService: false };
  const local = { voiceURI: "local", localService: true };
  const speak = vi.fn(utterance => { expect(utterance.voice).toBe(local); utterance.onend(); });
  vi.stubGlobal("speechSynthesis", { getVoices: () => [remote, local], speaking: false, pending: false, speak });
  vi.stubGlobal("SpeechSynthesisUtterance", class {});
  await new TTS({ voiceURI: "remote" }).speak("done");
  expect(speak).toHaveBeenCalledOnce();
});
it("uses text-only feedback when no local voice is available", async () => {
  const speak = vi.fn();
  vi.stubGlobal("speechSynthesis", { getVoices: () => [{ localService: false }], speaking: false, pending: false, speak });
  await new TTS().speak("done"); expect(speak).not.toHaveBeenCalled();
});
