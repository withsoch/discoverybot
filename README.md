# Soch Automation Diagnostic — Voice AI Widget

Embeddable voice widget for [withsoch.com](https://withsoch.com). Conducts a structured 3–4 minute voice discovery call, scores the prospect's automation readiness, identifies their top three opportunities, and ships the lead to n8n.

- **Stack**: Node.js + Express backend, vanilla JS embeddable widget (no framework, no build step)
- **Voice**: Gemini Live API over a direct browser WebSocket using single-use ephemeral tokens (requires `@google/genai` ≥ 1.20 — ephemeral tokens are unavailable in 0.x)
- **Lead delivery**: HTTP POST to your n8n webhook, with retry + backoff
- **Embed**: a single `<script>` tag — works in Webflow with zero configuration

## Status (as of Sept 2026)

- ✅ Core flow works and has been manually tested end-to-end: connects, runs the full 6-question discovery script, scores readiness, captures a lead.
- ✅ Three connection bugs that previously broke every session have been fixed (see [Troubleshooting](#troubleshooting)).
- ✅ System prompt now includes real facts about Soch (services, process, Riz, location) pulled from withsoch.com, so the bot can answer basic company questions instead of deflecting or inventing answers.
- ⚠️ **`N8N_WEBHOOK_URL` is not yet configured** — leads reach `/lead` and get logged server-side, but nothing is forwarded anywhere permanent until a real webhook URL is set.
- ⚠️ **Not deployed / not embedded on withsoch.com yet** — dev/local testing only. Do not add the embed script to the live site until this is explicitly approved.
- ⚠️ Data is only saved at the very end of the call (`send_to_crm`, the last tool call) — if a visitor abandons the call early, nothing captured up to that point is persisted anywhere.

---

## Quick start

```bash
git clone <this repo>
cd discoverybot
cp .env.example .env       # then fill in GEMINI_API_KEY and N8N_WEBHOOK_URL
npm install
npm run dev                # http://localhost:3000
```

Visit `http://localhost:3000`, click the pill, then **START**.

> Microphone access requires HTTPS in production. `localhost` is exempt by browsers, so dev works without a cert.

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | yes | — | Google AI Studio key. Used server-side only; never sent to the browser. |
| `N8N_WEBHOOK_URL` | yes (prod) | — | n8n webhook that receives final leads. |
| `GEMINI_MODEL` | no | `gemini-3.1-flash-live-preview` | Override the Live model without touching code. |
| `PORT` | no | `3000` | HTTP port. |
| `TOKEN_TTL_MS` | no | `1800000` (30 min) | Ephemeral token absolute expiration. |
| `SESSION_START_TTL_MS` | no | `120000` (2 min) | How long the user has after fetching a token to start the WebSocket session. |

---

## Webflow embed

In Webflow, open **Project Settings → Custom Code → Footer Code** (or drop a Custom Code embed onto a single page) and paste:

```html
<script src="https://your-domain.com/widget.js" defer></script>
```

That's it. The widget self-injects DOM, fonts, and stylesheet. CSS is namespaced under `#soch-voice-widget` so it cannot bleed into your Webflow page. The widget also discovers its backend URL from the `<script src>`, so the same bundle works on any embed origin without configuration.

If you want to avoid a brief flash of unstyled pill on first paint, also include the stylesheet:

```html
<link rel="stylesheet" href="https://your-domain.com/widget.css">
<script src="https://your-domain.com/widget.js" defer></script>
```

### Programmatic API

After the script loads, host pages can drive the widget from CTA buttons:

```js
SochVoiceWidget.open();          // expand the panel
SochVoiceWidget.close();         // collapse to pill
SochVoiceWidget.start();         // begin a session
SochVoiceWidget.end();           // end the active session
SochVoiceWidget.restart();       // reset and start fresh

SochVoiceWidget.on('lead', (payload) => {
  // Mirror the lead to your own analytics, chat, etc.
});
SochVoiceWidget.on('phase', (i) => console.log('phase', i));
```

Events: `open`, `close`, `start`, `end`, `restart`, `mute`, `phase`, `score`, `lead`.

---

## Architecture

```
Browser (widget.js + audio-processor.js)
   │
   │  GET /token       ─► Express ─► Gemini API (ai.authTokens.create)
   │  ◄──── { token, model }
   │
   │  WebSocket ──────────────────────────► Gemini Live API
   │  PCM16 @16kHz audio in / PCM16 @24kHz audio out
   │  + tool calls, transcripts, VAD-driven turns
   │
   │  POST /lead       ─► Express ─► n8n webhook (with retry + backoff)
```

### Files

| File | Role |
| --- | --- |
| `server.js` | Express app: serves frontend, mints ephemeral tokens (locked to model + AUDIO modality), forwards leads to n8n with 3-attempt exponential backoff. Rate-limits `/token` and `/lead`. |
| `frontend/widget.js` | Single-file bundle: AudioStreamer + AudioPlayer + GeminiLiveClient + UI controller. ~50KB unminified. |
| `frontend/audio-processor.js` | Standalone AudioWorklet processor (must be served at its own URL). |
| `frontend/widget.css` | Namespaced styles. |
| `frontend/index.html` | Local-dev test harness. |

### Wire format

The Gemini Live JSON wire format is **camelCase** end-to-end (snake_case is Python-SDK only). The widget speaks the current spec verbatim:

| Field | Notes |
| --- | --- |
| `setup.generationConfig.responseModalities` | `["AUDIO"]` |
| `setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` | `Aoede` (configurable in widget.js) |
| `setup.systemInstruction.parts[].text` | The discovery prompt |
| `setup.tools[0].functionDeclarations` | All six tool schemas |
| `setup.inputAudioTranscription` / `outputAudioTranscription` | Both enabled |
| `realtimeInput.audio` | `{ data: <base64>, mimeType: "audio/pcm;rate=16000" }` — replaces the deprecated `mediaChunks` |
| WS method | `BidiGenerateContentConstrained`, **not** plain `BidiGenerateContent` — the plain method only accepts a raw API key, not an ephemeral token |
| WS auth param | `access_token=<ephemeral token>`, **not** `key=` (that's for raw API keys) |
| `toolResponse.functionResponses[]` | `{ id, name, response: { output } }` |
| Server: `serverContent.modelTurn.parts[].inlineData` | PCM16 @ 24 kHz audio |
| Server: `serverContent.{inputTranscription,outputTranscription}` | Streamed deltas with `finished` flag |
| Server: `toolCall.functionCalls[]` | `{ id, name, args }` |
| Server: `goAway` | Surfaced to UI; session ends gracefully |

### Discovery flow & tool calls

The widget exposes six function tools. The order they fire in drives the on-screen progress dots:

1. `capture_company_info` → advances to **Operations**
2. `capture_operations_data` → advances to **Tools**
3. `capture_pain_points` → advances to **Pain Points**
4. `calculate_score` → reveals the score ring + opportunities, advances to **Score**
5. `capture_lead`
6. `send_to_crm` → POSTs the lead JSON to `/lead`, which forwards to n8n.

Phases advance on actual tool calls, not a timer.

### System prompt & company knowledge

The full script lives in `SYSTEM_PROMPT` in `frontend/widget.js`. It has two parts:

1. **The discovery script** — the 6-phase flow above, verbatim opener line, tone rules, and how to handle off-topic questions / declined emails.
2. **An "ABOUT SOCH" block** — real facts pulled from withsoch.com (services, the Audit → Design → Build & deploy process, Riz as the automation lead, Tallinn location, contact email), used *only* when a prospect asks about the company. Pricing is deliberately kept qualitative — the homepage and services page list different numbers for the same tiers — so the bot defers exact quotes to the call with Riz instead of risking a wrong figure. The bot is instructed never to invent anything beyond what's listed here; if asked something not covered (case studies, past clients, team beyond Riz), it says that's what the call is for and redirects back to its questions.

If Soch's public site content changes (new services, pricing, team), update this block to keep the bot's answers accurate.

### Lead payload (POSTed to n8n)

```json
{
  "source": "voice_diagnostic_widget",
  "timestamp": "2026-05-07T12:34:56.000Z",
  "contact":   { "name": "...", "email": "..." },
  "company":   { "name": "...", "team_size": "...", "industry": "..." },
  "operations":{ "main_processes": "...", "highest_frequency_task": "...", "tools_used": "...", "tool_count": 0 },
  "pain":      { "main_bottleneck": "...", "automation_dream": "...", "pain_specificity": "specific" },
  "score":     { "score_out_of_10": 8.2, "tier": "HIGH READINESS", "opportunities": ["...", "...", "..."], "rationale": "..." }
}
```

---

## Performance & robustness notes

- **Single-file bundle** — frontend ships as one JS file (plus the worklet, which has to be a separate URL by spec). One round trip on first paint.
- **Ephemeral tokens locked down** — server passes `liveConnectConstraints: { model, config: { responseModalities: ['AUDIO'] } }` so even an intercepted token can only start an audio session with the configured model.
- **Hysteresis on user-speaking detection** — the mic-meter doesn't flap at the threshold; rises at 0.025 RMS, falls at 0.012.
- **RAF-driven waveform animation** — replaces `setInterval` polling; pauses with the tab and is GPU-friendly.
- **Gapless playback** — incoming audio chunks are scheduled on the AudioContext clock, so bursty network frames still play back-to-back.
- **Sample-rate fallback** — Safari sometimes refuses to create a 16 kHz `AudioContext`. The widget falls back to the device rate and resamples in software.
- **PII redaction in logs** — `/lead` logs `name: "T***"`, `email: "te***@domain"` — full payload only goes to n8n.
- **Rate limiting** — 30/min/IP on `/token`, 10/min/IP on `/lead`.
- **n8n retry** — 3 attempts with 250 ms / 500 ms / 1 s backoff on 5xx and 429.
- **AbortController on every fetch** — no hung UI on slow networks.
- **Idempotent cleanup** — concurrent `endSession()` and `ws.onclose` are safe.

## Security notes

- The Gemini API key never leaves the server.
- A fresh ephemeral token is fetched every time the user taps **START**.
- CORS is open by design (the widget is meant to be embedded on `withsoch.com` and tested from local dev). Lock down `cors()` origins for `/lead` if you want to restrict.

## Browser support

Chrome, Edge, Safari 14+, Firefox 76+. Prefers `AudioWorklet`, falls back to `ScriptProcessorNode` on browsers without it.

## Troubleshooting

- **"Microphone access is needed…"** — user denied mic permission. They need to re-enable it in browser site settings.
- **Connection closes immediately** — usually an expired token or a bad model ID. Check server logs and verify `GEMINI_API_KEY` and `GEMINI_MODEL`.
- **Server returns 503 / model 404** — the configured model isn't enabled on your project. Set `GEMINI_MODEL=gemini-2.5-flash-native-audio-preview-09-2025` (or another live-capable model) and restart.
- **No audio playing on Safari** — Safari requires a user gesture before `AudioContext` can start. The widget triggers it on the START tap; make sure that's the only entrypoint.
- **`WebSocket closed before setup (code 1007: API key not valid...)` even with a good key** — this bit us during testing and cost a lot of debugging time, so noting it explicitly: ephemeral-token sessions **must** connect to `BidiGenerateContentConstrained` with the token passed as `access_token=`. Connecting to plain `BidiGenerateContent` (even with a valid token) or passing the token as `key=` gets rejected with this exact misleading "API key not valid" message. Both are already fixed in `widget.js`, but if you see this error again after editing the WS URL, check those two things first.
- **`liveConnectConstraints.model` mismatch** — the model string the server locks a minted token to (`server.js`) must exactly match what the client sends in its `setup` message (`widget.js`, which prefixes with `models/`). A mismatch closes the socket the same way as the bug above.
- **Bot connects but says nothing** — the model doesn't speak first on its own. `widget.js` sends a hidden kickoff turn right after `connect()` to trigger its scripted opener; if that call is ever removed, the bot will sit silently waiting for the user to speak first instead.
