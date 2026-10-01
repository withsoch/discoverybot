'use strict';

// AudioWorklet processor for the Soch widget.
//
// Runs on the audio rendering thread. Receives Float32 mono samples at the
// AudioContext sample rate (we pin it to 16 kHz to match Gemini Live input),
// fills a fixed-size buffer (~100 ms / 1600 samples), and posts each filled
// buffer back to the main thread as a transferable ArrayBuffer to avoid the
// copy.
//
// Loaded via:  audioContext.audioWorklet.addModule('/audio-processor.js')
// Constructed: new AudioWorkletNode(ctx, 'soch-pcm-processor', { ... })

class SochPCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetSamples = Math.max(160, opts.targetSamples | 0 || 1600);
    this.buffer = new Float32Array(this.targetSamples);
    this.bufferIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    const target = this.targetSamples;
    let buffer = this.buffer;
    let bi = this.bufferIndex;

    for (let i = 0; i < channel.length; i++) {
      buffer[bi++] = channel[i];
      if (bi >= target) {
        // Transfer ownership of the underlying ArrayBuffer to the main
        // thread. After transfer, the buffer is detached, so we allocate a
        // fresh one for the next chunk.
        this.port.postMessage(buffer, [buffer.buffer]);
        buffer = new Float32Array(target);
        bi = 0;
      }
    }
    this.buffer = buffer;
    this.bufferIndex = bi;
    return true;
  }
}

registerProcessor('soch-pcm-processor', SochPCMProcessor);
