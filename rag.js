// RAG retriever over the Soch knowledge base (data/knowledge.js, crawled from withsoch.com).
//
// The corpus is a few hundred short chunks, so this intentionally skips a vector DB:
// chunks are embedded with Gemini's embedding model, kept in memory, and cosine
// similarity picks the top matches per query. Embeddings are cached on disk keyed
// by content hash, so a restart only re-embeds chunks whose text changed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const KNOWLEDGE = require('./data/knowledge');

const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIMS = 768;
const TOP_K = 5;
const BATCH_SIZE = 100; // embedContent rejects more than 100 inputs per request
const CACHE_FILE = path.join(__dirname, 'data', '.embeddings-cache.json');

let indexPromise = null;

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// The title carries the page/section context (e.g. "Case study: Be London — …"),
// so it is embedded together with the chunk text.
const documentText = (c) => `${c.title}\n${c.text}`;
const cacheKey = (text) =>
  crypto.createHash('sha256').update(`${EMBED_MODEL}|${EMBED_DIMS}|${text}`).digest('hex');

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}

// Index builds are offline and can wait out a rate limit; a query is answered
// while a caller is on the line (the widget gives up after 6 s), so it retries
// briefly and then fails fast instead of queueing more calls into a 429.
const INDEX_BACKOFF_MS = [15000, 30000, 45000, 60000];
const QUERY_BACKOFF_MS = [400, 1200];
const QUERY_BUDGET_MS = 4500;

async function embedWithRetry(ai, contents, taskType, { backoff = INDEX_BACKOFF_MS, budgetMs = Infinity } = {}) {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await ai.models.embedContent({
        model: EMBED_MODEL,
        contents,
        config: { taskType, outputDimensionality: EMBED_DIMS },
      });
      return res.embeddings.map((e) => e.values);
    } catch (err) {
      const rateLimited = /429|RESOURCE_EXHAUSTED/.test(String(err && err.message));
      const wait = backoff[attempt];
      if (rateLimited) console.warn(`[soch] embed 429 (${taskType}, attempt ${attempt + 1})`);
      if (!rateLimited || wait === undefined || Date.now() + wait > deadline) throw err;
      // Jitter so parallel callers don't retry in lockstep.
      await new Promise((r) => setTimeout(r, wait + Math.floor(Math.random() * wait * 0.25)));
    }
  }
}

// Query embeddings are deterministic, so repeated questions ("pricing",
// "services") are served from memory instead of spending API quota.
const QUERY_CACHE_MAX = 500;
const queryCache = new Map();

async function embedQuery(ai, query) {
  const key = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const hit = queryCache.get(key);
  if (hit) {
    queryCache.delete(key);
    queryCache.set(key, hit); // keep recently used entries
    return hit;
  }
  const [vec] = await embedWithRetry(ai, [query], 'RETRIEVAL_QUERY', { backoff: QUERY_BACKOFF_MS, budgetMs: QUERY_BUDGET_MS });
  queryCache.set(key, vec);
  if (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value);
  return vec;
}

async function buildIndex(ai) {
  const cache = readCache();
  const keys = KNOWLEDGE.map((c) => cacheKey(documentText(c)));
  const missing = KNOWLEDGE.map((c, i) => i).filter((i) => !cache[keys[i]]);

  for (let start = 0; start < missing.length; start += BATCH_SIZE) {
    const batch = missing.slice(start, start + BATCH_SIZE);
    const vectors = await embedWithRetry(ai, batch.map((i) => documentText(KNOWLEDGE[i])), 'RETRIEVAL_DOCUMENT');
    batch.forEach((i, j) => { cache[keys[i]] = vectors[j]; });
  }
  if (missing.length) {
    const live = Object.fromEntries(keys.map((k) => [k, cache[k]]));
    fs.writeFileSync(CACHE_FILE, JSON.stringify(live));
  }
  return KNOWLEDGE.map((chunk, i) => ({ ...chunk, embedding: cache[keys[i]] }));
}

/** Lazily builds (once) and returns the embedded knowledge index. */
function getIndex(ai) {
  if (!indexPromise) {
    indexPromise = buildIndex(ai).catch((err) => { indexPromise = null; throw err; });
  }
  return indexPromise;
}

// Each chunk handed to the model carries its source, so answers are traceable to a page.
function formatChunk(c) {
  const header = `[Source: ${c.title} | ${c.pageType} | ${c.url}]`;
  const conflict = c.conflict
    ? `\n[Review note: website pages disagree on this — ${c.conflict} Do not state these figures as definitive; say Riz will confirm the specifics.]`
    : '';
  return `${header}\n${c.text}${conflict}`;
}

/**
 * Returns the top-K most relevant knowledge chunks for a free-text query:
 * `context` (source-labelled text for the model) and `sources` (for logging).
 */
async function lookup(ai, query) {
  const index = await getIndex(ai);
  const queryVec = await embedQuery(ai, query);

  const ranked = index
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  return {
    context: ranked.map((r) => formatChunk(r.chunk)).join('\n\n'),
    sources: ranked.map((r) => ({
      id: r.chunk.id, title: r.chunk.title, url: r.chunk.url, pageType: r.chunk.pageType,
      score: Number(r.score.toFixed(3)), conflict: Boolean(r.chunk.conflict),
    })),
  };
}

module.exports = { lookup, getIndex };
