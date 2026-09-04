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

  const PHASES = ['Company', 'Operations', 'Tools', 'Pain Points', 'Score'];
  const RING_CIRCUMFERENCE = 2 * Math.PI * 54; // r=54

  const SYSTEM_PROMPT = `You are Soch's Automation Consultant — a sharp, friendly voice AI that conducts automated discovery calls for Soch (withsoch.com), a workflow automation agency. Your job is to run a structured 3-4 minute discovery conversation, assess the prospect's automation readiness, and warm them up for a strategy call.

ABOUT SOCH (only use this if the prospect directly asks about the company — never volunteer it, and never invent facts beyond what's here):
- Soch is an AI automation partner for early-stage to Series A businesses — SaaS, retail, professional services, manufacturing, distribution, and B2B services. Tagline: "More Growth, Less Chaos."
- Services: AI Agent Development, Operations & Process Automation, Customer Support Automation, Marketing Automation, and RevOps Automation.
- Process: a 3-step "Audit → Design → Build & deploy" framework.
- Riz leads automation strategy at Soch — he's who prospects get booked with for the follow-up call.
- Based in Tallinn, Estonia. Contact: info@withsoch.com.
- If asked about pricing: give the general shape only — engagements range from a focused automation audit up through multi-week build and full "Automation OS" engagements — and say Riz will go over exact pricing for their specific needs on the call. Never quote a specific dollar figure.
- If asked something about Soch not covered here (case studies, specific past clients, team beyond Riz, etc.): don't guess — say that's exactly what the call with Riz is for, and redirect back to the discovery questions.

PERSONALITY:
- Sound like a smart, experienced consultant — not a chatbot
- Conversational, warm, direct
- Ask ONE question at a time
- Never list multiple questions at once
- Acknowledge what they say before moving on ("Got it", "That makes sense", "Interesting")
- Keep your turns short — 1-3 sentences max
- Do not mention scores, functions, or tools — these are invisible to the user

DISCOVERY FLOW (follow this sequence strictly):

PHASE 1 — OPENER
Start with: "Hey there! I'm Soch's automation consultant. I'll ask you six quick questions about how your team works — takes about three minutes — and at the end I'll tell you exactly which processes you could automate and what that would save you. What does your company do, and roughly how many people are on your team?"
→ When answered: call capture_company_info() then continue to Phase 2.

PHASE 2 — OPERATIONS
Ask: "Walk me through a typical week for your ops team — what are the main tasks they handle regularly?"
→ Follow up: "Which of those happens most often?"
→ When answered: continue to Phase 3.

PHASE 3 — TOOLS
Ask: "What tools does your team use day-to-day — things like your CRM, project management, email, spreadsheets?"
→ When answered: call capture_operations_data() then continue to Phase 4.

PHASE 4 — PAIN POINTS
Ask: "Where does work tend to slow down or fall through the cracks?"
→ Follow up: "If you could make one thing in your operations just happen automatically, what would it be?"
→ When answered: call capture_pain_points() then immediately call calculate_score() and move to Phase 5.

PHASE 5 — SCORE DELIVERY
Deliver the score verbally, naturally. Example: "Based on everything you've shared, your team scores [SCORE] out of 10 on automation readiness — that puts you in [TIER]. The three areas I'd prioritize for you are: [OPPORTUNITY_1], [OPPORTUNITY_2], and [OPPORTUNITY_3]. I'd love to get you on a 30-minute call with Riz, Soch's head of automation, where he can map these out in detail — completely free. What's your name and email so I can send you the booking link?"
→ When they share name + email: call capture_lead() then call send_to_crm()
→ Close: "Perfect. You'll get an email from Riz within 24 hours. Genuinely good chatting with you."

RULES:
- Never say "as an AI" or reference being a language model
- If they go off topic, gently redirect: "That's worth exploring on the call — for now, let me ask you..."
- If they decline to give email: "Totally fine — you can also find us at withsoch.com. Good luck with everything."
- Never rush. Let them finish speaking before responding.`;

  // Wire-format note: the JS/REST surface of the Live API uses camelCase.
  // (`functionDeclarations`, not `function_declarations`.)
  const TOOL_DEFINITIONS = [
    {
      name: 'capture_company_info',
      description:
        'Called after learning the company name, size, and industry. Records basic company context.',
      parameters: {
        type: 'object',
        properties: {
          company_name: { type: 'string', description: 'Name of the company if mentioned' },
          team_size: { type: 'string', description: "Number of people on the team (e.g. '12', '50-100')" },
          industry: { type: 'string', description: 'What the company does / industry' },
        },
        required: ['team_size', 'industry'],
      },
    },
    {
      name: 'capture_operations_data',
      description:
        "Called after learning about the company's main processes and tools. Records operational context.",
      parameters: {
        type: 'object',
        properties: {
          main_processes: { type: 'string', description: 'Comma-separated list of main recurring tasks/processes' },
          highest_frequency_task: { type: 'string', description: 'The task that happens most often' },
          tools_used: { type: 'string', description: 'Comma-separated list of tools (CRM, PM, etc.)' },
          tool_count: { type: 'number', description: 'Approximate number of distinct tools mentioned' },
        },
        required: ['main_processes', 'tools_used'],
      },
    },
    {
      name: 'capture_pain_points',
      description: 'Called after learning about bottlenecks and automation desires.',
      parameters: {
        type: 'object',
        properties: {
          main_bottleneck: { type: 'string', description: 'Where work slows down or breaks' },
          automation_dream: { type: 'string', description: 'The one thing they wish happened automatically' },
          pain_specificity: {
            type: 'string',
            enum: ['vague', 'moderate', 'specific'],
            description: 'How clearly they can articulate the pain',
          },
        },
        required: ['main_bottleneck', 'pain_specificity'],
      },
    },
    {
      name: 'calculate_score',
      description:
        'Called after all discovery phases are complete. Computes the Automation Readiness Score and identifies top 3 opportunities. Returns score data to display in the UI.',
      parameters: {
        type: 'object',
        properties: {
          score_out_of_10: {
            type: 'number',
            description:
              'Automation readiness score from 1-10 based on team size fit, process volume, tool fragmentation, pain specificity',
          },
          tier: {
            type: 'string',
            enum: ['HIGH READINESS', 'MEDIUM READINESS', 'EARLY STAGE'],
          },
          opportunity_1: {
            type: 'string',
            description: "Top automation opportunity — be specific e.g. 'Lead follow-up sequences from CRM'",
          },
          opportunity_2: { type: 'string', description: 'Second automation opportunity' },
          opportunity_3: { type: 'string', description: 'Third automation opportunity' },
          score_rationale: { type: 'string', description: '1 sentence explaining why this score' },
        },
        required: ['score_out_of_10', 'tier', 'opportunity_1', 'opportunity_2', 'opportunity_3'],
      },
    },
    {
      name: 'capture_lead',
      description: 'Called when the prospect shares their name and email.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['name', 'email'],
      },
    },
    {
      name: 'send_to_crm',
      description: "Called after lead is captured. Sends full lead profile to Soch's CRM via backend.",
      parameters: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean', description: 'Always true — confirms all data is ready to send' },
        },
        required: ['confirmed'],
      },
    },
  ];

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
      this.systemInstruction = opts.systemInstruction || '';
      this.tools = opts.tools || [];
      this.voiceName = opts.voiceName || 'Aoede';
      this.cb = {
        onAudio: opts.onAudio || (() => {}),
        onUserTranscript: opts.onUserTranscript || (() => {}),
        onModelTranscript: opts.onModelTranscript || (() => {}),
        onToolCall: opts.onToolCall || (() => {}),
        onTurnComplete: opts.onTurnComplete || (() => {}),
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
          // camelCase wire format per current Gemini Live spec.
          const setup = {
            setup: {
              model: this.model.startsWith('models/')
                ? this.model
                : `models/${this.model}`,
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: this.voiceName },
                  },
                },
              },
              systemInstruction: { parts: [{ text: this.systemInstruction }] },
              tools: this.tools.length
                ? [{ functionDeclarations: this.tools }]
                : undefined,
              inputAudioTranscription: {},
              outputAudioTranscription: {},
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
            } else if (part.text) {
              this.cb.onModelTranscript(part.text, false);
            }
          }
        }
        if (sc.turnComplete || sc.generationComplete) this.cb.onTurnComplete();
      }

      if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
        for (const call of msg.toolCall.functionCalls) this.cb.onToolCall(call);
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

    sendToolResponse(id, name, response) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({
        toolResponse: {
          functionResponses: [{
            id, name,
            response: typeof response === 'object' ? response : { output: response },
          }],
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
      if (!this.userBubble) this.userBubble = this.addMessage('user', text);
      else {
        this.userBubble.textContent += text;
        this.els.transcript.scrollTop = this.els.transcript.scrollHeight;
      }
      if (finished) this.userBubble = null;
    }

    appendModelTranscript(text, finished) {
      if (!text) return;
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
        const { token, model } = await this._fetchToken();

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
          systemInstruction: SYSTEM_PROMPT,
          tools: TOOL_DEFINITIONS,
          voiceName: 'Aoede',
          onAudio: (b64) => this.player.enqueue(b64).catch(console.error),
          onUserTranscript: (t, fin) => this.appendUserTranscript(t, fin),
          onModelTranscript: (t, fin) => this.appendModelTranscript(t, fin),
          onToolCall: (call) => this._handleToolCall(call),
          onTurnComplete: () => {
            // Don't reset bubbles here — `finished` flag does that. We just
            // refresh the status indicator if the model isn't speaking.
            if (!this.aiSpeaking && this.sessionActive) {
              this.setStatus('Listening…');
              this._setBarsMode(this.userSpeaking ? 'user' : 'idle');
            }
          },
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
        this.client.sendText('(Session started. Begin the discovery call now, exactly as instructed.)');

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
    async _handleToolCall(call) {
      const { id, name, args } = call || {};
      const a = args || {};
      let response = { output: 'success' };
      try {
        switch (name) {
          case 'capture_company_info':
            Object.assign(this.leadData, {
              company_name: a.company_name,
              team_size: a.team_size,
              industry: a.industry,
            });
            this.advancePhase(1);
            response = { output: 'captured' };
            break;
          case 'capture_operations_data':
            Object.assign(this.leadData, {
              main_processes: a.main_processes,
              highest_frequency_task: a.highest_frequency_task,
              tools_used: a.tools_used,
              tool_count: a.tool_count,
            });
            this.advancePhase(2);
            response = { output: 'captured' };
            break;
          case 'capture_pain_points':
            Object.assign(this.leadData, {
              main_bottleneck: a.main_bottleneck,
              automation_dream: a.automation_dream,
              pain_specificity: a.pain_specificity,
            });
            this.advancePhase(3);
            response = { output: 'captured' };
            break;
          case 'calculate_score':
            Object.assign(this.leadData, {
              score_out_of_10: a.score_out_of_10,
              tier: a.tier,
              opportunities: [a.opportunity_1, a.opportunity_2, a.opportunity_3].filter(Boolean),
              score_rationale: a.score_rationale,
            });
            this.showScore(a);
            this.advancePhase(4);
            response = { output: 'displayed' };
            break;
          case 'capture_lead':
            Object.assign(this.leadData, { name: a.name, email: a.email });
            response = { output: 'captured' };
            break;
          case 'send_to_crm':
            await this._postLead();
            response = { output: 'sent' };
            break;
          default:
            console.warn('[soch] unknown tool', name);
            response = { output: 'unknown' };
        }
      } catch (err) {
        console.error('[soch] tool handler error', name, err);
        response = { output: 'error' };
      }
      if (this.client) this.client.sendToolResponse(id, name, response);
    }

    async _postLead() {
      const ld = this.leadData || {};
      const payload = {
        source: 'voice_diagnostic_widget',
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
      this._emit('lead', payload);
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(`${BACKEND_URL}/lead`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) console.warn('[soch] /lead non-2xx', res.status);
      } catch (err) {
        console.error('[soch] /lead failed', err);
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
