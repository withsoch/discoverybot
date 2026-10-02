// Soch Automation Diagnostic — embeddable voice widget (single-file bundle).
//
// One <script src="widget.js"> tag is all the host page needs. The widget
// self-injects its DOM, stylesheet, and Google Font into <body>. CSS is
// scoped under #soch-voice-widget, so it cannot bleed into the host page.
//
// Architecture
// ─────────────
//  [Mic] ──► AudioWorklet (16kHz PCM Float32) ──► PCM16 + base64
//                                                    │
//                                              WebSocket (camelCase JSON)
//                                                    │
//  [Speakers] ◄── BufferSource scheduler ◄── PCM16 @24kHz from server
//
// Wire format follows the current Gemini Live spec:
//   • All keys camelCase (`generationConfig`, `realtimeInput`, `toolResponse`).
//   • Audio sent under `realtimeInput.audio`, NOT the deprecated `mediaChunks`.
//   • Function declarations under `tools[0].functionDeclarations`.
//   • Tool responses under `toolResponse.functionResponses`.
//
// The browser never sees the long-lived API key — it authenticates with a
// single-use ephemeral token minted by the backend at /token.

(function () {
  'use strict';

  if (window.__sochVoiceWidgetLoaded) return;
  window.__sochVoiceWidgetLoaded = true;
  console.log('[soch] widget build: rag-v6+booking-v3');

  // ─────────────────────────────────────────────────────────────────────
  // Backend URL discovery
  // ─────────────────────────────────────────────────────────────────────
  // The script tag's src tells us where /token, /lead, and /audio-processor.js
  // live, so the same compiled bundle works regardless of the embed origin.
  const scriptEl =
    document.currentScript ||
    Array.from(document.scripts).find((s) => /widget\.js(\?|$)/.test(s.src));
  let BACKEND_URL = window.location.origin;
  if (scriptEl && scriptEl.src) {
    try { BACKEND_URL = new URL(scriptEl.src).origin; } catch (_) {}
  }

  // ─────────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────────
  const INPUT_SAMPLE_RATE = 16000;   // Gemini Live input
  const OUTPUT_SAMPLE_RATE = 24000;  // Gemini Live output
  const CHUNK_SAMPLES = 1600;        // ~100 ms of audio per send
  const GEMINI_WS_BASE =
    // Ephemeral-token connections MUST use the …Constrained variant of the
    // method (not plain BidiGenerateContent) — the plain method only accepts
    // a real API key. Also must match the v1alpha version used to mint the
    // token, or Gemini rejects it right after the socket opens.
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';

  // The server's n8n budget is 25 s (LEAD_TIMEOUT_MS); wait a little longer so
  // the widget always gets the server's real answer rather than timing out first.
  const LEAD_CLIENT_TIMEOUT_MS = 30000;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  // What the bot may say for each /lead status (returned to Gemini with the
  // tool result). Only `sent` allows the 24-hour promise.
  const LEAD_GUIDANCE = {
    sent: "Success. Say you've just emailed them a link to book a free 30-minute call with Riz, and that they'll receive the follow-up within 24 hours. The link is also on their screen. Do not say any time is booked; they pick the time themselves.",
    sent_no_followup: "The booking-link email was sent, but the follow-up could not be confirmed. Say you've emailed them the link to book a free 30-minute call with Riz and it's also on their screen. Do NOT mention 24 hours or promise a follow-up. Do not say any time is booked.",
    saved_no_email: "Their details were saved but the email did NOT send. Say you've passed their details to Riz and they can use the booking link on their screen to schedule the 30-minute call. Do NOT say you emailed them and do NOT mention 24 hours.",
    failed: "Their details could NOT be sent. Say you couldn't send their details through just now, and that they can use the booking link on their screen to schedule the call, or contact info@withsoch.com. Do NOT say you emailed them, that Riz has their details, or that anything is booked. Do NOT mention 24 hours.",
  };
  // Matching on-screen note under the Book-a-Call button.
  const BOOKING_NOTES = {
    sent: (email) => `Booking link sent to ${email}. You can also book here.`,
    sent_no_followup: (email) => `Booking link sent to ${email}. You can also book here.`,
    saved_no_email: () => "We couldn't email you the link. Use this button to book your call.",
    failed: () => "We couldn't send your details. Book here, or email info@withsoch.com.",
  };

  const PHASES = ['Company', 'Operations', 'Tools', 'Pain Points', 'Score'];
  const RING_CIRCUMFERENCE = 2 * Math.PI * 54; // r=54
  const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

  // ─────────────────────────────────────────────────────────────────────
  // Audio helpers
  // ─────────────────────────────────────────────────────────────────────

  /** Convert Float32 [-1, 1] mono samples to base64-encoded little-endian PCM16. */
  function float32ToPCM16Base64(float32) {
    const len = float32.length;
    const int16 = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const s = float32[i];
      // Clamp + scale, branch-free hot path.
      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    // Int16Array is little-endian on every engine that runs in browsers.
    const bytes = new Uint8Array(int16.buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  /** Marks tool-result guidance so the model follows it rather than speaking it. */
  function internalNote(text) {
    return `INTERNAL NOTE (follow it, never read it aloud): ${text}`;
  }

  /**
   * True when every letter of the name also spells the email's local part
   * (e.g. "Max Ok" from max.ok@example.com) — a sign it was read off the
   * address rather than said by the prospect.
   */
  function nameLooksDerivedFromEmail(name, email) {
    const letters = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
    const local = letters(String(email).split('@')[0] || '');
    const n = letters(name);
    return n.length > 0 && n === local;
  }

  /**
   * True if spoken text reads back this email ("olga dot ok at example dot com").
   * Speech transcripts vary ("ok" → "okay"), so it checks for the domain and the
   * start of the local part rather than an exact match.
   */
  function textReadsBackEmail(text, email) {
    const alnum = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
    const spoken = alnum(String(text).toLowerCase().replace(/\b(dot|at)\b/g, ''));
    const [local, domain] = String(email).split('@');
    const head = alnum(local).slice(0, 3);
    return head.length > 0 && spoken.includes(head) && spoken.includes(alnum(domain || ''));
  }

  // The model records discovery details as they come up and may call a capture
  // tool again with only the new fields, so omitted fields keep earlier values.
  function mergeDefined(target, fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') target[k] = v;
    }
  }

  // The minimum the prospect must have said before the score: what they do,
  // their main problem, and one sense of how big it is. Everything else is
  // optional and only feeds the score.
  const DISCOVERY_REQUIRED = [
    ['industry', 'what the company does'],
    ['main_bottleneck', 'their main problem'],
  ];
  // Either field gives a scale signal (problem_frequency also holds time spent).
  const SCALE_FIELDS = ['problem_frequency', 'problem_impact'];
  const SCALE_LABEL = 'how often it happens, how much time it takes, or what it costs them';
  const DISCOVERY_MAX_FOLLOWUPS = 2; // answers after the minimum is met before the model is told to score
  const DISCOVERY_SOFT_MAX = 6;      // from this many answers, the model is told to wrap up

  // Automation Readiness Score: the model classifies what the prospect said
  // into these categories and the score is computed from them; the model never
  // picks the number. Anything unknown or unrecognised scores 0.
  const SCORE_RUBRIC = {
    frequency:     { daily: 3, weekly: 2, monthly: 1, rare_or_unknown: 0 },
    time_cost:     { over_15h_week: 3, '5_to_15h_week': 2, '2_to_5h_week': 1, under_2h_or_unknown: 0 },
    impact:        { revenue_customers_cashflow: 3, errors_delays: 2, internal_annoyance: 1, none: 0 },
    repeatability: { rule_based: 2, mixed: 1, human_judgement: 0 },
    tools:         { several_digital_systems: 2, spreadsheets_email: 1, paper_none: 0 },
    team_size:     { '11_plus': 2, '2_to_10': 1, solo: 0 },
  };
  const SCORE_MAX_POINTS = 15;
  function scoreTier(score) {
    return score >= 7.5 ? 'HIGH READINESS' : score >= 5 ? 'MEDIUM READINESS' : 'EARLY STAGE';
  }
  /** "12", "50-100", "about 20 people" → its band; null when no number was said. */
  function teamSizeBand(teamSize) {
    const m = String(teamSize || '').match(/\d+/);
    if (!m) return null;
    const n = Number(m[0]);
    return n >= 11 ? '11_plus' : n >= 2 ? '2_to_10' : 'solo';
  }
  /** Points per category and the resulting score/tier. */
  function computeScore(categories) {
    const points = {};
    let total = 0;
    for (const [cat, values] of Object.entries(SCORE_RUBRIC)) {
      const p = values[categories[cat]] || 0;
      points[cat] = p;
      total += p;
    }
    const score = Math.round((1 + 9 * total / SCORE_MAX_POINTS) * 10) / 10;
    return { score, tier: scoreTier(score), total, points };
  }

  // "unknown", "n/a", "not mentioned"…: a value the model filled in without the
  // prospect saying anything. It never counts as knowing a topic.
  const PLACEHOLDER_RE = /^(unspecified|unknown|unclear|undefined|null|none|nil|tbd|tba|pending|n\/?a|not (yet )?(mentioned|specified|provided|stated|given|known|discussed|shared|available|clear|sure|applicable)( yet)?|no (info|information|details?|data)( (yet|given|provided))?|-+|\?+)$/;
  function isPlaceholder(v) {
    return PLACEHOLDER_RE.test(String(v).trim().toLowerCase().replace(/[.!]+$/, '').trim());
  }
  function hasValue(v) {
    return v !== undefined && v !== null && String(v).trim() !== '' && !isPlaceholder(v);
  }

  // "your team scores a 7 out of 10": a score said aloud (used to catch one
  // spoken without calling calculate_score).
  const SPOKEN_SCORE_RE = /\bscor(e|es|ed|ing)\b[^.?!]{0,40}?\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*(out of|\/)\s*(10|ten)\b/i;

  function newDiscoveryState() {
    return {
      nudges: 0,         // model turns the widget itself prompted (not prospect answers)
      readyAt: null,     // answer index when the discovery minimum was first met
      scoreForced: false, // the widget has told the model to score now (follow-up limit reached)
    };
  }

  function newSessionId() {
    const raw = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return 'sv_' + raw.replace(/[^A-Za-z0-9]/g, '');
  }

  /** Decode base64 PCM16 (little-endian) into a Float32Array in [-1, 1]. */
  function base64PCM16ToFloat32(b64) {
    const binary = atob(b64);
    const len = binary.length;
    // Int16Array requires an even-byte buffer; drop a trailing odd byte
    // defensively (in practice Gemini always sends aligned PCM frames).
    const evenLen = len & ~1;
    const buf = new ArrayBuffer(evenLen);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < evenLen; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(buf);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    return f32;
  }

  // ─────────────────────────────────────────────────────────────────────
  // AudioStreamer — captures mic, posts ~100ms PCM16 base64 chunks
  // ─────────────────────────────────────────────────────────────────────
  class AudioStreamer {
    constructor({ workletUrl, onChunk, onLevel }) {
      this.workletUrl = workletUrl;
      this.onChunk = onChunk;
      this.onLevel = onLevel || (() => {});
      this.stream = null;
      this.audioContext = null;
      this.source = null;
      this.workletNode = null;
      this.scriptNode = null;
      this.muted = false;
      this.running = false;
      // When the AudioContext can't run at 16 kHz (Safari, some Firefox), we
      // resample manually. Holds the integer downsample ratio.
      this.resampleRatio = 1;
      this.resampleAccum = 0;
      this.pending = new Float32Array(0);
    }

    async start() {
      if (this.running) return;

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: INPUT_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const Ctx = window.AudioContext || window.webkitAudioContext;
      // Try to pin the context to 16 kHz; some browsers (notably Safari)
      // ignore or reject this. Fall back and resample.
      try {
        this.audioContext = new Ctx({ sampleRate: INPUT_SAMPLE_RATE });
      } catch (_) {
        this.audioContext = new Ctx();
      }
      const ctxRate = this.audioContext.sampleRate;
      this.resampleRatio = ctxRate / INPUT_SAMPLE_RATE;

      this.source = this.audioContext.createMediaStreamSource(this.stream);

      const useWorklet = !!this.audioContext.audioWorklet;
      if (useWorklet) {
        try {
          await this.audioContext.audioWorklet.addModule(this.workletUrl);
          // Worklet emits frames at the context's native rate. We size its
          // buffer in ratio so each emission yields ~CHUNK_SAMPLES at 16 kHz.
          const workletChunk = Math.round(CHUNK_SAMPLES * this.resampleRatio);
          this.workletNode = new AudioWorkletNode(
            this.audioContext,
            'soch-pcm-processor',
            { processorOptions: { targetSamples: workletChunk } }
          );
          this.workletNode.port.onmessage = (e) => this._onFrame(e.data);
          this.source.connect(this.workletNode);
          // Sink at zero gain so the graph runs without echoing locally.
          const sink = this.audioContext.createGain();
          sink.gain.value = 0;
          this.workletNode.connect(sink).connect(this.audioContext.destination);
        } catch (err) {
          console.warn('[soch] AudioWorklet failed, falling back', err);
          this._initScriptProcessor();
        }
      } else {
        this._initScriptProcessor();
      }

      this.running = true;
    }

    _initScriptProcessor() {
      const target = Math.round(CHUNK_SAMPLES * this.resampleRatio);
      const node = this.audioContext.createScriptProcessor(4096, 1, 1);
      let pending = new Float32Array(0);
      node.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const merged = new Float32Array(pending.length + input.length);
        merged.set(pending);
        merged.set(input, pending.length);
        let offset = 0;
        while (merged.length - offset >= target) {
          this._onFrame(merged.slice(offset, offset + target));
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

    _onFrame(float32) {
      if (this.muted || !this.running) return;

      // RMS for the mic-meter (cheap; ~1600 ops/100ms).
      let sum = 0;
      for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
      this.onLevel(Math.sqrt(sum / float32.length));

      // Resample to 16 kHz if the context isn't already there. We use simple
      // sample-and-hold — sufficient for speech, no aliasing artifacts at
      // typical browser rates (44.1 → 16, 48 → 16). For higher quality we'd
      // need a low-pass; in practice Gemini's encoder handles it fine.
      const samples = this.resampleRatio === 1
        ? float32
        : this._resample(float32);
      if (samples.length === 0) return;
      this.onChunk(float32ToPCM16Base64(samples));
    }

    _resample(float32) {
      const ratio = this.resampleRatio;
      // Carry the fractional position across calls so we don't drift.
      const startAccum = this.resampleAccum;
      const out = [];
      let pos = startAccum;
      while (pos < float32.length) {
        out.push(float32[pos | 0]);
        pos += ratio;
      }
      this.resampleAccum = pos - float32.length;
      return new Float32Array(out);
    }

    setMuted(muted) {
      this.muted = !!muted;
      if (this.stream) {
        for (const t of this.stream.getAudioTracks()) t.enabled = !this.muted;
      }
    }

    async stop() {
      this.running = false;
      try { if (this.workletNode) this.workletNode.disconnect(); } catch (_) {}
      try { if (this.scriptNode) this.scriptNode.disconnect(); } catch (_) {}
      try { if (this.source) this.source.disconnect(); } catch (_) {}
      if (this.stream) for (const t of this.stream.getTracks()) t.stop();
      if (this.audioContext) {
        try { await this.audioContext.close(); } catch (_) {}
      }
      this.workletNode = this.scriptNode = this.source = this.stream = this.audioContext = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // AudioPlayer — gapless playback of streamed PCM16 @ 24kHz
  // ─────────────────────────────────────────────────────────────────────
  // We schedule each incoming chunk on the AudioContext clock so chunks play
  // back-to-back without gaps even if they arrive bursty. `interrupt()` drops
  // everything currently queued — Gemini Live signals interruption when the
  // user starts speaking over the model.
  class AudioPlayer {
    constructor({ onStateChange }) {
      this.onStateChange = onStateChange || (() => {});
      this.audioContext = null;
      this.nextStartTime = 0;
      this.activeSources = new Set();
      this.isPlaying = false;
    }

    async init() {
      if (this.audioContext) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      try {
        this.audioContext = new Ctx({ sampleRate: OUTPUT_SAMPLE_RATE });
      } catch (_) {
        this.audioContext = new Ctx();
      }
      if (this.audioContext.state === 'suspended') {
        try { await this.audioContext.resume(); } catch (_) {}
      }
    }

    async enqueue(base64) {
      await this.init();
      const ctx = this.audioContext;
      const float32 = base64PCM16ToFloat32(base64);
      if (float32.length === 0) return;

      // If the context fell back to a non-24k rate, the BufferSource will
      // resample on playback — slightly more expensive but correct.
      const buffer = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
      buffer.copyToChannel(float32, 0);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      const startAt = Math.max(ctx.currentTime, this.nextStartTime);
      src.start(startAt);
      this.nextStartTime = startAt + buffer.duration;

      this.activeSources.add(src);
      if (!this.isPlaying) {
        this.isPlaying = true;
        this.onStateChange(true);
      }
      src.onended = () => {
        this.activeSources.delete(src);
        if (this.activeSources.size === 0 && this.isPlaying) {
          this.isPlaying = false;
          this.onStateChange(false);
        }
      };
    }

    interrupt() {
      for (const src of this.activeSources) {
        try { src.stop(); } catch (_) {}
      }
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

  // ─────────────────────────────────────────────────────────────────────
  // GeminiLiveClient — direct browser WebSocket to the Live API
  // ─────────────────────────────────────────────────────────────────────
  class GeminiLiveClient {
    constructor(opts) {
      this.model = opts.model;
      this.cb = {
        onAudio: opts.onAudio || (() => {}),
        onUserTranscript: opts.onUserTranscript || (() => {}),
        onModelTranscript: opts.onModelTranscript || (() => {}),
        onToolCalls: opts.onToolCalls || (() => {}),
        onTurnComplete: opts.onTurnComplete || (() => {}),
        onModelTurnEnd: opts.onModelTurnEnd || (() => {}),
        onInterrupted: opts.onInterrupted || (() => {}),
        onOpen: opts.onOpen || (() => {}),
        onClose: opts.onClose || (() => {}),
        onError: opts.onError || (() => {}),
        onGoAway: opts.onGoAway || (() => {}),
      };
      this.ws = null;
      this.connected = false;
    }

    connect(ephemeralToken) {
      return new Promise((resolve, reject) => {
        // Ephemeral tokens go in `access_token`, not `key` (which is for raw API keys).
        const url = `${GEMINI_WS_BASE}?access_token=${encodeURIComponent(ephemeralToken)}`;
        let settled = false;
        let ws;
        try { ws = new WebSocket(url); }
        catch (err) { reject(err); return; }
        this.ws = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          // Prompt, tools, voice and transcription are locked into the
          // ephemeral token server-side; only the model is sent here.
          const setup = {
            setup: {
              model: this.model.startsWith('models/')
                ? this.model
                : `models/${this.model}`,
            },
          };
          ws.send(JSON.stringify(setup));
        };

        ws.onmessage = (event) => {
          this._decode(event.data).then((msg) => {
            if (!msg) return;
            this._dispatch(msg, () => {
              if (!settled) {
                settled = true;
                this.connected = true;
                this.cb.onOpen();
                resolve();
              }
            });
          });
        };

        ws.onerror = (event) => {
          this.cb.onError(event);
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket error before setup'));
          }
        };

        ws.onclose = (event) => {
          this.connected = false;
          this.cb.onClose(event);
          console.warn('[soch] ws closed', { code: event.code, reason: event.reason, wasClean: event.wasClean });
          if (!settled) {
            settled = true;
            reject(new Error(`WebSocket closed before setup (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`));
          }
        };
      });
    }

    async _decode(data) {
      let raw;
      if (typeof data === 'string') raw = data;
      else if (data instanceof Blob) raw = await data.text();
      else if (data instanceof ArrayBuffer) raw = new TextDecoder().decode(data);
      else return null;
      try { return JSON.parse(raw); }
      catch (err) { console.warn('[soch] non-JSON live message', raw); return null; }
    }

    _dispatch(msg, onSetupComplete) {
      if (msg.setupComplete) { onSetupComplete && onSetupComplete(); return; }

      const sc = msg.serverContent;
      if (sc) {
        if (sc.interrupted) this.cb.onInterrupted();
        if (sc.inputTranscription && sc.inputTranscription.text) {
          this.cb.onUserTranscript(
            sc.inputTranscription.text,
            !!sc.inputTranscription.finished
          );
        }
        if (sc.outputTranscription && sc.outputTranscription.text) {
          this.cb.onModelTranscript(
            sc.outputTranscription.text,
            !!sc.outputTranscription.finished
          );
        }
        if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
          for (const part of sc.modelTurn.parts) {
            if (part.inlineData && typeof part.inlineData.data === 'string') {
              this.cb.onAudio(part.inlineData.data);
            } else if (part.thought) {
              // Native-audio models stream private reasoning as text parts; never show it.
            } else if (part.text) {
              this.cb.onModelTranscript(part.text, false);
            }
          }
        }
        if (sc.turnComplete || sc.generationComplete) this.cb.onTurnComplete();
        // turnComplete (not generationComplete) marks the model handing the
        // floor back to the user — used to require a user reply between
        // capture_lead and send_to_crm.
        if (sc.turnComplete) this.cb.onModelTurnEnd();
      }

      if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
        this.cb.onToolCalls(msg.toolCall.functionCalls);
      }
      if (msg.goAway) this.cb.onGoAway(msg.goAway);
    }

    sendAudio(base64) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // Current spec: a single `audio` blob, not the deprecated mediaChunks[].
      this.ws.send(JSON.stringify({
        realtimeInput: {
          audio: { data: base64, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` },
        },
      }));
    }

    sendText(text) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true,
        },
      }));
    }

    // All responses to one toolCall message go back together: each separate
    // toolResponse makes the model resume speaking, so replying one by one
    // made it repeat itself after multi-tool turns.
    sendToolResponses(results) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !results.length) return;
      this.ws.send(JSON.stringify({
        toolResponse: {
          functionResponses: results.map(({ id, name, response }) => ({
            id, name,
            response: typeof response === 'object' ? response : { output: response },
          })),
        },
      }));
    }

    disconnect() {
      this.connected = false;
      if (this.ws) {
        try { this.ws.close(1000, 'client closed'); } catch (_) {}
        this.ws = null;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // DOM
  // ─────────────────────────────────────────────────────────────────────
  function injectFont() {
    if (document.querySelector('link[data-soch-font]')) return;
    const make = (rel, href, attrs) => {
      const link = document.createElement('link');
      link.rel = rel;
      link.href = href;
      link.setAttribute('data-soch-font', '1');
      if (attrs) Object.assign(link, attrs);
      document.head.appendChild(link);
    };
    make('preconnect', 'https://fonts.googleapis.com');
    make('preconnect', 'https://fonts.gstatic.com', { crossOrigin: 'anonymous' });
    make('stylesheet', 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
  }

  function injectStyles() {
    if (document.querySelector('link[data-soch-css]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${BACKEND_URL}/widget.css`;
    link.setAttribute('data-soch-css', '1');
    document.head.appendChild(link);
  }

  function buildDOM() {
    const root = document.createElement('div');
    root.id = 'soch-voice-widget';
    root.innerHTML = `
      <button class="soch-pill" type="button" aria-label="Open Soch Automation Diagnostic">
        Discover your automation potential →
      </button>
      <div class="soch-panel" hidden role="dialog" aria-label="Soch Automation Diagnostic">
        <div class="soch-header">
          <div>
            <p class="soch-title">Automation Diagnostic</p>
            <p class="soch-subtitle">Powered by Soch</p>
          </div>
          <button class="soch-close" type="button" aria-label="Close">×</button>
        </div>

        <div class="soch-progress">
          <div class="soch-dots">${PHASES.map(() => '<span class="soch-dot"></span>').join('')}</div>
          <div class="soch-phase-label"></div>
        </div>

        <div class="soch-viz-wrap">
          <div class="soch-bars">${Array.from({ length: 7 }).map(() => '<span class="soch-bar"></span>').join('')}</div>
          <div class="soch-status">Tap to start</div>
        </div>

        <div class="soch-transcript" aria-live="polite"></div>

        <div class="soch-cta" hidden>
          <div class="soch-score-ring">
            <svg viewBox="0 0 128 128">
              <circle class="ring-bg" cx="64" cy="64" r="54" />
              <circle class="ring-fg" cx="64" cy="64" r="54"
                stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(3)}"
                stroke-dashoffset="${RING_CIRCUMFERENCE.toFixed(3)}" />
            </svg>
            <div class="soch-score-num"><span class="num">0.0</span><span class="suffix">/10</span></div>
          </div>
          <div class="soch-tier"></div>
          <ul class="soch-opps"></ul>
        </div>

        <div class="soch-error" hidden></div>

        <div class="soch-booking" hidden>
          <a class="soch-book-btn" href="#" target="_blank" rel="noopener noreferrer">Book a 30-min call with Riz</a>
          <p class="soch-booking-note" hidden></p>
        </div>

        <div class="soch-bottom">
          <button class="soch-iconbtn soch-mic" type="button" aria-label="Mute microphone" title="Mute">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="3" width="6" height="12" rx="3"/>
              <path d="M5 11a7 7 0 0 0 14 0"/>
              <line x1="12" y1="18" x2="12" y2="22"/>
            </svg>
          </button>
          <button class="soch-main-btn" type="button">START</button>
          <button class="soch-iconbtn soch-restart" type="button" aria-label="Restart" title="Restart">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12a9 9 0 1 1-3-6.7"/>
              <polyline points="21 4 21 10 15 10"/>
            </svg>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    return root;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Widget controller
  // ─────────────────────────────────────────────────────────────────────
  class SochWidget {
    constructor() {
      this.root = buildDOM();
      const $ = (sel) => this.root.querySelector(sel);
      this.els = {
        pill: $('.soch-pill'),
        panel: $('.soch-panel'),
        close: $('.soch-close'),
        dots: Array.from(this.root.querySelectorAll('.soch-dot')),
        phaseLabel: $('.soch-phase-label'),
        bars: Array.from(this.root.querySelectorAll('.soch-bar')),
        barsWrap: $('.soch-bars'),
        status: $('.soch-status'),
        transcript: $('.soch-transcript'),
        cta: $('.soch-cta'),
        ringFg: $('.ring-fg'),
        scoreNum: $('.soch-score-num .num'),
        tier: $('.soch-tier'),
        opps: $('.soch-opps'),
        error: $('.soch-error'),
        booking: $('.soch-booking'),
        bookBtn: $('.soch-book-btn'),
        bookingNote: $('.soch-booking-note'),
        mic: $('.soch-mic'),
        mainBtn: $('.soch-main-btn'),
        restart: $('.soch-restart'),
      };

      // Session state
      this.expanded = false;
      this.sessionActive = false;
      this.cleaningUp = false;
      this.muted = false;
      this.phaseIndex = -1;
      this.leadData = {};
      // One id per conversation (kept across END/START, reset by restart) so
      // n8n updates the same lead instead of creating duplicates.
      this.sessionId = null;
      this.bookingUrl = null;      // existing Cal.com 30-min event, from /token
      this.storedLeadSig = null;   // signature of the last payload n8n confirmed stored
      // Email confirmation guard: send_to_crm is only allowed once the model has
      // ended at least one turn (read the email back) since capture_lead.
      this.modelTurns = 0;
      this.scoreNudged = false;    // asked the model once to record a score it only spoke
      this.discovery = newDiscoveryState();
      this.turnText = '';          // what the bot has said in the current turn
      this.lastTurnText = '';      // …and in the previous one
      this.captureTurn = null;
      this.emailConfirmed = false;
      this.client = null;
      this.streamer = null;
      this.player = null;
      this.tokenAbort = null;

      // Visualization state
      this.aiSpeaking = false;
      this.userSpeaking = false;
      this.barsMode = 'idle'; // 'idle' | 'ai' | 'user'
      this.rafId = null;

      // Transcript bubble state — keyed off the `finished` flag from the
      // server, NOT turnComplete (deltas can arrive after turnComplete).
      this.userBubble = null;
      this.modelBubble = null;

      // Public event listeners (programmatic API).
      this.listeners = {};

      this._wireUI();
      this._renderPhase();
    }

    // ───── Programmatic API ─────
    on(event, fn) {
      (this.listeners[event] || (this.listeners[event] = [])).push(fn);
      return this;
    }
    _emit(event, payload) {
      const ls = this.listeners[event];
      if (!ls) return;
      for (const fn of ls) {
        try { fn(payload); } catch (err) { console.error('[soch] listener error', err); }
      }
    }

    // ───── UI wiring ─────
    _wireUI() {
      this.els.pill.addEventListener('click', () => this.open());
      this.els.close.addEventListener('click', () => this.close());
      this.els.mainBtn.addEventListener('click', () => this.toggleSession());
      this.els.mic.addEventListener('click', () => this.toggleMute());
      this.els.restart.addEventListener('click', () => this.restart());
      this.els.bookBtn.addEventListener('click', () => this._emit('booking_click', { session_id: this.sessionId }));
      // Last chance to save a partial lead when the visitor closes the tab.
      window.addEventListener('pagehide', () => this._savePartialLead({ beacon: true }));
    }

    /**
     * Shows the Book-a-Call button whenever the booking URL is known. `link`
     * is the prefilled per-lead URL once the lead has been submitted; the note
     * says truthfully what happened to the email.
     */
    _renderBooking(link, note) {
      const href = link || this.bookingUrl;
      if (!href) { this.els.booking.hidden = true; return; }
      this.els.bookBtn.href = href;
      this.els.booking.hidden = false;
      this.els.bookingNote.textContent = note || '';
      this.els.bookingNote.hidden = !note;
    }

    open() {
      this.expanded = true;
      this.els.pill.hidden = true;
      this.els.panel.hidden = false;
      requestAnimationFrame(() => this.els.panel.classList.add('open'));
      this._emit('open');
    }

    close() {
      if (this.sessionActive) this.endSession();
      this.expanded = false;
      this.els.panel.classList.remove('open');
      setTimeout(() => {
        this.els.panel.hidden = true;
        this.els.pill.hidden = false;
      }, 280);
      this._emit('close');
    }

    setError(text) {
      if (!text) {
        this.els.error.hidden = true;
        this.els.error.textContent = '';
        return;
      }
      this.els.error.textContent = text;
      this.els.error.hidden = false;
    }

    setStatus(text) { this.els.status.textContent = text || ''; }

    addMessage(role, text) {
      const div = document.createElement('div');
      div.className = `soch-msg ${role}`;
      div.textContent = text;
      this.els.transcript.appendChild(div);
      const msgs = this.els.transcript.querySelectorAll('.soch-msg');
      // Cap visible bubbles to 6 for compactness.
      for (let i = 0; i < msgs.length - 6; i++) msgs[i].remove();
      this.els.transcript.scrollTop = this.els.transcript.scrollHeight;
      return div;
    }

    appendUserTranscript(text, finished) {
      if (!text) return;
      // The Live model's speech recognition often writes accented English in
      // Devanagari/Telugu script and ignores language hints, so hide any
      // utterance containing non-Latin letters rather than show it garbled.
      if (!this.userHidden && NON_LATIN_LETTER.test(text)) {
        this.userHidden = true;
        if (this.userBubble) { this.userBubble.remove(); this.userBubble = null; }
      }
      if (!this.userHidden) {
        if (!this.userBubble) this.userBubble = this.addMessage('user', text);
        else {
          this.userBubble.textContent += text;
          this.els.transcript.scrollTop = this.els.transcript.scrollHeight;
        }
      }
      if (finished) { this.userBubble = null; this.userHidden = false; }
    }

    appendModelTranscript(text, finished) {
      if (!text) return;
      // The bot replying means the user's utterance is over.
      this.userBubble = null;
      this.userHidden = false;
      if (!this.modelBubble) this.modelBubble = this.addMessage('ai', text);
      else {
        this.modelBubble.textContent += text;
        this.els.transcript.scrollTop = this.els.transcript.scrollHeight;
      }
      if (finished) this.modelBubble = null;
    }

    _renderPhase() {
      for (let i = 0; i < this.els.dots.length; i++) {
        this.els.dots[i].classList.toggle('active', i <= this.phaseIndex);
      }
      this.els.phaseLabel.textContent = this.phaseIndex >= 0 ? PHASES[this.phaseIndex] : '';
    }

    advancePhase(target) {
      const next = typeof target === 'number'
        ? Math.max(this.phaseIndex, target)
        : Math.min(this.phaseIndex + 1, PHASES.length - 1);
      if (next === this.phaseIndex) return;
      this.phaseIndex = next;
      this._renderPhase();
      this._emit('phase', this.phaseIndex);
    }

    // ───── Bars animation (RAF + time-based amplitude) ─────
    _setBarsMode(mode) {
      if (mode === this.barsMode) return;
      this.barsMode = mode;
      this.els.barsWrap.classList.toggle('ai', mode === 'ai');
      this.els.barsWrap.classList.toggle('user', mode === 'user');
      if (mode === 'idle') {
        this._stopBars();
        for (const b of this.els.bars) b.style.height = '4px';
      } else {
        this._startBars();
      }
    }

    _startBars() {
      if (this.rafId) return;
      const start = performance.now();
      // Each bar is driven by a sine wave with its own phase + frequency,
      // giving a more natural waveform-like motion than pure random heights
      // and avoiding the layout-thrash of setInterval(80ms).
      const phases = this.els.bars.map((_, i) => i * 0.7);
      const freqs = this.els.bars.map((_, i) => 6 + (i % 3) * 1.2);
      const tick = (now) => {
        if (!this.rafId) return;
        const t = (now - start) / 1000;
        const amp = this.barsMode === 'ai' ? 14 : 6;
        const baseline = 4;
        for (let i = 0; i < this.els.bars.length; i++) {
          const v = (Math.sin(t * freqs[i] + phases[i]) + 1) / 2;
          const jitter = (Math.random() - 0.5) * (this.barsMode === 'ai' ? 6 : 2);
          const h = Math.max(baseline, Math.round(baseline + amp * v + jitter));
          this.els.bars[i].style.height = h + 'px';
        }
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    }

    _stopBars() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    // ───── Score reveal ─────
    showScore(data) {
      this.els.cta.hidden = false;
      const score = Number(data.score_out_of_10) || 0;
      const pct = Math.max(0, Math.min(1, score / 10));
      const offset = RING_CIRCUMFERENCE * (1 - pct);
      // Force layout flush so the transition runs from the dashed initial state.
      void this.els.ringFg.offsetWidth;
      this.els.ringFg.style.strokeDashoffset = String(offset);

      const start = performance.now();
      const duration = 1500;
      const tick = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        this.els.scoreNum.textContent = (score * eased).toFixed(1);
        if (t < 1) requestAnimationFrame(tick);
        else this.els.scoreNum.textContent = score.toFixed(1);
      };
      requestAnimationFrame(tick);

      this.els.tier.textContent = data.tier || '';
      this.els.opps.innerHTML = '';
      const opps = [data.opportunity_1, data.opportunity_2, data.opportunity_3].filter(Boolean);
      for (const o of opps) {
        const li = document.createElement('li');
        li.textContent = o;
        this.els.opps.appendChild(li);
      }
      this._emit('score', { score, tier: data.tier, opportunities: opps });
    }

    // ───── Session lifecycle ─────
    async toggleSession() {
      if (this.sessionActive) await this.endSession();
      else await this.startSession();
    }

    async startSession() {
      this.setError('');
      this.setStatus('Connecting…');
      this.els.mainBtn.textContent = '…';
      this.els.mainBtn.disabled = true;

      try {
        const { token, model, booking_url } = await this._fetchToken();
        if (!this.sessionId) this.sessionId = newSessionId();
        this.bookingUrl = booking_url || null;
        if (this.els.booking.hidden) this._renderBooking();

        this.player = new AudioPlayer({
          onStateChange: (playing) => {
            this.aiSpeaking = playing;
            if (playing) {
              this.setStatus('Speaking…');
              this._setBarsMode('ai');
            } else if (this.sessionActive) {
              this.setStatus('Listening…');
              this._setBarsMode(this.userSpeaking ? 'user' : 'idle');
            }
          },
        });
        await this.player.init();

        this.client = new GeminiLiveClient({
          model,
          onAudio: (b64) => this.player.enqueue(b64).catch(console.error),
          onUserTranscript: (t, fin) => this.appendUserTranscript(t, fin),
          onModelTranscript: (t, fin) => { this.turnText += t; this.appendModelTranscript(t, fin); },
          onToolCalls: (calls) => this._handleToolCalls(calls),
          onTurnComplete: () => {
            // Don't reset bubbles here — `finished` flag does that. We just
            // refresh the status indicator if the model isn't speaking.
            if (!this.aiSpeaking && this.sessionActive) {
              this.setStatus('Listening…');
              this._setBarsMode(this.userSpeaking ? 'user' : 'idle');
            }
          },
          onModelTurnEnd: () => { this.modelTurns++; this.lastTurnText = this.turnText; this.turnText = ''; if (!this._checkSpokenScore()) this._enforceFollowUpLimit(); },
          onInterrupted: () => { if (this.player) this.player.interrupt(); },
          onOpen: () => this.setStatus('Listening…'),
          onClose: () => {
            if (this.sessionActive && !this.cleaningUp) {
              this.setError('Connection closed. Tap restart to try again.');
              this._cleanupSession();
            }
          },
          onError: (err) => {
            console.error('[soch] live error', err);
            this.setError('Connection error. Please try again.');
          },
          onGoAway: (g) => {
            console.warn('[soch] server goAway', g);
            // Audio-only sessions cap around 15 min; goAway warns first. We
            // close cleanly so the user sees the right error rather than a
            // hard disconnect.
            this.setError('Session ending soon.');
          },
        });

        await this.client.connect(token);

        // The model won't speak first on its own — nudge it with a hidden
        // "kickoff" turn so it opens with the scripted Phase 1 greeting
        // instead of sitting silently waiting for the user to talk first.
        // A parenthetical system-style note gets an empty turn over token
        // connections; a plain greeting reliably triggers the opener.
        this.client.sendText('Hello');

        this.streamer = new AudioStreamer({
          workletUrl: `${BACKEND_URL}/audio-processor.js`,
          onChunk: (b64) => this.client && this.client.sendAudio(b64),
          onLevel: (rms) => this._onMicLevel(rms),
        });

        try {
          await this.streamer.start();
        } catch (micErr) {
          console.error('[soch] mic error', micErr);
          this.setError(
            'Microphone access is needed for the voice experience. Please enable it in your browser and try again.'
          );
          await this._cleanupSession();
          this.els.mainBtn.disabled = false;
          this.els.mainBtn.textContent = 'START';
          return;
        }
        // Re-apply mute if the user toggled it before connecting.
        this.streamer.setMuted(this.muted);

        this.sessionActive = true;
        this.els.mainBtn.disabled = false;
        this.els.mainBtn.textContent = 'END';
        this.els.mainBtn.classList.add('active');
        this.advancePhase(0);
        this._emit('start');
      } catch (err) {
        console.error('[soch] startSession failed', err);
        this.setError(err && err.message ? err.message : 'Could not start session.');
        await this._cleanupSession();
        this.els.mainBtn.disabled = false;
        this.els.mainBtn.textContent = 'START';
      }
    }

    async _fetchToken() {
      if (this.tokenAbort) this.tokenAbort.abort();
      this.tokenAbort = new AbortController();
      const timeout = setTimeout(() => this.tokenAbort.abort(), 8000);
      try {
        const res = await fetch(`${BACKEND_URL}/token`, {
          method: 'GET',
          signal: this.tokenAbort.signal,
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`Token request failed (${res.status})`);
        const body = await res.json();
        if (!body.token) throw new Error('Token response missing');
        return body;
      } finally {
        clearTimeout(timeout);
        this.tokenAbort = null;
      }
    }

    _onMicLevel(rms) {
      // Hysteresis prevents the user-speaking indicator from flapping near
      // the threshold. Higher to enter "speaking", lower to leave.
      const enter = 0.025;
      const exit = 0.012;
      const speaking = this.userSpeaking
        ? rms > exit
        : rms > enter;
      if (speaking !== this.userSpeaking) {
        this.userSpeaking = speaking;
        if (!this.aiSpeaking) {
          this._setBarsMode(speaking ? 'user' : 'idle');
        }
      }
    }

    async endSession() {
      await this._cleanupSession();
      this.setStatus('Tap to start');
      this._emit('end');
    }

    async _cleanupSession() {
      if (this.cleaningUp) return;
      this.cleaningUp = true;
      this._savePartialLead();
      this.sessionActive = false;
      this.els.mainBtn.classList.remove('active');
      this.els.mainBtn.textContent = 'START';
      this._setBarsMode('idle');
      try { if (this.streamer) await this.streamer.stop(); } catch (_) {}
      try { if (this.client) this.client.disconnect(); } catch (_) {}
      try { if (this.player) await this.player.close(); } catch (_) {}
      this.streamer = this.client = this.player = null;
      this.userBubble = this.modelBubble = null;
      this.aiSpeaking = this.userSpeaking = false;
      this.cleaningUp = false;
    }

    async restart() {
      await this._cleanupSession();
      this.leadData = {};
      this.sessionId = null;
      this.storedLeadSig = null;
      this.captureTurn = null;
      this.emailConfirmed = false;
      this.turnText = '';
      this.lastTurnText = '';
      this.scoreNudged = false;
      this.discovery = newDiscoveryState();
      this._renderBooking();
      this.phaseIndex = -1;
      this._renderPhase();
      this.els.transcript.innerHTML = '';
      this.els.cta.hidden = true;
      this.els.ringFg.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
      this.els.scoreNum.textContent = '0.0';
      this.muted = false;
      this.els.mic.classList.remove('muted');
      this.els.mic.title = 'Mute';
      this.setError('');
      this.setStatus('Tap to start');
      this._emit('restart');
    }

    toggleMute() {
      this.muted = !this.muted;
      if (this.streamer) this.streamer.setMuted(this.muted);
      this.els.mic.classList.toggle('muted', this.muted);
      this.els.mic.title = this.muted ? 'Unmute' : 'Mute';
      this._emit('mute', this.muted);
    }

    // ───── Tool call handling ─────
    // Calls in one message run in order (capture_lead before send_to_crm) and
    // are answered in a single toolResponse.
    async _handleToolCalls(calls) {
      const results = [];
      for (const call of calls) {
        const { id, name } = call || {};
        results.push({ id, name, response: await this._handleToolCall(call) });
      }
      if (this.client) this.client.sendToolResponses(results);
    }

    async _handleToolCall(call) {
      const { name, args } = call || {};
      const a = args || {};
      let response = { output: 'success' };
      try {
        switch (name) {
          case 'capture_company_info':
            this._recordDiscovery({
              company_name: a.company_name,
              team_size: a.team_size,
              industry: a.industry,
            });
            this.advancePhase(1);
            response = this._discoveryStatus();
            break;
          case 'capture_operations_data':
            this._recordDiscovery({
              main_processes: a.main_processes,
              highest_frequency_task: a.highest_frequency_task,
              tools_used: a.tools_used,
              tool_count: a.tool_count,
            });
            this.advancePhase(2);
            response = this._discoveryStatus();
            break;
          case 'capture_pain_points':
            this._recordDiscovery({
              main_bottleneck: a.main_bottleneck,
              problem_frequency: a.problem_frequency,
              problem_impact: a.problem_impact,
              automation_dream: a.automation_dream,
              pain_specificity: a.pain_specificity,
            });
            this.advancePhase(3);
            response = this._discoveryStatus();
            break;
          case 'calculate_score': {
            // Scored once, only once the discovery minimum is known: a call
            // before that (or after the score is shown) is refused, so nothing
            // is scored or revealed mid-conversation.
            if (this.leadData.score_out_of_10 != null) {
              response = { output: 'already_displayed', guidance: internalNote('The score was already calculated and shown. Do not calculate it again; carry on from where you are.') };
              break;
            }
            const missing = this._missingDiscovery();
            if (missing.length) {
              response = {
                error: 'discovery_incomplete',
                missing,
                guidance: internalNote(`Nothing was scored or shown: still unclear: ${missing.join('; ')}. If the prospect already told you any of these, record it now with the matching capture tool, using what they said, then call calculate_score again. Otherwise ask about it naturally, around what they just said. Don't mention a score, an assessment or readiness.`),
              };
              break;
            }
            // The Live model sometimes calls this with no arguments; bounce it
            // back so it retries with values instead of the UI/CRM getting 0/10.
            if (!a.opportunity_1) {
              response = { error: 'Missing required fields. Call calculate_score again with every category plus opportunity_1, opportunity_2, opportunity_3 and score_rationale filled in.' };
              break;
            }
            // The score comes from the rubric, never from the model. A team
            // size the prospect said as a number beats the model's category.
            const categories = {};
            for (const cat of Object.keys(SCORE_RUBRIC)) categories[cat] = a[cat];
            categories.team_size = teamSizeBand(this.leadData.team_size) || a.team_size;
            const result = computeScore(categories);
            Object.assign(this.leadData, {
              score_out_of_10: result.score,
              tier: result.tier,
              opportunities: [a.opportunity_1, a.opportunity_2, a.opportunity_3].filter(Boolean),
              score_rationale: a.score_rationale,
              score_inputs: { categories, points: result.points, total: result.total },
            });
            this.showScore({ ...a, score_out_of_10: result.score, tier: result.tier });
            this.advancePhase(4);
            const spoken = `${result.score} out of 10, ${result.tier}`;
            response = {
              output: 'displayed',
              score_out_of_10: result.score,
              tier: result.tier,
              guidance: internalNote(this.scoreNudged
                ? `It's now on screen as ${spoken}. If that isn't what you told them, correct it briefly and naturally; otherwise don't repeat it. Carry on from where you were.`
                : `The score on screen is ${spoken}. Deliver exactly that score and tier.`),
            };
            break;
          }
          case 'capture_lead':
            response = this._captureLead(a);
            break;
          case 'send_to_crm':
            // The model sometimes skips capture_lead and passes the details here;
            // capture them first so the confirmation guard still applies.
            if (a.email || a.name) {
              const details = {
                name: a.name || this.leadData.name,
                email: a.email || this.leadData.email,
                name_stated_by_user: a.name ? a.name_stated_by_user : true,
              };
              const normalized = String(details.email || '').replace(/\s+/g, '').toLowerCase();
              if (normalized !== this.leadData.email || details.name !== this.leadData.name) {
                const captured = this._captureLead(details);
                if (captured.error) { response = captured; break; }
              }
            }
            response = await this._sendLead(a.trigger);
            break;
          case 'lookup_soch_info':
            response = { context: await this._lookupSochInfo(a.query) };
            break;
          default:
            console.warn('[soch] unknown tool', name);
            response = { output: 'unknown' };
        }
      } catch (err) {
        console.error('[soch] tool handler error', name, err);
        response = { output: 'error' };
      }
      return response;
    }

    /**
     * Safety net: if the model said a score out loud without calling
     * calculate_score, nothing reached the screen or the CRM. Ask it once to
     * record it now (the discovery guard still applies, and the rubric sets the number).
     */
    _checkSpokenScore() {
      if (this.scoreNudged || this.leadData.score_out_of_10 != null || !this.client) return false;
      if (!SPOKEN_SCORE_RE.test(this.lastTurnText)) return false;
      this.scoreNudged = true;
      this.discovery.nudges++;
      this.client.sendText(internalNote("You just told the prospect a score, but calculate_score was never called, so nothing is shown on their screen or saved. Call calculate_score now with the categories and the opportunities you said; it works out the score. Don't say anything to the prospect about this."));
      return true;
    }

    /**
     * Code-enforced follow-up limit, checked at the end of every model turn so
     * it never depends on a capture tool firing. Once the discovery minimum is
     * met the model gets DISCOVERY_MAX_FOLLOWUPS more answers (fewer at the
     * soft max); a turn ending after that without a score gets one explicit
     * instruction to score now instead of waiting on another question.
     */
    _enforceFollowUpLimit() {
      const d = this.discovery;
      if (d.scoreForced || d.readyAt == null || this.leadData.score_out_of_10 != null || !this.client) return;
      if (this.leadData.email) return; // name/email flow under way or done: don't cut into it
      const answered = this._answerIndex() - 1; // the answer the model just responded to
      if (answered - d.readyAt < DISCOVERY_MAX_FOLLOWUPS && answered < DISCOVERY_SOFT_MAX) return;
      d.scoreForced = true;
      d.nudges++;
      this.client.sendText(internalNote("That's enough follow-ups. Don't ask another discovery question, and don't wait for an answer to one you just asked. Call calculate_score now, before you say anything, then deliver the score. If you're in the middle of taking their name and email, finish that first and call calculate_score right after."));
    }

    /** What the discovery minimum still lacks: what they do, their main problem, and one scale signal. */
    _missingDiscovery() {
      const missing = DISCOVERY_REQUIRED.filter(([k]) => !hasValue(this.leadData[k])).map(([, label]) => label);
      if (!SCALE_FIELDS.some((k) => hasValue(this.leadData[k]))) missing.push(SCALE_LABEL);
      return missing;
    }

    /** Index of the prospect answer the model is responding to (1 = first answer after the opener). */
    _answerIndex() {
      return this.modelTurns - this.discovery.nudges;
    }

    /**
     * Records capture-tool details and notes when the discovery minimum was
     * first met. Placeholders are dropped, so they never count as known or
     * overwrite what the prospect said.
     */
    _recordDiscovery(fields) {
      const real = {};
      for (const [k, v] of Object.entries(fields)) {
        if (hasValue(v)) real[k] = v;
      }
      mergeDefined(this.leadData, real);
      if (this.discovery.readyAt == null && !this._missingDiscovery().length) {
        this.discovery.readyAt = this._answerIndex();
      }
    }

    /** Time to score: the follow-ups after the minimum are used up, or the conversation reached the soft max. */
    _shouldWrapUp() {
      const d = this.discovery;
      const idx = this._answerIndex();
      return idx >= DISCOVERY_SOFT_MAX || (d.readyAt != null && idx - d.readyAt >= DISCOVERY_MAX_FOLLOWUPS);
    }

    /**
     * Reply to the capture_* tools. Once the minimum is known it points the
     * model at the score (one follow-up at most, only if genuinely needed);
     * it also stops the model re-speaking what it said before the tool call.
     */
    _discoveryStatus() {
      const noRepeat = "Recorded silently. Don't comment on it, and don't repeat anything you already said this turn; if you've already asked your question, stop and wait for their answer.";
      if (this.leadData.score_out_of_10 != null) {
        return { output: 'captured', guidance: internalNote(noRepeat) };
      }
      const missing = this._missingDiscovery();
      if (!missing.length) {
        return {
          output: 'captured',
          guidance: internalNote(this._shouldWrapUp()
            ? "Recorded silently. Don't comment on it or repeat anything you already said this turn. You have enough. Don't ask another question: your next action is to call calculate_score, before you say anything about a score."
            : `${noRepeat} You have enough to score. Only if something important about their main problem is genuinely unclear, ask one short follow-up about it. Otherwise your next action is to call calculate_score, before you say anything about a score. Never ask a question just to fill in a detail.`),
        };
      }
      if (this._answerIndex() >= DISCOVERY_SOFT_MAX) {
        return {
          output: 'captured',
          guidance: internalNote(`${noRepeat} The conversation has gone on a while: wrap up. Ask directly about what's still unclear (${missing.join('; ')}), then score. Don't mention a score yet.`),
        };
      }
      return {
        output: 'captured',
        guidance: internalNote(`${noRepeat} Not enough for the score yet (still unclear: ${missing.join('; ')}), so don't mention any score. Keep the conversation going around what they just said.`),
      };
    }

    /**
     * capture_lead: validates the name the prospect stated and the email, and
     * records them pending confirmation. Only a changed email resets the
     * confirmation, so re-sending the same details after "yes" isn't blocked.
     */
    _captureLead(a) {
      const name = String(a.name || '').trim();
      // Speech-to-text sometimes leaves spaces inside spelled-out addresses.
      const email = String(a.email || '').replace(/\s+/g, '').toLowerCase();
      if (!name) {
        return { error: 'missing_name', status: 'not_sent', guidance: internalNote("Nothing was saved or sent, so do not say you passed on or emailed anything. The prospect hasn't given their name yet. Ask for it in your own words, then call capture_lead again with exactly the name they say.") };
      }
      if (!EMAIL_RE.test(email)) {
        return { error: 'invalid_email', status: 'not_sent', guidance: internalNote("Nothing was saved or sent, so do not say you passed on or emailed anything. That email address is not valid. In your own words, ask them to say their email again slowly, then call capture_lead again.") };
      }
      if (a.name_stated_by_user === false || (nameLooksDerivedFromEmail(name, email) && a.name_stated_by_user !== true)) {
        return {
          error: 'name_unverified',
          status: 'not_sent',
          guidance: internalNote("Nothing was saved or sent, so do not say you passed on or emailed anything. The prospect has not told you their name, and it must not be guessed from the email. Ask for their name in your own words, wait, then call capture_lead again with exactly the name they say and name_stated_by_user true."),
        };
      }
      if (email !== this.leadData.email) {
        // If the bot already read this email back last turn (without calling
        // capture_lead), the prospect has since answered it, so the read-back
        // counts; otherwise the send must wait for a read-back this turn.
        this.captureTurn = textReadsBackEmail(this.lastTurnText, email) ? this.modelTurns - 1 : this.modelTurns;
        this.emailConfirmed = false;
      }
      Object.assign(this.leadData, { name, email });
      return {
        output: 'captured_pending_confirmation',
        name,
        email,
        guidance: internalNote(`Saved, pending confirmation. If you have not read the email back yet, read back exactly this address, ${email}, once and ask if it is right, then wait. If you already read it back, do not repeat it: just wait for their answer. As soon as they confirm, call send_to_crm. If they correct it, call capture_lead again with the corrected email.`),
      };
    }

    /**
     * send_to_crm: submits the lead and turns the backend's real result into
     * what the model is allowed to say. Never reports success it didn't get.
     */
    async _sendLead(requestedTrigger) {
      const ld = this.leadData || {};
      if (!ld.name || !EMAIL_RE.test(ld.email || '')) {
        return {
          status: 'missing_contact',
          guidance: internalNote("Nothing was sent because capture_lead has not been called yet. If the prospect already told you their name and email, call capture_lead with them now without asking again, then confirm the email. Otherwise ask only for whichever detail is missing."),
        };
      }
      // The prospect must get a chance to answer the read-back: refuse a send
      // in the same model turn as capture_lead.
      if (!this.emailConfirmed && this.modelTurns === this.captureTurn) {
        return {
          status: 'needs_confirmation',
          guidance: internalNote(`Nothing was sent and no email went out, so do not say you emailed them. The prospect has not answered the email read-back yet. If you already read ${ld.email} back to them just now, do not repeat it: stop and wait for their answer. If you have not, read it back once and wait. As soon as they confirm, call send_to_crm.`),
        };
      }
      this.emailConfirmed = true;
      const trigger = requestedTrigger === 'booking_request' || requestedTrigger === 'diagnostic_complete'
        ? requestedTrigger
        : (ld.score_out_of_10 != null ? 'diagnostic_complete' : 'booking_request');

      this._renderBooking(null, 'Sending your details…');
      const result = await this._postLead(trigger);
      this._renderBooking(result.booking_link, BOOKING_NOTES[result.status] && BOOKING_NOTES[result.status](ld.email));
      this._emit('lead_result', result);

      return {
        status: result.status,
        email_sent: result.email_sent === true,
        follow_up_confirmed: result.follow_up_confirmed === true,
        booking_link_on_screen: true,
        guidance: internalNote(LEAD_GUIDANCE[result.status] || LEAD_GUIDANCE.failed),
      };
    }

    _buildLeadPayload(trigger) {
      const ld = this.leadData || {};
      return {
        source: 'voice_diagnostic_widget',
        session_id: this.sessionId,
        trigger,
        timestamp: new Date().toISOString(),
        contact: { name: ld.name, email: ld.email },
        company: { name: ld.company_name, team_size: ld.team_size, industry: ld.industry },
        operations: {
          main_processes: ld.main_processes,
          highest_frequency_task: ld.highest_frequency_task,
          tools_used: ld.tools_used,
          tool_count: ld.tool_count,
        },
        pain: {
          main_bottleneck: ld.main_bottleneck,
          problem_frequency: ld.problem_frequency,
          problem_impact: ld.problem_impact,
          automation_dream: ld.automation_dream,
          pain_specificity: ld.pain_specificity,
        },
        score: {
          score_out_of_10: ld.score_out_of_10,
          tier: ld.tier,
          opportunities: ld.opportunities || [],
          rationale: ld.score_rationale,
        },
      };
    }

    /** Everything except trigger/timestamp — used to tell whether n8n already has the latest data. */
    _leadSignature(payload) {
      const { trigger, timestamp, ...rest } = payload;
      return JSON.stringify(rest);
    }

    /** POSTs the lead and returns the backend's actual result (never throws). */
    async _postLead(trigger) {
      const payload = this._buildLeadPayload(trigger);
      this._emit('lead', payload);
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), LEAD_CLIENT_TIMEOUT_MS);
      try {
        const res = await fetch(`${BACKEND_URL}/lead`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        let body = null;
        try { body = await res.json(); } catch (_) { /* non-JSON error page */ }
        if (!body || typeof body.status !== 'string') {
          console.warn('[soch] /lead unexpected response', res.status);
          return { status: 'failed', error: `http_${res.status}`, booking_link: this.bookingUrl };
        }
        if (!body.lead_stored) console.warn('[soch] lead not stored:', body.status, body.error || '');
        else this.storedLeadSig = this._leadSignature(payload);
        return body;
      } catch (err) {
        console.error('[soch] /lead failed', err);
        return { status: 'failed', error: err && err.name === 'AbortError' ? 'timeout' : 'network', booking_link: this.bookingUrl };
      } finally {
        clearTimeout(timeout);
      }
    }

    /**
     * Saves what we have when the conversation ends without the lead having
     * been sent (or with newer data since it was sent) — but only once we have
     * a confirmed email, i.e. enough to follow up. n8n stores it as "Partial",
     * notifies Riz once, and does not email the prospect.
     */
    _savePartialLead({ beacon = false } = {}) {
      const ld = this.leadData || {};
      // Only an email the prospect confirmed is worth saving — never one that
      // was misheard and not yet read back.
      if (!this.sessionId || !this.emailConfirmed || !EMAIL_RE.test(ld.email || '')) return;
      const payload = this._buildLeadPayload('session_end');
      const sig = this._leadSignature(payload);
      if (sig === this.storedLeadSig) return;
      this.storedLeadSig = sig; // one attempt per distinct payload
      const body = JSON.stringify(payload);
      // text/plain keeps sendBeacon/keepalive requests free of a CORS preflight.
      if (beacon && navigator.sendBeacon) {
        navigator.sendBeacon(`${BACKEND_URL}/lead`, new Blob([body], { type: 'text/plain' }));
        return;
      }
      fetch(`${BACKEND_URL}/lead`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true })
        .then((res) => res.json())
        .then((r) => { if (!r.lead_stored) this.storedLeadSig = null; })
        .catch((err) => { this.storedLeadSig = null; console.error('[soch] partial lead failed', err); });
    }

    async _lookupSochInfo(query) {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(`${BACKEND_URL}/rag/lookup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: query || '' }),
          signal: ctrl.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`lookup non-2xx: ${res.status}`);
        const data = await res.json();
        return data.context || 'No matching information found.';
      } catch (err) {
        console.error('[soch] lookup_soch_info failed', err);
        return "Lookup unavailable right now — tell the prospect that's exactly what the call with Riz is for.";
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Boot
  // ─────────────────────────────────────────────────────────────────────
  function boot() {
    injectFont();
    injectStyles();
    const widget = new SochWidget();
    // Programmatic API for host pages.
    window.SochVoiceWidget = {
      open:   () => widget.open(),
      close:  () => widget.close(),
      start:  () => widget.startSession(),
      end:    () => widget.endSession(),
      restart: () => widget.restart(),
      on:     (event, fn) => widget.on(event, fn),
      get isOpen()       { return widget.expanded; },
      get isSessionActive() { return widget.sessionActive; },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
