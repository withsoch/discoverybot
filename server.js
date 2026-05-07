require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

if (!GEMINI_API_KEY) {
  console.warn('[soch-voice-bot] GEMINI_API_KEY is not set — /token will fail until configured.');
}
if (!N8N_WEBHOOK_URL) {
  console.warn('[soch-voice-bot] N8N_WEBHOOK_URL is not set — /lead will log only.');
}

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const app = express();

app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '1mb' }));

// Static frontend assets — served with permissive CORS so the widget can be
// embedded from any origin (Webflow, withsoch.com, etc.).
app.use(
  express.static(path.join(__dirname, 'frontend'), {
    setHeaders: (res, filePath) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      }
    },
  })
);

// GET /token — issues a short-lived ephemeral token for the browser to open
// a direct WebSocket to the Gemini Live API. Token expires in 60 seconds and
// is single-use.
app.get('/token', async (req, res) => {
  if (!ai) {
    return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
  }
  try {
    const expireTime = new Date(Date.now() + 60 * 1000).toISOString();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
      },
    });
    res.json({ token: token.name, expireTime });
  } catch (err) {
    console.error('[soch-voice-bot] /token error:', err);
    res.status(500).json({ error: 'Failed to mint ephemeral token' });
  }
});

// POST /lead — forwards the final lead payload to the configured n8n webhook.
app.post('/lead', async (req, res) => {
  const payload = req.body || {};
  console.log('[soch-voice-bot] lead received:', JSON.stringify(payload, null, 2));

  if (!N8N_WEBHOOK_URL) {
    return res.status(202).json({ ok: true, forwarded: false, reason: 'N8N_WEBHOOK_URL not configured' });
  }

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('[soch-voice-bot] n8n webhook non-2xx:', response.status, text);
      return res.status(502).json({ ok: false, forwarded: false, status: response.status });
    }
    console.log('[soch-voice-bot] lead forwarded to n8n OK');
    res.json({ ok: true, forwarded: true });
  } catch (err) {
    console.error('[soch-voice-bot] n8n webhook error:', err);
    res.status(502).json({ ok: false, forwarded: false, error: String(err) });
  }
});

// GET / — serves the local-dev test page.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[soch-voice-bot] listening on http://localhost:${PORT}`);
});
