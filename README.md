# Soch Automation Diagnostic — Voice AI Widget

Embeddable voice widget for [withsoch.com](https://withsoch.com). Conducts a structured 3–4 minute voice discovery call, scores the prospect's automation readiness, identifies their top three opportunities, and sends the prospect the link to book a free 30-minute call with Riz (Soch's co-founder) — at the end of the diagnostic, or at any point they ask.

- **Stack**: Node.js + Express backend, vanilla JS embeddable widget (no framework, no build step)
- **Voice**: Gemini Live API over a direct browser WebSocket using single-use ephemeral tokens (requires `@google/genai` ≥ 1.20 — ephemeral tokens are unavailable in 0.x)
- **Lead delivery**: `/lead` → secret-protected n8n webhook → ClickUp + Google Sheets + Gmail, with per-step success reported back to the bot (see [Lead capture & booking flow](#lead-capture--booking-flow))
- **Booking**: the existing Cal.com 30-minute event, [`cal.com/consult-with-riz/sochwork`](https://cal.com/consult-with-riz/sochwork). The prospect picks their own time; the bot never books a slot.
- **Embed**: a single `<script>` tag — works in Webflow with zero configuration

## Status (as of Sept 2026)

- ✅ Core flow works and has been manually tested end-to-end: connects, runs the full 6-question discovery script, scores readiness, captures a lead.
- ✅ Three connection bugs that previously broke every session have been fixed (see [Troubleshooting](#troubleshooting)).
- ✅ System prompt now includes real facts about Soch (services, process, founders Riz & Umair, location) pulled from withsoch.com, so the bot can answer basic company questions instead of deflecting or inventing answers.
- ⚠️ **Known bug, not fixed: caption bubbles don't appear.** `GEMINI_MODEL` (`gemini-2.5-flash-native-audio-preview-09-2025`) has a Google-side bug where it never emits `outputAudioTranscription` — audio plays correctly, but the widget's on-screen caption text never shows. Confirmed directly against the Live API. **Do not "fix" this by switching to `gemini-3.1-flash-live-preview`** — that was tried and reverted: that model streams transcription fine but does not reliably follow the system prompt at all (skips the scripted script, never adopts the Soch persona) and, worse, hallucinates entirely fake founder names when asked about the company, pulling from an unrelated real-world "Soch" brand in its training data instead of the system prompt. The persona/script bug is far worse than missing captions, so the original model stays until a Live model is found that handles both reliably.
- ✅ Lead capture + booking flow built: n8n workflows for lead → ClickUp/Sheets/emails and Cal.com booking → "Booked" exist in n8n (see below). The bot only claims what the backend confirms.
- ⚠️ **Both n8n workflows are created but NOT published (inactive).** Until "Soch Voice Bot — Lead → CRM + Booking Link" is published in n8n, its production webhook returns 404 and every lead is reported (truthfully) as `failed`.
- ⚠️ **Not deployed / not embedded on withsoch.com yet** — dev/local testing only. Do not add the embed script to the live site until this is explicitly approved.
- ⚠️ Partial leads are saved only once a confirmed email exists (`capture_lead` succeeded). A visitor who leaves before giving an email leaves nothing behind.

---

## Quick start

```bash
git clone <this repo>
cd discoverybot
cp .env.example .env       # then fill in GEMINI_API_KEY, N8N_WEBHOOK_URL, N8N_WEBHOOK_SECRET, CAL_BOOKING_URL
npm install
npm run dev                # http://localhost:3000
```

Visit `http://localhost:3000`, click the pill, then **START**.

> Microphone access requires HTTPS in production. `localhost` is exempt by browsers, so dev works without a cert.

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | yes | — | Google AI Studio key. Used server-side only; never sent to the browser. |
| `N8N_WEBHOOK_URL` | yes | — | Production URL of the "Soch Voice Bot — Lead → CRM + Booking Link" workflow: `https://sochconsulting.app.n8n.cloud/webhook/soch-voice-lead`. The `.env.example` placeholder is treated as unset. |
| `N8N_WEBHOOK_SECRET` | yes | — | Shared secret sent as `X-Soch-Secret`. n8n stores only its SHA-256 (in the workflow's *Validate Request* node). Server-side only; never sent to the browser. |
| `CAL_BOOKING_URL` | yes | — | The existing Cal.com 30-minute event: `https://cal.com/consult-with-riz/sochwork`. Returned by `/token` for the Book-a-Call button. Must be `https://`. |
| `LEAD_TIMEOUT_MS` | no | `25000` | Overall budget for forwarding one lead to n8n, retries included. The widget waits 30 s. |
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

Events: `open`, `close`, `start`, `end`, `restart`, `mute`, `phase`, `score`, `lead` (payload about to be sent), `lead_result` (the backend's result, see below), `booking_click`.

---

## Architecture

```
Browser (widget.js + audio-processor.js)
   │
   │  GET /token       ─► Express ─► Gemini API (ai.authTokens.create)
   │  ◄──── { token, model, booking_url }
   │
   │  WebSocket ──────────────────────────► Gemini Live API
   │  PCM16 @16kHz audio in / PCM16 @24kHz audio out
   │  + tool calls, transcripts, VAD-driven turns
   │
   │  POST /lead       ─► Express ─► n8n webhook (X-Soch-Secret, 25 s budget)
   │  ◄──── { status, lead_stored, riz_notified, email_sent, booking_link, … }
   │                                   │
   │                                   ├─► ClickUp  "Leads Pipeline (Voice Bot)"
   │                                   ├─► Google Sheet "Soch Voice Bot Leads"
   │                                   ├─► Gmail (Riz Gmail) → internal notification*
   │                                   └─► Gmail (Riz Gmail) → prospect: Cal.com link*
   │   * TESTING: the internal notification still goes to a test inbox (see n8n workflows)
   │
   │  [Book a 30-min call] ─► cal.com/consult-with-riz/sochwork (prefilled)
                                        │ BOOKING_CREATED
                                        └─► n8n → Sheet + ClickUp "Booked" → email Riz
```

### Files

| File | Role |
| --- | --- |
| `server.js` | Express app: serves frontend, mints ephemeral tokens (locked to model + AUDIO modality, returns the booking URL), RAG lookup endpoint, validates leads and forwards them to n8n with a secret header and one timeout budget, and maps n8n's per-step flags to a truthful status. Rate-limits `/token`, `/rag/lookup` and `/lead`. |
| `prompt.js` | System prompt + tool declarations (locked into each ephemeral token). |
| `rag.js`, `data/knowledge.js` | RAG retriever + knowledge base for `lookup_soch_info`. |
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
5. `capture_lead` → validates name + email in the widget; returns `missing_name` / `invalid_email` so the bot asks again
6. `send_to_crm(trigger)` → POSTs the lead to `/lead` and returns the backend's real result (see below)
7. `lookup_soch_info` → RAG lookup (`/rag/lookup`), unchanged

Phases advance on actual tool calls, not a timer. `capture_lead` + `send_to_crm` can happen at any phase when the prospect asks to book.

---

## Lead capture & booking flow

### What the bot does

- **Diagnostic complete** — after the score, the bot asks for name + email, reads the email back, calls `capture_lead`, then `send_to_crm` with `trigger: "diagnostic_complete"`.
- **"Book me a call" at any point** — the bot does not make them finish the diagnostic. It collects/confirms name + email, calls `send_to_crm` with `trigger: "booking_request"`, tells them the result, then offers once to continue the diagnostic.
- **Specific times** ("Thursday at 3?") — the bot can't hold a slot; it says they pick any available time on the link. It never says a call is booked, scheduled or confirmed.
- **Book-a-Call button** — shown in the widget as soon as `/token` returns `booking_url`, and re-pointed at the prefilled per-lead link after `send_to_crm`. It stays available whatever happened to the email.
- **Partial leads** — when the conversation ends (END, close, restart, connection drop, or tab close via `sendBeacon`) and the widget has a confirmed email whose latest data n8n hasn't stored yet, it sends `trigger: "session_end"`. n8n saves it as *Partial*, notifies Riz once, and does **not** email the prospect.

### Statuses and what the bot may say

`/lead` returns `status`, derived on the server from n8n's per-step flags (a bare "success" string from n8n is not trusted):

| `status` | Meaning | Bot says | 24 h promise |
| --- | --- | --- | --- |
| `sent` | lead stored, booking-link email sent, Riz notified | "I've just emailed you a link to book a 30-minute call with Riz. You'll receive the follow-up within 24 hours." | ✅ |
| `sent_no_followup` | stored + email sent, Riz notification failed | "I've emailed you the booking link; it's also on your screen." | ❌ |
| `saved_no_email` | stored, prospect email failed | "I've passed your details to Riz. You can use the booking link on your screen to schedule the 30-minute call." | ❌ |
| `failed` | not stored (n8n down/timeout, auth error, both stores failed, not configured) | "I couldn't send your details through just now. You can use the booking link on your screen, or contact info@withsoch.com." | ❌ |
| `missing_contact` | (widget only) no name/email captured yet — nothing sent | asks for the missing detail | ❌ |
| `needs_confirmation` | (widget only) `send_to_crm` came in the same model turn as `capture_lead`, so the prospect never got to confirm the read-back — nothing sent | reads the email back and waits for "yes" | ❌ |

**Confirmation and name guards (widget, not just prompt):** `capture_lead` is called as soon as a name + email are heard; the bot must then read the email back and end its turn. `send_to_crm` is refused (`needs_confirmation`) until at least one model turn has ended since the latest `capture_lead`, so a correction always needs a fresh confirmation. If the model read the email back in its previous turn without calling `capture_lead` (detected from its output transcript), that read-back counts, so the prospect's "yes" isn't blocked. `capture_lead` rejects a name whose letters exactly spell the email's local part (e.g. "Max Ok" from max.ok@…) with `name_unverified` unless the model sets `name_stated_by_user: true`. Partial (`session_end`) saves only use an email that passed confirmation.

The widget passes `status` plus a `guidance` sentence back to Gemini as the `send_to_crm` tool result; the system prompt tells the model to say only what the status allows.

### `/lead` response

```json
{
  "ok": true,
  "status": "sent",
  "lead_stored": true,
  "clickup_stored": true,
  "sheet_stored": true,
  "riz_notified": true,
  "email_sent": true,
  "follow_up_confirmed": true,
  "duplicate": false,
  "booking_url": "https://cal.com/consult-with-riz/sochwork",
  "booking_link": "https://cal.com/consult-with-riz/sochwork?name=Jane+Doe&email=jane%40acme.com&metadata%5Bsession_id%5D=sv_…",
  "error": "only present on failure, e.g. n8n_timeout | n8n_unreachable | unauthorized | webhook_not_configured | invalid_email | missing_name | rate_limited"
}
```

HTTP 200 when the lead was stored, 502 when it wasn't, 400 for invalid input (never forwarded), 503 when the webhook isn't configured, 429 when rate-limited — always with the JSON shape above.

### Server → n8n

- **Auth**: `X-Soch-Secret: $N8N_WEBHOOK_SECRET`. The workflow compares the header's SHA-256 with the hash in its *Validate Request* node; mismatch → 401, nothing stored or sent. **To rotate**: generate a new secret, put it in `.env`, and replace `EXPECTED_SECRET_SHA256` in that node with `sha256(newSecret)`. Last rotated 2026-09-28 (the previous secret appeared in manual-execution logs and is now rejected). Don't send the secret in manual n8n test executions — they log request headers.
- **Timeout/retries**: one overall budget (`LEAD_TIMEOUT_MS`, 25 s). Retries only on network errors, 5xx and 429 (backoff 300 ms, 900 ms; max 3 attempts); never on 4xx or after a timeout.
- **Duplicates**: the widget generates one `session_id` per conversation (kept across END/START, new after restart). The server coalesces identical in-flight submissions and short-circuits repeats of an already-stored payload. n8n de-duplicates by `session_id`: it updates the existing ClickUp task + Sheet row, notifies Riz once per trigger, and emails the prospect the booking link at most once per session.

### n8n workflows (sochconsulting.app.n8n.cloud)

**1. Soch Voice Bot — Lead → CRM + Booking Link** (`eCiH5hKdqEaVd8bX`, webhook `POST /webhook/soch-voice-lead`)

Validate secret + payload → find Sheet row by `session_id` → create or update the ClickUp task → upsert the Sheet row → email Riz → email the prospect the booking link → record delivery flags → respond with per-step flags. Every external step has *continue on error* so its failure becomes a `false` flag instead of a generic error; if both ClickUp and the Sheet fail, Riz still gets a `[NOT SAVED]` email containing the full lead.

- **ClickUp**: list *Leads Pipeline (Voice Bot)* (Business Development → Biz Dev). Task name carries the status, e.g. `[Diagnostic Complete] Jane Doe — Acme`; tag `voice-bot`.
- **Google Sheets**: *Soch Voice Bot Leads*, tab `Leads`, one row per `session_id`. Status never moves backwards (Partial < Booking Requested < Diagnostic Complete < Booked).
- **Email** (both via the *Riz Gmail* credential): an internal new-lead notification, and the booking-link email to the prospect ("Your 30-minute call with Riz from Soch: booking link"). The prospect email only promises the 24-hour follow-up if the internal notification succeeded.
- ⚠️ **TESTING configuration — replace before production.** The prospect recipient is restored; the internal recipients and reply-to still point at a test inbox until the production address is confirmed:

  | Workflow → node | Field | Current value | Production value |
  | --- | --- | --- | --- |
  | Lead → CRM → **Email Riz** | `sendTo` | test inbox | confirmed internal address (TBD) |
  | Lead → CRM → **Email Prospect Booking Link** | `sendTo` | — | `={{ $json.lead.email }}` (restored) |
  | Lead → CRM → **Email Prospect Booking Link** | `options.replyTo` | test inbox | confirmed reply-to (TBD) |
  | Booking Created → **Email Riz Booked** | `sendTo` | test inbox | confirmed internal address (TBD) |

  The sending account is whatever mailbox the *Riz Gmail* credential is signed into — confirm that too before going live.

**2. Soch Voice Bot — Cal.com Booking Created → Booked** (`ot8x0ZLR6KJxVr6I`)

Cal.com Trigger (`BOOKING_CREATED`, *Cal account* credential) → ignore anything that isn't the `sochwork` event → match the lead by `metadata.session_id` (passed through the prefilled link) or, failing that, the most recent row with the attendee's email → Sheet `status = Booked` + `booked_at`/`booking_start`/`booking_uid` → ClickUp tag `booked` + rename to `[Booked] …` → email Riz. Website bookings with no voice-bot lead are ignored (Cal.com already notifies Riz of those).

**To go live**: publish both workflows in n8n. Publishing the Cal.com trigger registers a webhook on the Cal.com account behind the *Cal account* credential — confirm that's the `consult-with-riz` account.

### Local testing

```bash
npm run dev
# success path without touching n8n: point N8N_WEBHOOK_URL at a mock that returns
# { lead_stored, clickup_stored, sheet_stored, riz_notified, email_sent } flags
curl -s localhost:3000/lead -H 'Content-Type: application/json' \
  -d '{"session_id":"sv_localtest_0001","trigger":"booking_request","contact":{"name":"Test","email":"you@example.com"}}'
```

With the real webhook (after publishing), a successful call creates a ClickUp task and Sheet row and sends two real emails — use your own address and delete the test task/row afterwards. Useful failure checks: stop the mock (→ `failed`/`n8n_unreachable`), set a wrong `N8N_WEBHOOK_SECRET` (→ `failed`/`unauthorized`), send `"email":"bad"` (→ 400 `invalid_email`, never forwarded).

### System prompt & company knowledge

The full script lives in `SYSTEM_PROMPT` in `prompt.js`. It has two parts:

1. **The discovery script** — the 6-phase flow above, verbatim opener line, tone rules, and how to handle off-topic questions / declined emails.
2. **An "ABOUT SOCH" block** — real facts pulled from withsoch.com (services, the Audit → Design → Build & deploy process, Riz as co-founder, Tallinn location, contact email), used *only* when a prospect asks about the company. Pricing is deliberately kept qualitative — the homepage and services page list different numbers for the same tiers — so the bot defers exact quotes to the call with Riz instead of risking a wrong figure. The bot is instructed never to invent anything beyond what's listed here; if asked something not covered (case studies, past clients, team beyond Riz), it says that's what the call is for and redirects back to its questions.

If Soch's public site content changes (new services, pricing, team), update this block to keep the bot's answers accurate.

### Lead payload (POSTed to n8n)

```json
{
  "source": "voice_diagnostic_widget",
  "session_id": "sv_3f2a…",
  "trigger": "booking_request | diagnostic_complete | session_end",
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
- **n8n retry** — within one 25 s budget: up to 3 attempts, 300 ms / 900 ms backoff, only on network errors, 5xx and 429.
- **RAG query embeddings** — a caller is waiting (the widget gives up after 6 s), so query embeddings retry a 429 only twice (~0.4 s, ~1.2 s, jittered) inside a 4.5 s budget and then fail fast to the bot's "Riz can cover that on the call" fallback. Previously they waited 15/30/45/60 s, holding requests for minutes and adding load while Google was throttling. Repeated questions are served from an in-memory cache (500 entries) with no API call. The index build keeps the long backoff. The KB index itself is fully cached on disk (`data/.embeddings-cache.json`), so startups make no embedding calls.
- **Gemini 429s** — `gemini-embedding-001` returned the generic `429 RESOURCE_EXHAUSTED "Resource exhausted. Please try again later"` (no quota metric in the body) after only a few lookups, while a controlled probe of 23 calls (≈30/min plus a burst of 8) succeeded. That pattern is Google-side capacity/shared-quota throttling on this key's project, not our request rate — raising it is an account-side change (see Troubleshooting).
- **AbortController on every fetch** — no hung UI on slow networks.
- **Idempotent cleanup** — concurrent `endSession()` and `ws.onclose` are safe.

## Security notes

- The Gemini API key never leaves the server.
- A fresh ephemeral token is fetched every time the user taps **START**.
- CORS is open by design (the widget is meant to be embedded on `withsoch.com` and tested from local dev). Lock down `cors()` origins for `/lead` if you want to restrict.
- `N8N_WEBHOOK_SECRET` is server-side only; the n8n workflow stores just its SHA-256. Note that n8n execution logs record incoming webhook headers, so anyone with access to the n8n workspace's executions can see the secret — rotate it if that audience changes.
- Lead fields are written to the Sheet with `RAW` cell format, so text a prospect says can't be interpreted as a spreadsheet formula.

## Browser support

Chrome, Edge, Safari 14+, Firefox 76+. Prefers `AudioWorklet`, falls back to `ScriptProcessorNode` on browsers without it.

## Troubleshooting

- **"Microphone access is needed…"** — user denied mic permission. They need to re-enable it in browser site settings.
- **Connection closes immediately** — usually an expired token or a bad model ID. Check server logs and verify `GEMINI_API_KEY` and `GEMINI_MODEL`.
- **Server returns 503 / model 404** — the configured model isn't enabled on your project. Set `GEMINI_MODEL=gemini-2.5-flash-native-audio-preview-09-2025` (or another live-capable model) and restart.
- **No audio playing on Safari** — Safari requires a user gesture before `AudioContext` can start. The widget triggers it on the START tap; make sure that's the only entrypoint.
- **`WebSocket closed before setup (code 1007: API key not valid...)` even with a good key** — this bit us during testing and cost a lot of debugging time, so noting it explicitly: ephemeral-token sessions **must** connect to `BidiGenerateContentConstrained` with the token passed as `access_token=`. Connecting to plain `BidiGenerateContent` (even with a valid token) or passing the token as `key=` gets rejected with this exact misleading "API key not valid" message. Both are already fixed in `widget.js`, but if you see this error again after editing the WS URL, check those two things first.
- **`liveConnectConstraints.model` mismatch** — the model string the server locks a minted token to (`server.js`) must exactly match what the client sends in its `setup` message (`widget.js`, which prefixes with `models/`). A mismatch closes the socket the same way as the bug above.
- **`/rag/lookup error: 429 Resource exhausted`** — Google is throttling the API key's project. Code already fails fast and caches repeat queries; the fix is account-side: check the project's quotas/tier for the Gemini API (`gemini-embedding-001` embed requests) in Google Cloud / AI Studio, enable billing or move to a paid tier, or request a quota increase. The key's `AQ.` prefix indicates a Google Cloud–issued key; confirm which project it belongs to when checking quotas.
- **Bot connects but says nothing** — the model doesn't speak first on its own. `widget.js` sends a hidden kickoff turn right after `connect()` to trigger its scripted opener; if that call is ever removed, the bot will sit silently waiting for the user to speak first instead.
