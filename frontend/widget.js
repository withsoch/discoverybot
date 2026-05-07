// Soch Automation Diagnostic — embeddable voice widget.
// Self-initializes on script load and injects its own DOM/CSS into the host
// page. Backend base URL is derived from the script src so the same bundle
// works regardless of which domain it's embedded on.

(function () {
  'use strict';

  if (window.__sochVoiceWidgetLoaded) return;
  window.__sochVoiceWidgetLoaded = true;

  // ---------- Locate backend ----------
  // The script is served from the same origin as /token, /lead and the audio
  // worklet. document.currentScript is reliable for non-async, defer'd loads.
  const scriptEl =
    document.currentScript ||
    Array.from(document.scripts).find((s) => /widget\.js(\?|$)/.test(s.src));
  let BACKEND_URL = window.location.origin;
  if (scriptEl && scriptEl.src) {
    try {
      const url = new URL(scriptEl.src);
      BACKEND_URL = url.origin;
    } catch (_) {}
  }

  // ---------- System prompt + tool definitions ----------
  const SYSTEM_PROMPT = `You are Soch's Automation Consultant — a sharp, friendly voice AI that conducts automated discovery calls for Soch (withsoch.com), a workflow automation agency. Your job is to run a structured 3-4 minute discovery conversation, assess the prospect's automation readiness, and warm them up for a strategy call.

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

  // ---------- Inject Google Font (DM Sans) ----------
  function injectFont() {
    if (document.querySelector('link[data-soch-font]')) return;
    const preconnect1 = document.createElement('link');
    preconnect1.rel = 'preconnect';
    preconnect1.href = 'https://fonts.googleapis.com';
    preconnect1.setAttribute('data-soch-font', '1');
    const preconnect2 = document.createElement('link');
    preconnect2.rel = 'preconnect';
    preconnect2.href = 'https://fonts.gstatic.com';
    preconnect2.crossOrigin = 'anonymous';
    preconnect2.setAttribute('data-soch-font', '1');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap';
    link.setAttribute('data-soch-font', '1');
    document.head.appendChild(preconnect1);
    document.head.appendChild(preconnect2);
    document.head.appendChild(link);
  }

  // ---------- Inject CSS (in case the host didn't add the <link>) ----------
  function injectStyles() {
    if (document.querySelector('link[data-soch-css]')) return;
    if (document.querySelector('style[data-soch-css]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${BACKEND_URL}/widget.css`;
    link.setAttribute('data-soch-css', '1');
    document.head.appendChild(link);
  }

  // ---------- DOM ----------
  const PHASES = ['Company', 'Operations', 'Tools', 'Pain Points', 'Score'];

  function buildDOM() {
    const root = document.createElement('div');
    root.id = 'soch-voice-widget';
    root.innerHTML = `
      <button class="soch-pill" type="button" aria-label="Open Soch Automation Diagnostic">
        Discover your automation potential →
      </button>
      <div class="soch-panel soch-hidden" role="dialog" aria-label="Soch Automation Diagnostic">
        <div class="soch-header">
          <div>
            <p class="soch-title">Automation Diagnostic</p>
            <p class="soch-subtitle">Powered by Soch</p>
          </div>
          <button class="soch-close" type="button" aria-label="Close">×</button>
        </div>

        <div class="soch-progress">
          <div class="soch-dots">
            ${PHASES.map(() => '<span class="soch-dot"></span>').join('')}
          </div>
          <div class="soch-phase-label"></div>
        </div>

        <div class="soch-viz-wrap">
          <div class="soch-bars">
            ${Array.from({ length: 7 }).map(() => '<span class="soch-bar"></span>').join('')}
          </div>
          <div class="soch-status">Tap to start</div>
        </div>

        <div class="soch-transcript" aria-live="polite"></div>

        <div class="soch-cta soch-hidden">
          <div class="soch-score-ring">
            <svg viewBox="0 0 128 128">
              <circle class="ring-bg" cx="64" cy="64" r="54" />
              <circle class="ring-fg" cx="64" cy="64" r="54"
                stroke-dasharray="339.292" stroke-dashoffset="339.292" />
            </svg>
            <div class="soch-score-num"><span class="num">0.0</span><span class="suffix">/10</span></div>
          </div>
          <div class="soch-tier"></div>
          <ul class="soch-opps"></ul>
        </div>

        <div class="soch-error soch-hidden"></div>

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

  // ---------- Widget controller ----------
  class SochWidget {
    constructor() {
      this.root = buildDOM();
      this.els = {
        pill: this.root.querySelector('.soch-pill'),
        panel: this.root.querySelector('.soch-panel'),
        close: this.root.querySelector('.soch-close'),
        dots: Array.from(this.root.querySelectorAll('.soch-dot')),
        phaseLabel: this.root.querySelector('.soch-phase-label'),
        bars: Array.from(this.root.querySelectorAll('.soch-bar')),
        barsWrap: this.root.querySelector('.soch-bars'),
        status: this.root.querySelector('.soch-status'),
        transcript: this.root.querySelector('.soch-transcript'),
        cta: this.root.querySelector('.soch-cta'),
        ringFg: this.root.querySelector('.ring-fg'),
        scoreNum: this.root.querySelector('.soch-score-num .num'),
        tier: this.root.querySelector('.soch-tier'),
        opps: this.root.querySelector('.soch-opps'),
        error: this.root.querySelector('.soch-error'),
        mic: this.root.querySelector('.soch-mic'),
        mainBtn: this.root.querySelector('.soch-main-btn'),
        restart: this.root.querySelector('.soch-restart'),
      };

      this.expanded = false;
      this.sessionActive = false;
      this.muted = false;
      this.phaseIndex = -1;
      this.leadData = {};
      this.client = null;
      this.streamer = null;
      this.player = null;
      this.aiSpeaking = false;
      this.userSpeaking = false;
      this.barsInterval = null;

      // Buffer streamed transcripts so we render one bubble per turn rather
      // than appending a new bubble for every transcription delta.
      this.userBubble = null;
      this.modelBubble = null;

      this._wireUI();
      this._renderPhase();
    }

    _wireUI() {
      this.els.pill.addEventListener('click', () => this.expand());
      this.els.close.addEventListener('click', () => this.collapse());
      this.els.mainBtn.addEventListener('click', () => this.toggleSession());
      this.els.mic.addEventListener('click', () => this.toggleMute());
      this.els.restart.addEventListener('click', () => this.restart());
    }

    expand() {
      this.expanded = true;
      this.els.pill.classList.add('soch-hidden');
      this.els.panel.classList.remove('soch-hidden');
      // Trigger transition on next frame.
      requestAnimationFrame(() => this.els.panel.classList.add('open'));
    }

    collapse() {
      if (this.sessionActive) this.endSession();
      this.expanded = false;
      this.els.panel.classList.remove('open');
      setTimeout(() => {
        this.els.panel.classList.add('soch-hidden');
        this.els.pill.classList.remove('soch-hidden');
      }, 280);
    }

    setError(text) {
      if (!text) {
        this.els.error.classList.add('soch-hidden');
        this.els.error.textContent = '';
        return;
      }
      this.els.error.textContent = text;
      this.els.error.classList.remove('soch-hidden');
    }

    setStatus(text) {
      this.els.status.textContent = text || '';
    }

    addMessage(role, text) {
      const div = document.createElement('div');
      div.className = `soch-msg ${role}`;
      div.textContent = text;
      this.els.transcript.appendChild(div);
      // Cap to last 6 messages.
      const msgs = this.els.transcript.querySelectorAll('.soch-msg');
      if (msgs.length > 6) {
        for (let i = 0; i < msgs.length - 6; i++) msgs[i].remove();
      }
      this.els.transcript.scrollTop = this.els.transcript.scrollHeight;
      return div;
    }

    appendUserTranscript(text, finished) {
      if (!text) return;
      if (!this.userBubble) {
        this.userBubble = this.addMessage('user', text);
      } else {
        this.userBubble.textContent = (this.userBubble.textContent || '') + text;
        this.els.transcript.scrollTop = this.els.transcript.scrollHeight;
      }
      if (finished) this.userBubble = null;
    }

    appendModelTranscript(text, finished) {
      if (!text) return;
      if (!this.modelBubble) {
        this.modelBubble = this.addMessage('ai', text);
      } else {
        this.modelBubble.textContent = (this.modelBubble.textContent || '') + text;
        this.els.transcript.scrollTop = this.els.transcript.scrollHeight;
      }
      if (finished) this.modelBubble = null;
    }

    _renderPhase() {
      this.els.dots.forEach((d, i) => {
        d.classList.toggle('active', i <= this.phaseIndex);
      });
      const label = this.phaseIndex >= 0 ? PHASES[this.phaseIndex] : '';
      this.els.phaseLabel.textContent = label;
    }

    advancePhase(targetIndex) {
      if (typeof targetIndex === 'number') {
        this.phaseIndex = Math.max(this.phaseIndex, targetIndex);
      } else {
        this.phaseIndex = Math.min(this.phaseIndex + 1, PHASES.length - 1);
      }
      this._renderPhase();
    }

    // ---------- Bars animation ----------
    _stopBars() {
      if (this.barsInterval) clearInterval(this.barsInterval);
      this.barsInterval = null;
      this.els.bars.forEach((b) => (b.style.height = '4px'));
      this.els.barsWrap.classList.remove('ai', 'user');
    }
    _setBarsMode(mode) {
      // mode: 'ai' | 'user' | 'idle'
      this._stopBars();
      if (mode === 'idle') return;
      this.els.barsWrap.classList.add(mode);
      const max = mode === 'ai' ? 28 : 14;
      this.barsInterval = setInterval(() => {
        this.els.bars.forEach((b) => {
          const h = Math.max(4, Math.floor(Math.random() * max));
          b.style.height = h + 'px';
        });
      }, 80);
    }

    // ---------- Score reveal ----------
    showScore(data) {
      this.els.cta.classList.remove('soch-hidden');
      const score = Number(data.score_out_of_10) || 0;
      const pct = Math.max(0, Math.min(1, score / 10));
      // r=54 → circumference = 2πr ≈ 339.292
      const circumference = 2 * Math.PI * 54;
      const offset = circumference * (1 - pct);
      // Force layout flush before transition.
      this.els.ringFg.getBoundingClientRect();
      this.els.ringFg.style.strokeDashoffset = String(offset);

      // Count up.
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
      [data.opportunity_1, data.opportunity_2, data.opportunity_3]
        .filter(Boolean)
        .forEach((o) => {
          const li = document.createElement('li');
          li.textContent = o;
          this.els.opps.appendChild(li);
        });
    }

    // ---------- Session lifecycle ----------
    async toggleSession() {
      if (this.sessionActive) {
        await this.endSession();
      } else {
        await this.startSession();
      }
    }

    async startSession() {
      this.setError('');
      this.setStatus('Connecting...');
      this.els.mainBtn.textContent = '...';
      this.els.mainBtn.disabled = true;

      try {
        const tokenRes = await fetch(`${BACKEND_URL}/token`, { method: 'GET' });
        if (!tokenRes.ok) throw new Error(`Token request failed (${tokenRes.status})`);
        const { token } = await tokenRes.json();
        if (!token) throw new Error('Token response missing');

        this.player = new window.SochAudioPlayer({
          sampleRate: 24000,
          onStateChange: (playing) => {
            this.aiSpeaking = playing;
            if (playing) {
              this.setStatus('Speaking...');
              this._setBarsMode('ai');
            } else if (this.sessionActive) {
              this.setStatus('Listening...');
              this._setBarsMode('idle');
            }
          },
        });
        await this.player.init();

        this.client = new window.SochGeminiLiveClient({
          model: 'models/gemini-3.1-flash-live-preview',
          systemInstruction: SYSTEM_PROMPT,
          tools: TOOL_DEFINITIONS,
          voiceName: 'Aoede',
          onAudioReceived: (b64) => this.player.enqueue(b64),
          onTranscriptUser: (t, fin) => this.appendUserTranscript(t, fin),
          onTranscriptModel: (t, fin) => this.appendModelTranscript(t, fin),
          onToolCall: (call) => this._handleToolCall(call),
          onTurnComplete: () => {
            this.modelBubble = null;
            this.userBubble = null;
            if (!this.aiSpeaking) {
              this.setStatus('Listening...');
              this._setBarsMode('idle');
            }
          },
          onInterrupted: () => {
            if (this.player) this.player.interrupt();
          },
          onOpen: () => {
            this.setStatus('Listening...');
          },
          onClose: () => {
            if (this.sessionActive) {
              this.setError('Connection closed. Tap restart to try again.');
              this._cleanupSession();
            }
          },
          onError: (err) => {
            console.error('[soch-voice-bot] gemini error', err);
            this.setError('Connection error. Please try again.');
          },
        });

        await this.client.connect(token);

        this.streamer = new window.SochAudioStreamer({
          workletUrl: `${BACKEND_URL}/audio-processor.js`,
          onChunk: (b64) => this.client.sendAudio(b64),
          onLevel: (rms) => {
            // Light up "user speaking" only when not currently being spoken to.
            if (!this.aiSpeaking) {
              const speaking = rms > 0.02;
              if (speaking !== this.userSpeaking) {
                this.userSpeaking = speaking;
                this._setBarsMode(speaking ? 'user' : 'idle');
                this.setStatus(speaking ? 'Listening...' : 'Listening...');
              }
            }
          },
        });
        try {
          await this.streamer.start();
        } catch (micErr) {
          console.error('[soch-voice-bot] mic error', micErr);
          this.setError(
            'Microphone access is needed for the voice experience. Please enable it in your browser and try again.'
          );
          await this._cleanupSession();
          this.els.mainBtn.disabled = false;
          this.els.mainBtn.textContent = 'START';
          return;
        }

        this.sessionActive = true;
        this.els.mainBtn.disabled = false;
        this.els.mainBtn.textContent = 'END';
        this.els.mainBtn.classList.add('active');
        this.advancePhase(0);
      } catch (err) {
        console.error('[soch-voice-bot] startSession failed', err);
        this.setError(err.message || 'Could not start session.');
        await this._cleanupSession();
        this.els.mainBtn.disabled = false;
        this.els.mainBtn.textContent = 'START';
      }
    }

    async endSession() {
      await this._cleanupSession();
      this.setStatus('Tap to start');
    }

    async _cleanupSession() {
      this.sessionActive = false;
      this.els.mainBtn.classList.remove('active');
      this.els.mainBtn.textContent = 'START';
      this._stopBars();
      if (this.streamer) {
        try { await this.streamer.stop(); } catch (_) {}
        this.streamer = null;
      }
      if (this.client) {
        try { this.client.disconnect(); } catch (_) {}
        this.client = null;
      }
      if (this.player) {
        try { await this.player.close(); } catch (_) {}
        this.player = null;
      }
    }

    async restart() {
      await this._cleanupSession();
      this.leadData = {};
      this.phaseIndex = -1;
      this._renderPhase();
      this.els.transcript.innerHTML = '';
      this.els.cta.classList.add('soch-hidden');
      this.els.ringFg.style.strokeDashoffset = '339.292';
      this.els.scoreNum.textContent = '0.0';
      this.setError('');
      this.setStatus('Tap to start');
      this.userBubble = null;
      this.modelBubble = null;
    }

    toggleMute() {
      this.muted = !this.muted;
      if (this.streamer) this.streamer.setMuted(this.muted);
      this.els.mic.classList.toggle('muted', this.muted);
      this.els.mic.title = this.muted ? 'Unmute' : 'Mute';
    }

    // ---------- Tool calls ----------
    async _handleToolCall(call) {
      const { id, name, args } = call;
      const safeArgs = args || {};
      let output = 'success';

      try {
        switch (name) {
          case 'capture_company_info':
            Object.assign(this.leadData, {
              company_name: safeArgs.company_name,
              team_size: safeArgs.team_size,
              industry: safeArgs.industry,
            });
            this.advancePhase(1);
            output = 'captured';
            break;

          case 'capture_operations_data':
            Object.assign(this.leadData, {
              main_processes: safeArgs.main_processes,
              highest_frequency_task: safeArgs.highest_frequency_task,
              tools_used: safeArgs.tools_used,
              tool_count: safeArgs.tool_count,
            });
            this.advancePhase(2);
            output = 'captured';
            break;

          case 'capture_pain_points':
            Object.assign(this.leadData, {
              main_bottleneck: safeArgs.main_bottleneck,
              automation_dream: safeArgs.automation_dream,
              pain_specificity: safeArgs.pain_specificity,
            });
            this.advancePhase(3);
            output = 'captured';
            break;

          case 'calculate_score':
            Object.assign(this.leadData, {
              score_out_of_10: safeArgs.score_out_of_10,
              tier: safeArgs.tier,
              opportunities: [
                safeArgs.opportunity_1,
                safeArgs.opportunity_2,
                safeArgs.opportunity_3,
              ].filter(Boolean),
              score_rationale: safeArgs.score_rationale,
            });
            this.showScore(safeArgs);
            this.advancePhase(4);
            output = 'displayed';
            break;

          case 'capture_lead':
            Object.assign(this.leadData, {
              name: safeArgs.name,
              email: safeArgs.email,
            });
            output = 'captured';
            break;

          case 'send_to_crm':
            await this._postLead();
            output = 'sent';
            break;

          default:
            console.warn('[soch-voice-bot] unknown tool call', name);
            output = 'unknown';
        }
      } catch (err) {
        console.error('[soch-voice-bot] tool handler error', name, err);
        output = 'error';
      }

      if (this.client) this.client.sendToolResponse(id, name, { output });
    }

    async _postLead() {
      const ld = this.leadData || {};
      const payload = {
        source: 'voice_diagnostic_widget',
        timestamp: new Date().toISOString(),
        contact: { name: ld.name, email: ld.email },
        company: {
          name: ld.company_name,
          team_size: ld.team_size,
          industry: ld.industry,
        },
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
      try {
        const res = await fetch(`${BACKEND_URL}/lead`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) console.warn('[soch-voice-bot] /lead non-2xx', res.status);
      } catch (err) {
        console.error('[soch-voice-bot] /lead failed', err);
      }
    }
  }

  // ---------- Boot ----------
  function boot() {
    injectFont();
    injectStyles();
    new SochWidget();
  }

  function loadScripts() {
    // Load helper scripts in order. They each attach a single global to window.
    const deps = [
      `${BACKEND_URL}/audio-streamer.js`,
      `${BACKEND_URL}/audio-player.js`,
      `${BACKEND_URL}/gemini-live.js`,
    ];
    let i = 0;
    function next() {
      if (i >= deps.length) return boot();
      const s = document.createElement('script');
      s.src = deps[i++];
      s.async = false;
      s.onload = next;
      s.onerror = () => {
        console.error('[soch-voice-bot] failed to load', s.src);
      };
      document.head.appendChild(s);
    }
    next();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadScripts, { once: true });
  } else {
    loadScripts();
  }
})();
