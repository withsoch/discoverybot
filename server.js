// Soch Automation Diagnostic — Express backend.
//
// Responsibilities:
//   • Serve the embeddable frontend (widget.js, widget.css, audio-processor.js).
//   • Mint short-lived ephemeral tokens for the Gemini Live API so the browser
//     can open a direct WebSocket without ever seeing the long-lived API key.
//   • Forward leads to the n8n webhook (secret header, one timeout budget) and
//     report back exactly which downstream steps succeeded.
//
// All three concerns are intentionally minimal — the heavy lifting happens in
// the browser. The server is just a token broker + lead forwarder.

require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { GoogleGenAI } = require('@google/genai');
const rag = require('./rag');
const { SYSTEM_PROMPT, TOOL_DEFINITIONS } = require('./prompt');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS) || 30 * 60 * 1000; // 30 min
const SESSION_START_TTL_MS = Number(process.env.SESSION_START_TTL_MS) || 2 * 60 * 1000; // 2 min
// One overall budget for forwarding a lead to n8n, retries included. The
// widget waits LEAD_TIMEOUT_MS + a few seconds, so it always hears back.
// A first-time lead measured ~15 s end to end in n8n (Sheets upsert alone ~8 s).
const LEAD_TIMEOUT_MS = Number(process.env.LEAD_TIMEOUT_MS) || 25000;

// Treat the .env.example placeholder as "not configured" so a copied example
// file can never look like a working integration.
const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL && !/your-n8n-instance\.com/.test(process.env.N8N_WEBHOOK_URL)
    ? process.env.N8N_WEBHOOK_URL
    : null;
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET || null;
const CAL_BOOKING_URL = /^https:\/\/\S+$/.test(process.env.CAL_BOOKING_URL || '')
  ? process.env.CAL_BOOKING_URL
  : null;

if (!GEMINI_API_KEY) {
  console.warn('[soch] GEMINI_API_KEY not set — /token will fail until configured.');
}
if (!N8N_WEBHOOK_URL || !N8N_WEBHOOK_SECRET) {
  console.warn('[soch] N8N_WEBHOOK_URL / N8N_WEBHOOK_SECRET not set — /lead will report every lead as failed.');
}
if (!CAL_BOOKING_URL) {
  console.warn('[soch] CAL_BOOKING_URL not set (or not https) — the widget will have no booking link.');
}

// v1alpha is required for ephemeral token endpoints per Google docs.
const ai = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { apiVersion: 'v1alpha' } })
  : null;

const app = express();
app.set('trust proxy', 1); // honor X-Forwarded-For from Railway/Render/nginx
app.disable('x-powered-by');

app.use(cors({ origin: true, credentials: false, maxAge: 86400 }));
app.use(express.json({ limit: '64kb' }));

// ---- Static assets (widget.js, widget.css, audio-processor.js, etc.) ------
// Local/Node hosting only: on Vercel, public/ is served by the CDN instead
// (express.static is ignored there) with the same headers set in vercel.json.
// Long cache for the worklet and CSS; the JS is hashless so we keep it short
// to make widget rollouts visible quickly.
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
      } else if (filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      }
    },
  })
);

// ---- /token: mint a single-use ephemeral token --------------------------
// Locked down via `liveConnectConstraints` so even if a token is intercepted
// it can only be used to start a session with the model + modality we expect.
const tokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 sessions/min/IP — generous for legitimate users, tight enough to deter abuse
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many token requests' },
});

app.get('/token', tokenLimiter, async (req, res) => {
  if (!ai) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
  try {
    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + TOKEN_TTL_MS).toISOString(),
        newSessionExpireTime: new Date(now + SESSION_START_TTL_MS).toISOString(),
        liveConnectConstraints: {
          // Must exactly match the model string the client sends in its
          // `setup` message (public/widget.js prefixes with `models/`),
          // or Gemini closes the socket right after connecting (code 1007).
          model: GEMINI_MODEL.startsWith('models/') ? GEMINI_MODEL : `models/${GEMINI_MODEL}`,
          // Everything the session needs must be here: over a token
          // connection Gemini ignores systemInstruction/tools from the client.
          config: {
            responseModalities: ['AUDIO'],
            systemInstruction: SYSTEM_PROMPT,
            tools: [{ functionDeclarations: TOOL_DEFINITIONS }],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        },
        httpOptions: { apiVersion: 'v1alpha' },
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json({ token: token.name, model: GEMINI_MODEL, booking_url: CAL_BOOKING_URL });
  } catch (err) {
    console.error('[soch] /token error:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to mint ephemeral token' });
  }
});

// ---- /rag/lookup: knowledge-base retrieval for the lookup_soch_info tool -
// Called by the widget's lookup_soch_info tool call whenever the model needs
// a Soch fact beyond the always-available QUICK FACTS baked into the prompt.
const ragLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Embeddings need the default API version — v1alpha (used for ephemeral
// tokens above) doesn't support embedContent.
const embedAi = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Warm the embedding index at boot so the first call in a session isn't slow.
if (embedAi) {
  rag.getIndex(embedAi).then(
    () => console.log('[soch] RAG knowledge index ready'),
    (err) => console.error('[soch] RAG index build failed:', err && err.message ? err.message : err)
  );
}

app.post('/rag/lookup', ragLimiter, async (req, res) => {
  if (!embedAi) return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
  const query = String((req.body && req.body.query) || '').slice(0, 300);
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    const { context, sources } = await rag.lookup(embedAi, query);
    console.log('[soch] rag lookup:', JSON.stringify(query), '->',
      sources.map((s) => `${s.id} (${s.score}${s.conflict ? ', conflict' : ''})`).join(', '));
    res.json({ context, sources });
  } catch (err) {
    console.error('[soch] /rag/lookup error:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'lookup failed' });
  }
});

// ---- /lead: forward to n8n with retry + redacted logging ----------------
const leadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Same shape as every other /lead failure so the widget reports it truthfully.
  message: { ok: false, status: 'failed', lead_stored: false, email_sent: false, follow_up_confirmed: false, error: 'rate_limited' },
});

function redact(payload) {
  // Redacted clone for logs — keep enough to debug funnel issues without
  // dumping PII into logs.
  const safe = JSON.parse(JSON.stringify(payload || {}));
  if (safe.contact) {
    if (safe.contact.email) {
      const [local, domain] = String(safe.contact.email).split('@');
      safe.contact.email = `${(local || '').slice(0, 2)}***@${domain || ''}`;
    }
    if (safe.contact.name) safe.contact.name = String(safe.contact.name).slice(0, 1) + '***';
  }
  return safe;
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LEAD_TRIGGERS = ['booking_request', 'diagnostic_complete', 'session_end'];

/** Cal.com link prefilled with the prospect's details; metadata lets the booking be matched back to the lead. */
function bookingLinkFor(payload) {
  if (!CAL_BOOKING_URL) return null;
  const c = (payload && payload.contact) || {};
  const url = new URL(CAL_BOOKING_URL);
  if (c.name) url.searchParams.set('name', String(c.name));
  if (c.email) url.searchParams.set('email', String(c.email));
  if (payload && payload.session_id) url.searchParams.set('metadata[session_id]', String(payload.session_id));
  return url.toString();
}

/**
 * The one mapping from n8n's per-step flags to what the bot may claim:
 *   sent             – lead stored, booking-link email sent, Riz notified
 *   sent_no_followup – lead stored, email sent, Riz notification failed
 *   saved_no_email   – lead stored, booking-link email NOT sent
 *   failed           – lead not stored anywhere
 * Derived from the flags rather than trusting a status string.
 */
function deriveLeadResult(n8n, payload) {
  const lead_stored = n8n.lead_stored === true;
  const email_sent = lead_stored && n8n.email_sent === true;
  const riz_notified = n8n.riz_notified === true;
  const follow_up_confirmed = lead_stored && riz_notified;
  let status = 'failed';
  if (lead_stored) status = email_sent ? (follow_up_confirmed ? 'sent' : 'sent_no_followup') : 'saved_no_email';
  return {
    ok: lead_stored,
    status,
    lead_stored,
    clickup_stored: n8n.clickup_stored === true,
    sheet_stored: n8n.sheet_stored === true,
    riz_notified,
    email_sent,
    follow_up_confirmed,
    duplicate: n8n.duplicate === true,
    booking_url: CAL_BOOKING_URL,
    booking_link: bookingLinkFor(payload),
  };
}

function failedLeadResult(payload, error) {
  return {
    ok: false, status: 'failed', lead_stored: false, clickup_stored: false, sheet_stored: false,
    riz_notified: false, email_sent: false, follow_up_confirmed: false, duplicate: false,
    booking_url: CAL_BOOKING_URL, booking_link: bookingLinkFor(payload), error,
  };
}

/**
 * POSTs to n8n within one overall time budget. Retries only transient
 * failures (network errors, 5xx, 429); a 4xx means the request itself is
 * wrong, so retrying can't help. n8n de-duplicates on session_id, so a retry
 * after an attempt that did land cannot double-create the lead or re-send email.
 * Resolves to { httpStatus, body } or throws the last error.
 */
async function forwardToN8n(payload, budgetMs = LEAD_TIMEOUT_MS) {
  const deadline = Date.now() + budgetMs;
  const backoffs = [300, 900];
  let lastErr;
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 250) break;
    try {
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Soch-Secret': N8N_WEBHOOK_SECRET },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(remaining),
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }
      if (response.status >= 500 || response.status === 429) {
        lastErr = new Error(`n8n returned ${response.status}`);
      } else {
        return { httpStatus: response.status, body };
      }
    } catch (err) {
      lastErr = err;
      // The attempt used up the whole budget; n8n may still be working on it.
      if (err && err.name === 'TimeoutError') break;
    }
    if (attempt >= backoffs.length) break;
    const wait = backoffs[attempt];
    if (deadline - Date.now() <= wait + 250) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastErr || new Error('lead forward budget exhausted');
}

// In-flight / recent submissions keyed by session + trigger + payload, so a
// double tool call or a quick retry shares one n8n request instead of racing.
const recentLeads = new Map();
const RECENT_LEAD_TTL_MS = 10 * 60 * 1000;

function leadKey(payload) {
  const { timestamp, ...rest } = payload;
  const digest = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16);
  return `${payload.session_id}:${payload.trigger}:${digest}`;
}

async function submitLead(payload) {
  const now = Date.now();
  for (const [k, v] of recentLeads) if (now - v.at > RECENT_LEAD_TTL_MS) recentLeads.delete(k);

  const key = leadKey(payload);
  const cached = recentLeads.get(key);
  if (cached) {
    const result = await cached.promise;
    // Only a failure is worth retrying for real; anything stored is final.
    if (result.lead_stored) return { ...result, duplicate: true };
  }

  const promise = (async () => {
    try {
      const { httpStatus, body } = await forwardToN8n(payload);
      if (httpStatus === 200 && body && typeof body === 'object') return deriveLeadResult(body, payload);
      console.error('[soch] n8n rejected lead:', httpStatus, body && body.error);
      return failedLeadResult(payload, (body && body.error) || `n8n_http_${httpStatus}`);
    } catch (err) {
      console.error('[soch] n8n forward error:', err && err.message ? err.message : err);
      return failedLeadResult(payload, err && err.name === 'TimeoutError' ? 'n8n_timeout' : 'n8n_unreachable');
    }
  })();
  recentLeads.set(key, { at: now, promise });
  const result = await promise;
  if (!result.lead_stored) recentLeads.delete(key);
  return result;
}

// sendBeacon (used for partial leads when the page is closing) can only send
// CORS-safelisted content types, so /lead also accepts JSON as text/plain.
app.post('/lead', leadLimiter, express.text({ type: 'text/plain', limit: '64kb' }), async (req, res) => {
  let payload = req.body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch (_) { payload = null; }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json(failedLeadResult({}, 'invalid_body'));
  }
  console.log('[soch] lead received:', JSON.stringify(redact(payload)));

  const contact = payload.contact || {};
  const email = String(contact.email || '').trim().toLowerCase();
  if (!SESSION_ID_RE.test(String(payload.session_id || ''))) {
    return res.status(400).json(failedLeadResult(payload, 'invalid_session_id'));
  }
  if (!LEAD_TRIGGERS.includes(payload.trigger)) {
    return res.status(400).json(failedLeadResult(payload, 'invalid_trigger'));
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json(failedLeadResult(payload, 'invalid_email'));
  }
  if (!String(contact.name || '').trim() && payload.trigger !== 'session_end') {
    return res.status(400).json(failedLeadResult(payload, 'missing_name'));
  }
  payload.contact = { ...contact, email };

  if (!N8N_WEBHOOK_URL || !N8N_WEBHOOK_SECRET) {
    console.error('[soch] lead NOT forwarded: n8n webhook not configured');
    return res.status(503).json(failedLeadResult(payload, 'webhook_not_configured'));
  }

  const result = await submitLead(payload);
  console.log('[soch] lead result:', payload.session_id, payload.trigger, '->', result.status,
    JSON.stringify({ clickup: result.clickup_stored, sheet: result.sheet_stored, riz: result.riz_notified, email: result.email_sent, dup: result.duplicate }));
  res.set('Cache-Control', 'no-store');
  return res.status(result.lead_stored ? 200 : 502).json(result);
});

// ---- Misc ---------------------------------------------------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/healthz', (req, res) => res.json({ ok: true, model: GEMINI_MODEL }));

app.listen(PORT, () => {
  console.log(`[soch] listening on http://localhost:${PORT} (model=${GEMINI_MODEL})`);
});
