/**
 * @file public/audio-processor.js
 * @description AudioWorkletProcessor for VoxPilot microphone capture.
 *
 * Runs in a dedicated AudioWorkletGlobalScope (off the main thread).
 * Receives 128-frame stereo/mono buffers from the Web Audio graph and
 * forwards Float32Array chunks to the offscreen document via MessagePort.
 *
 * Loaded with:
 *   await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'))
 *
 * NOTE: This file is plain JS (not TypeScript) because AudioWorklet modules
 * run in a special global scope where the TypeScript compiler and bundler
 * cannot inject imports. It must remain a self-contained script.
 */

class VoxPilotAudioProcessor extends AudioWorkletProcessor {
  /**
   * Accumulation buffer — collects 128-frame blocks until we reach
   * the requested duration at the native device sample rate (32 ms by default).
   */
  constructor(options) {
    super();
    const frameMs = Math.min(64, Math.max(16, options?.processorOptions?.frameMs ?? 32));
    this._TARGET_FRAMES = Math.round(sampleRate * frameMs / 1000);
    this._buffer = new Float32Array(this._TARGET_FRAMES);
    this._filled = 0;
  }

  /**
   * Called by the audio engine for every 128-frame render quantum.
   * @param {Float32Array[][]} inputs  [[channel0, channel1, ...], ...]
   * @returns {boolean} true — keep the processor alive
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true; // silence / no input — keep alive
    }

    const channel = input[0]; // mono (channel 0)
    let srcOffset = 0;

    while (srcOffset < channel.length) {
      const space = this._TARGET_FRAMES - this._filled;
      const toCopy = Math.min(space, channel.length - srcOffset);

      this._buffer.set(channel.subarray(srcOffset, srcOffset + toCopy), this._filled);
      this._filled += toCopy;
      srcOffset += toCopy;

      if (this._filled === this._TARGET_FRAMES) {
        // Transfer ownership and allocate the next packet.
        this.port.postMessage(this._buffer, [this._buffer.buffer]);
        this._buffer = new Float32Array(this._TARGET_FRAMES);
        this._filled = 0;
      }
    }

    return true;
  }
}

registerProcessor("voxpilot-audio-processor", VoxPilotAudioProcessor);

