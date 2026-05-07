// AudioPlayer — receives base64-encoded PCM16 chunks from Gemini Live
// (24kHz mono) and plays them gaplessly via AudioContext. Tracks playback
// state so the widget can light up the AI-speaking visualization.

(function (global) {
  'use strict';

  function base64ToInt16(b64) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    // Little-endian PCM16.
    return new Int16Array(bytes.buffer, bytes.byteOffset, len / 2);
  }

  function int16ToFloat32(int16) {
    const out = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      out[i] = int16[i] / 32768;
    }
    return out;
  }

  class AudioPlayer {
    constructor({ sampleRate = 24000, onStateChange } = {}) {
      this.sampleRate = sampleRate;
      this.onStateChange = onStateChange || (() => {});
      this.audioContext = null;
      this.nextStartTime = 0;
      this.activeSources = new Set();
      this.isPlaying = false;
    }

    async init() {
      if (this.audioContext) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new Ctx({ sampleRate: this.sampleRate });
      if (this.audioContext.state === 'suspended') {
        try { await this.audioContext.resume(); } catch (_) {}
      }
    }

    async enqueue(base64) {
      await this.init();
      const ctx = this.audioContext;
      const int16 = base64ToInt16(base64);
      if (int16.length === 0) return;
      const float32 = int16ToFloat32(int16);

      const buffer = ctx.createBuffer(1, float32.length, this.sampleRate);
      buffer.copyToChannel(float32, 0);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      const now = ctx.currentTime;
      const startAt = Math.max(now, this.nextStartTime);
      src.start(startAt);
      this.nextStartTime = startAt + buffer.duration;

      this.activeSources.add(src);
      if (!this.isPlaying) {
        this.isPlaying = true;
        this.onStateChange(true);
      }
      src.onended = () => {
        this.activeSources.delete(src);
        if (this.activeSources.size === 0 && ctx.currentTime >= this.nextStartTime - 0.01) {
          this.isPlaying = false;
          this.onStateChange(false);
        }
      };
    }

    // Hard interrupt — drop everything queued and stop currently playing buffers.
    // Used when the model signals interruption or the user ends the session.
    interrupt() {
      this.activeSources.forEach((s) => {
        try { s.stop(); } catch (_) {}
      });
      this.activeSources.clear();
      this.nextStartTime = this.audioContext ? this.audioContext.currentTime : 0;
      if (this.isPlaying) {
        this.isPlaying = false;
        this.onStateChange(false);
      }
    }

    async close() {
      this.interrupt();
      if (this.audioContext) {
        try { await this.audioContext.close(); } catch (_) {}
        this.audioContext = null;
      }
    }
  }

  global.SochAudioPlayer = AudioPlayer;
})(window);
