// AudioStreamer — captures the microphone, downmixes/resamples to 16kHz mono
// PCM16, and forwards base64 chunks to a callback (~100ms cadence).
//
// Strategy: try AudioWorklet (preferred), fall back to ScriptProcessorNode for
// older browsers. Both paths emit Float32 frames that we convert to Int16 and
// base64-encode.

(function (global) {
  'use strict';

  function floatTo16BitPCMBase64(float32) {
    const len = float32.length;
    const buf = new ArrayBuffer(len * 2);
    const view = new DataView(buf);
    for (let i = 0; i < len; i++) {
      let s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    // Convert to base64 in chunks to avoid call-stack issues with large buffers.
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + chunkSize)
      );
    }
    return btoa(binary);
  }

  class AudioStreamer {
    constructor({ onChunk, onLevel, workletUrl } = {}) {
      this.onChunk = onChunk || (() => {});
      this.onLevel = onLevel || (() => {});
      this.workletUrl = workletUrl || '/audio-processor.js';

      this.stream = null;
      this.audioContext = null;
      this.source = null;
      this.workletNode = null;
      this.scriptNode = null;
      this.muted = false;
      this.running = false;
    }

    async start() {
      if (this.running) return;

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Many browsers ignore the requested sampleRate on getUserMedia. We pin
      // the AudioContext to 16kHz so the captured samples land at Gemini's
      // expected input rate without manual resampling.
      const Ctx = window.AudioContext || window.webkitAudioContext;
      try {
        this.audioContext = new Ctx({ sampleRate: 16000 });
      } catch (_) {
        this.audioContext = new Ctx();
      }
      this.source = this.audioContext.createMediaStreamSource(this.stream);

      const useWorklet = !!this.audioContext.audioWorklet;
      if (useWorklet) {
        try {
          await this.audioContext.audioWorklet.addModule(this.workletUrl);
          this.workletNode = new AudioWorkletNode(
            this.audioContext,
            'soch-pcm-processor',
            { processorOptions: { targetSamples: 1600 } }
          );
          this.workletNode.port.onmessage = (e) => this._handleFloat32(e.data);
          this.source.connect(this.workletNode);
          // Worklet must be connected to the graph to actually pull audio.
          // Use a zero-gain destination to avoid local playback echo.
          const sink = this.audioContext.createGain();
          sink.gain.value = 0;
          this.workletNode.connect(sink).connect(this.audioContext.destination);
        } catch (err) {
          console.warn('[soch-voice-bot] AudioWorklet failed, falling back', err);
          this._initScriptProcessor();
        }
      } else {
        this._initScriptProcessor();
      }

      this.running = true;
    }

    _initScriptProcessor() {
      // Fallback path. Buffer size 4096 at 16kHz = ~256ms; we re-chunk to ~100ms.
      const node = this.audioContext.createScriptProcessor(4096, 1, 1);
      let pending = new Float32Array(0);
      const target = 1600;
      node.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const merged = new Float32Array(pending.length + input.length);
        merged.set(pending);
        merged.set(input, pending.length);
        let offset = 0;
        while (merged.length - offset >= target) {
          this._handleFloat32(merged.slice(offset, offset + target));
          offset += target;
        }
        pending = merged.slice(offset);
      };
      this.scriptNode = node;
      this.source.connect(node);
      const sink = this.audioContext.createGain();
      sink.gain.value = 0;
      node.connect(sink).connect(this.audioContext.destination);
    }

    _handleFloat32(float32) {
      if (this.muted) return;
      // RMS level for the visualization.
      let sum = 0;
      for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
      const rms = Math.sqrt(sum / float32.length);
      this.onLevel(rms);

      const b64 = floatTo16BitPCMBase64(float32);
      this.onChunk(b64);
    }

    setMuted(muted) {
      this.muted = !!muted;
      if (this.stream) {
        this.stream.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
      }
    }

    async stop() {
      this.running = false;
      try { if (this.workletNode) this.workletNode.disconnect(); } catch (_) {}
      try { if (this.scriptNode) this.scriptNode.disconnect(); } catch (_) {}
      try { if (this.source) this.source.disconnect(); } catch (_) {}
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.audioContext) {
        try { await this.audioContext.close(); } catch (_) {}
      }
      this.workletNode = null;
      this.scriptNode = null;
      this.source = null;
      this.stream = null;
      this.audioContext = null;
    }
  }

  global.SochAudioStreamer = AudioStreamer;
})(window);
