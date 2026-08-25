'use strict';

const path = require('path');
const express = require('express');
const { createClient } = require('redis');
const { REDIS_URL, SOLR_URL, PORT, REDIS_INDEX } = require('./config');
const { sanitize, redisQuery, redisSearchArgs, solrParams } = require('./queries');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const redis = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('Redis error:', err.message || err.code || err));

// Wall-clock timing in milliseconds, to microsecond resolution. Redis queries
// land well under a millisecond, so Date.now() would quantise them to 0 or 1.
function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function runRedis(scenario, terms, filters, limit, order) {
  const { index, query, options } = redisSearchArgs(scenario, terms, filters, limit, order);
  const t0 = nowMs();
  // FT.SEARCH cp:idx <query> LIMIT 0 <limit> RETURN ...
  // Redis parses the query, walks the inverted index and returns matching
  // Hash fields in one round trip. No commit, no searcher reopen — whatever
  // has been written is already visible.
  const res = await redis.ft.search(index, query, options);
  const ms = nowMs() - t0;
  return { ms, total: res.total, docs: res.documents };
}

async function runSolr(scenario, terms, filters, limit, order) {
  const params = solrParams(scenario, terms, filters, limit, order);
  const t0 = nowMs();
  const res = await fetch(`${SOLR_URL}/select?${params.toString()}`);
  const body = await res.json();
  const ms = nowMs() - t0;
  if (!res.ok) throw new Error(`Solr HTTP ${res.status}`);
  return {
    ms,
    // QTime is Solr's own view of query execution, excluding HTTP transport
    // and JSON serialisation. Reported alongside wall time so the comparison
    // can't be accused of being all network overhead — see the README.
    qtime: body.responseHeader?.QTime,
    total: body.response?.numFound ?? 0,
    docs: (body.response?.docs || []).map((d) => ({ id: d.id, value: d })),
  };
}

function normalise(docs) {
  return docs.map((d) => {
    const v = d.value || {};
    return {
      id: v.id ?? d.id,
      legal_name: v.legal_name,
      aliases: v.aliases,
      country: v.country,
      entity_type: v.entity_type,
      credit_rating: v.credit_rating,
      risk_score: Number(v.risk_score),
      status: v.status,
    };
  });
}

// GET /api/search
//   ?scenario=fuzzy|prefix|filtered
//   &q=<name>
//   &runs=<1-25>       how many times to run each engine (median is reported)
//   &countries=GB,US   filtered scenario only
//   &status=ACTIVE
//   &minRating=13
//   &maxRisk=80
app.get('/api/search', async (req, res) => {
  const scenario = ['fuzzy', 'prefix', 'filtered'].includes(req.query.scenario)
    ? req.query.scenario
    : 'fuzzy';
  const terms = sanitize(req.query.q);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const runs = Math.min(Math.max(Number(req.query.runs) || 1, 1), 25);
  const order = req.query.order === 'relevance' ? 'relevance' : 'name';

  const filters = {
    countries: String(req.query.countries || '')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c)),
    status: /^[A-Z_]{3,12}$/.test(req.query.status || '') ? req.query.status : '',
    minRating: req.query.minRating === '' || req.query.minRating === undefined
      ? NaN
      : Number(req.query.minRating),
    maxRisk: req.query.maxRisk === '' || req.query.maxRisk === undefined
      ? NaN
      : Number(req.query.maxRisk),
  };

  try {
    const redisTimes = [];
    const solrTimes = [];
    let redisResult;
    let solrResult;

    // Both engines run the same number of times, alternating which goes first
    // so neither systematically benefits from being second (warmer caches,
    // scheduler luck). The median of the runs is reported, not the best case.
    for (let i = 0; i < runs; i += 1) {
      if (i % 2 === 0) {
        redisResult = await runRedis(scenario, terms, filters, limit, order);
        solrResult = await runSolr(scenario, terms, filters, limit, order);
      } else {
        solrResult = await runSolr(scenario, terms, filters, limit, order);
        redisResult = await runRedis(scenario, terms, filters, limit, order);
      }
      redisTimes.push(redisResult.ms);
      solrTimes.push(solrResult.ms);
    }

    const redisMs = median(redisTimes);
    const solrMs = median(solrTimes);

    res.json({
      scenario,
      runs,
      order,
      terms,
      redis: {
        ms: Number(redisMs.toFixed(3)),
        total: redisResult.total,
        hits: normalise(redisResult.docs),
        query: redisQuery(scenario, terms, filters),
      },
      solr: {
        ms: Number(solrMs.toFixed(3)),
        qtime: solrResult.qtime,
        total: solrResult.total,
        hits: normalise(solrResult.docs),
        query: decodeURIComponent(solrParams(scenario, terms, filters, limit, order).toString()),
      },
      // Only meaningful when both engines found the same number of documents —
      // the UI greys the multiplier out when the totals disagree, because a
      // speed comparison between two different questions is meaningless.
      speedup: solrMs > 0 && redisMs > 0 ? Number((solrMs / redisMs).toFixed(1)) : null,
      totalsMatch: redisResult.total === solrResult.total,
    });
  } catch (err) {
    console.error('search failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — corpus size on both sides, so the UI can prove they match.
app.get('/api/stats', async (req, res) => {
  try {
    const info = await redis.ft.info(REDIS_INDEX);
    const solrRes = await fetch(`${SOLR_URL}/select?q=*:*&rows=0&wt=json`);
    const solrBody = await solrRes.json();
    res.json({
      redis: {
        docs: Number(info.numDocs),
        indexName: REDIS_INDEX,
        // Reported so nobody has to take "Redis has no commit lag" on trust.
        indexing: Number(info.indexing) === 1,
      },
      solr: {
        docs: solrBody.response?.numFound ?? 0,
        core: 'counterparties',
      },
    });
  } catch (err) {
    console.error('stats failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  await redis.connect();
  console.log(`Connected to Redis at ${REDIS_URL}`);

  // Fail early with a clear message rather than serving a broken demo.
  const info = await redis.ft.info(REDIS_INDEX).catch(() => null);
  if (!info) {
    throw new Error(`index ${REDIS_INDEX} not found — run: npm run seed`);
  }
  const solrPing = await fetch(`${SOLR_URL}/select?q=*:*&rows=0&wt=json`).catch(() => null);
  if (!solrPing || !solrPing.ok) {
    throw new Error(`Solr not reachable at ${SOLR_URL} — is docker compose up?`);
  }
  const solrBody = await solrPing.json();

  console.log(`Redis index ${REDIS_INDEX}: ${Number(info.numDocs).toLocaleString()} docs`);
  console.log(`Solr core counterparties: ${solrBody.response.numFound.toLocaleString()} docs`);
  if (Number(info.numDocs) !== solrBody.response.numFound) {
    console.warn('WARNING: document counts differ — re-run `npm run seed` for a fair comparison');
  }

  const server = app.listen(PORT, () => {
    console.log(`\nDemo running at http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is in use. Try: PORT=${Number(PORT) + 1} npm start`);
    } else {
      console.error(`Could not listen on ${PORT}: ${err.message || err.code || err}`);
    }
    process.exit(1);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err.message || err.code || err);
  process.exit(1);
});
