# Soch Automation Diagnostic — Voice AI Widget

A production-ready, embeddable voice widget for [withsoch.com](https://withsoch.com). It conducts a structured 3–4 minute voice discovery call, scores the prospect's automation readiness, identifies their top three opportunities, and ships the lead to n8n.

- **Stack**: Node.js + Express backend, vanilla JS embeddable widget
- **Voice**: Gemini Live API (`gemini-3.1-flash-live-preview`) over a direct browser WebSocket using ephemeral tokens
- **Lead delivery**: HTTP POST to your n8n webhook
- **Embed**: a single `<script>` tag — works in Webflow with zero configuration

---

## Quick start (local)

```bash
git clone <this repo>
cd discoverybot
cp .env.example .env       # then fill in GEMINI_API_KEY and N8N_WEBHOOK_URL
npm install
npm run dev                # http://localhost:3000
```

Visit `http://localhost:3000` and the widget will appear in the bottom-right corner. Click it to expand and tap **START** to begin.

> Microphone access requires HTTPS in production. `localhost` is exempted by browsers, so dev works without a cert.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Google AI Studio key. Used server-side only; never sent to the browser. |
| `N8N_WEBHOOK_URL` | yes (prod) | n8n webhook that receives the final lead JSON. |
| `PORT` | no | Defaults to `3000`. |

---

## Deployment

Deploy `server.js` to any Node host that gives you HTTPS out of the box — Railway, Render, Fly.io, or your own nginx-fronted VM all work. Set the env vars and you're done. The same backend serves both the API endpoints (`/token`, `/lead`) and the static widget files (`/widget.js`, `/widget.css`, `/audio-processor.js`, etc.).

The widget figures out its backend URL from the `<script src>` it was loaded from, so you only have one URL to configure.

---

## Webflow embed

In Webflow, open **Project Settings → Custom Code → Footer Code** (or drop a Custom Code embed onto a single page) and paste:

```html
<link rel="stylesheet" href="https://your-domain.com/widget.css">
<script src="https://your-domain.com/widget.js" defer></script>
```

That's it. The widget injects itself into `document.body`, positions itself fixed bottom-right, and self-initializes. No other markup or JS hooks are required. CSS is namespaced under `#soch-voice-widget`, so it cannot bleed into the rest of your Webflow page.

The `<link>` is optional — if you only include the `<script>`, the widget will inject the stylesheet itself. Including it explicitly avoids a brief flash of unstyled content.

---

## Architecture

```
Browser (widget)
   │
   │  GET /token      ─────────►  Express ──► Gemini API (auth tokens)
   │  ◄────────────  { token }
   │
   │  WebSocket  ────────────────────────────►  Gemini Live API
   │  PCM16 @16kHz audio in / PCM16 @24kHz audio out
   │  + tool calls, transcripts
   │
   │  POST /lead     ──────────►  Express  ──►  n8n webhook
```

### Files

| File | Role |
| --- | --- |
| `server.js` | Express app: serves frontend, mints ephemeral tokens, forwards leads to n8n. |
| `frontend/widget.js` | Self-injecting widget. State machine, UI, tool handling. |
| `frontend/gemini-live.js` | WebSocket client for Gemini Live. |
| `frontend/audio-streamer.js` | Mic capture → PCM16 @ 16kHz → base64. AudioWorklet with ScriptProcessor fallback. |
| `frontend/audio-processor.js` | AudioWorklet processor (loaded as a separate URL by the browser). |
| `frontend/audio-player.js` | Queued playback of PCM16 @ 24kHz from Gemini. |
| `frontend/widget.css` | Namespaced styles. |
| `frontend/index.html` | Local-dev test harness. |

### Discovery flow & tool calls

The widget exposes six function tools to Gemini. Their order drives the on-screen progress dots:

1. `capture_company_info` → advances to **Operations**
2. `capture_operations_data` → advances to **Tools**
3. `capture_pain_points` → advances to **Pain Points**
4. `calculate_score` → reveals the score ring + opportunities, advances to **Score**
5. `capture_lead`
6. `send_to_crm` → POSTs the lead JSON to `/lead`, which forwards to n8n.

Phases advance based on actual tool calls, not a timer.

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

## Security notes

- **The Gemini API key never leaves the server.** The browser only ever sees a single-use ephemeral token that expires in 60 seconds.
- A fresh ephemeral token is fetched every time the user taps **START**.
- CORS is open by design — this is meant to be embedded on `withsoch.com` and tested from local dev. Lock down `cors()` origins if you want to restrict.

## Browser support

Chrome, Edge, Safari 14+, Firefox 76+. The widget prefers `AudioWorklet` and falls back to `ScriptProcessorNode` on browsers that don't support it.

## Troubleshooting

- **"Microphone access is needed..."** — the user denied mic permission. They need to re-enable it in the browser site settings.
- **Connection closes immediately** — usually a missing/expired token or wrong model string. Check server logs for `/token` errors and verify `GEMINI_API_KEY` is valid.
- **No audio playing** — Safari and some browsers require a user gesture before `AudioContext` can start. The widget kicks the AudioContext on the START tap, so make sure that's the only entrypoint.
