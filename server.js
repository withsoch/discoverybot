// Soch Automation Diagnostic — Express backend.
//
// Responsibilities:
//   • Serve the embeddable frontend (widget.js, widget.css, audio-processor.js).
//   • Mint short-lived ephemeral tokens for the Gemini Live API so the browser
//     can open a direct WebSocket without ever seeing the long-lived API key.
//   • Forward completed lead payloads to the configured n8n webhook.
//
// All three concerns are intentionally minimal — the heavy lifting happens in
// the browser. The server is just a token broker + lead forwarder.

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { GoogleGenAI } = require('@google/genai');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS) || 30 * 60 * 1000; // 30 min
const SESSION_START_TTL_MS = Number(process.env.SESSION_START_TTL_MS) || 2 * 60 * 1000; // 2 min

if (!GEMINI_API_KEY) {
  console.warn('[soch] GEMINI_API_KEY not set — /token will fail until configured.');
}
if (!N8N_WEBHOOK_URL) {
  console.warn('[soch] N8N_WEBHOOK_URL not set — /lead will accept payloads but not forward.');
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
// Long cache for the worklet and CSS; the JS is hashless so we keep it short
// to make widget rollouts visible quickly.
app.use(
  express.static(path.join(__dirname, 'frontend'), {
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
          model: GEMINI_MODEL,
          config: { responseModalities: ['AUDIO'] },
        },
        httpOptions: { apiVersion: 'v1alpha' },
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json({ token: token.name, model: GEMINI_MODEL });
  } catch (err) {
    console.error('[soch] /token error:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Failed to mint ephemeral token' });
  }
});

// ---- /lead: forward to n8n with retry + redacted logging ----------------
const leadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
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

async function forwardWithRetry(url, body, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const ctrl = AbortSignal.timeout(8000);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl,
      });
      if (response.ok) return { ok: true, status: response.status };
      // Only retry on transient server errors / rate limits.
      if (response.status >= 500 || response.status === 429) {
        lastErr = new Error(`n8n returned ${response.status}`);
      } else {
        return { ok: false, status: response.status, retried: false };
      }
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** i)); // 250ms, 500ms, 1000ms
    }
  }
  throw lastErr || new Error('forward failed');
}

app.post('/lead', leadLimiter, async (req, res) => {
  const payload = req.body || {};
  console.log('[soch] lead received:', JSON.stringify(redact(payload)));

  if (!N8N_WEBHOOK_URL) {
    return res.status(202).json({ ok: true, forwarded: false, reason: 'webhook not configured' });
  }
  try {
    const result = await forwardWithRetry(N8N_WEBHOOK_URL, payload);
    if (result.ok) {
      console.log('[soch] lead forwarded to n8n OK');
      return res.json({ ok: true, forwarded: true });
    }
    console.error('[soch] n8n forward failed status', result.status);
    return res.status(502).json({ ok: false, forwarded: false, status: result.status });
  } catch (err) {
    console.error('[soch] n8n forward error:', err && err.message ? err.message : err);
    return res.status(502).json({ ok: false, forwarded: false, error: 'forward failed' });
  }
});

// ---- Misc ---------------------------------------------------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));
app.get('/healthz', (req, res) => res.json({ ok: true, model: GEMINI_MODEL }));

app.listen(PORT, () => {
  console.log(`[soch] listening on http://localhost:${PORT} (model=${GEMINI_MODEL})`);
});
