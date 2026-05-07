// AudioWorklet processor: receives Float32 mono samples at the AudioContext's
// sample rate (16000Hz when used by the streamer) and posts batched chunks
// back to the main thread for base64-encoding and transmission to Gemini Live.
//
// Loaded via: audioContext.audioWorklet.addModule('/audio-processor.js')

class SochPCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    // Send roughly every 100ms — at 16kHz that's 1600 samples per chunk.
    this.targetSamples = opts.targetSamples || 1600;
    this.buffer = new Float32Array(this.targetSamples);
    this.bufferIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.bufferIndex++] = channel[i];
      if (this.bufferIndex >= this.targetSamples) {
        // Copy so the main thread owns its own buffer.
        const out = new Float32Array(this.buffer);
        this.port.postMessage(out, [out.buffer]);
        this.buffer = new Float32Array(this.targetSamples);
        this.bufferIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('soch-pcm-processor', SochPCMProcessor);
