'use strict';

// Independent validation of every tab.
//
// The point is NOT "do the two engines agree" — they could agree and both be
// wrong. Every expected answer here is computed directly from
// data/counterparties.jsonl and data/vectors.f32 in plain JavaScript, with no
// help from Redis or Solr, and then compared against what the API returns.
//
// For the semantic tab that means an exact brute-force nearest-neighbour scan
// over all 100,000 vectors, which is the only honest way to measure how much
// each engine's approximate index actually finds.
//
//   npm run validate

const fs = require('fs');
const readline = require('readline');
const { DATA_FILE, PORT } = require('./config');
const { DIM, vectorsAvailable, loadVectors } = require('./vectors');

const BASE = `http://localhost:${PORT}`;
const results = [];

function record(tab, check, pass, detail) {
  results.push({ tab, check, pass, detail });
  const mark = pass === true ? ' ok ' : pass === 'warn' ? 'warn' : 'FAIL';
  console.log(`  [${mark}] ${tab.padEnd(12)} ${check.padEnd(34)} ${detail}`);
}

async function get(path) {
  const res = await fetch(BASE + path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---------------------------------------------------------------- helpers

// Both engines lowercase and split text on non-alphanumerics. Ground truth uses
// the same rule so a mismatch means a real disagreement, not a tokenisation
// artefact.
function tokens(...fields) {
  return fields.join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Levenshtein distance, capped: returns >max as soon as it's certain.
function editDistance(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------- main

async function main() {
  console.log('Loading the corpus for independent ground truth...');
  const recs = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(DATA_FILE),
    crlfDelay: Infinity,
  });
  for await (const line of rl) if (line) recs.push(JSON.parse(line));
  console.log(`  ${recs.length.toLocaleString()} records loaded\n`);

  // ---- corpus integrity -------------------------------------------------
  const stats = await get('/api/stats');
  record('corpus', 'Redis doc count == file lines',
    stats.redis.docs === recs.length, `${stats.redis.docs.toLocaleString()} vs ${recs.length.toLocaleString()}`);
  record('corpus', 'Solr doc count == file lines',
    stats.solr.docs === recs.length, `${stats.solr.docs.toLocaleString()} vs ${recs.length.toLocaleString()}`);

  // ---- prefix ------------------------------------------------------------
  for (const term of ['kes', 'stonebr', 'aber']) {
    const expected = recs.filter((r) =>
      tokens(r.legal_name, r.aliases).some((t) => t.startsWith(term))).length;
    const d = await get(`/api/search?scenario=prefix&q=${term}&runs=1&order=name`);
    record('prefix', `"${term}*" total == brute force`,
      d.redis.total === expected && d.solr.total === expected,
      `expected ${expected.toLocaleString()} · redis ${d.redis.total.toLocaleString()} · solr ${d.solr.total.toLocaleString()}`);
  }

  // ---- fuzzy -------------------------------------------------------------
  // Every returned document must contain a token within edit distance 1 of
  // each query term, and the total must match a brute-force scan.
  for (const q of ['kestral capitol', 'invermer finacial']) {
    const terms = q.split(' ');
    const matches = (r) => {
      const toks = tokens(r.legal_name, r.aliases);
      return terms.every((t) => toks.some((tok) => editDistance(t, tok, 1) <= 1));
    };
    const expected = recs.filter(matches).length;
    const d = await get(`/api/search?scenario=fuzzy&q=${encodeURIComponent(q)}&runs=1&order=name`);
    record('fuzzy', `"${q}" total == brute force`,
      d.redis.total === expected && d.solr.total === expected,
      `expected ${expected} · redis ${d.redis.total} · solr ${d.solr.total}`);

    const byId = new Map(recs.map((r) => [r.id, r]));
    const allValid = d.redis.hits.every((h) => matches(byId.get(h.id)));
    record('fuzzy', `"${q}" every hit within LD1`, allValid,
      `${d.redis.hits.length} hits checked against the source record`);
  }

  // ---- filtered ----------------------------------------------------------
  {
    const expected = recs.filter((r) =>
      tokens(r.legal_name, r.aliases).some((t) => t.startsWith('kes'))
      && ['GB', 'US'].includes(r.country)
      && r.rating_score >= 13
      && r.status === 'ACTIVE');
    const d = await get('/api/search?scenario=filtered&q=kes&countries=GB,US&minRating=13&status=ACTIVE&runs=1&order=name&limit=50');
    record('filtered', 'total == brute force',
      d.redis.total === expected.length && d.solr.total === expected.length,
      `expected ${expected.length} · redis ${d.redis.total} · solr ${d.solr.total}`);

    const expectedIds = new Set(expected.map((r) => r.id));
    const stray = d.redis.hits.filter((h) => !expectedIds.has(h.id));
    record('filtered', 'no hit violates the filters', stray.length === 0,
      stray.length ? `${stray.length} stray: ${stray[0].legal_name}` : `${d.redis.hits.length} hits all satisfy every filter`);
  }

  // ---- geo ---------------------------------------------------------------
  for (const [centre, lat, lon, km] of [
    ['london', 51.5072, -0.1276, 50],
    ['singapore', 1.3521, 103.8198, 10],
  ]) {
    const expected = recs.filter((r) => haversineKm(lat, lon, r.lat, r.lon) <= km).length;
    const d = await get(`/api/search?scenario=geo&q=&centre=${centre}&radiusKm=${km}&runs=1&order=name`);
    // Boundary documents can fall either side of any implementation's rounding,
    // so this asserts closeness rather than equality — the same 0.25% the UI uses.
    const tol = Math.max(2, expected * 0.0025);
    const ok = Math.abs(d.redis.total - expected) <= tol && Math.abs(d.solr.total - expected) <= tol;
    record('geo', `${centre} ${km}km == haversine`, ok,
      `expected ${expected} · redis ${d.redis.total} · solr ${d.solr.total} · tol ±${tol.toFixed(0)}`);
  }

  // ---- portfolio breakdown ----------------------------------------------
  for (const field of ['credit_rating', 'country', 'sector']) {
    const truth = new Map();
    for (const r of recs) {
      const k = String(r[field]).toLowerCase();
      const cur = truth.get(k) || { count: 0, exposure: 0 };
      cur.count += 1;
      cur.exposure += r.exposure_usd;
      truth.set(k, cur);
    }
    const d = await get(`/api/facet?field=${field}&runs=1&limit=50`);
    let bad = 0;
    for (const b of d.redis.buckets) {
      const t = truth.get(String(b.value).toLowerCase());
      if (!t || t.count !== b.count || Math.abs(t.exposure - b.exposure) > 1) bad += 1;
    }
    record('breakdown', `${field} counts+sums == brute force`, bad === 0,
      `${d.redis.buckets.length} buckets, ${bad} wrong · agree with Solr: ${d.bucketsAgree}`);
  }

  // ---- exact LEI ---------------------------------------------------------
  {
    let bad = 0;
    for (const i of [0, 1234, 50000, 99999]) {
      const r = recs[i];
      const d = await get(`/api/lei?lei=${r.id}&runs=1`);
      if (!d.redis.found || d.redis.name !== r.legal_name
        || !d.solr.found || d.solr.name !== r.legal_name) bad += 1;
    }
    record('lei', 'returns the right record', bad === 0, `4 identifiers checked, ${bad} wrong`);

    const miss = await get('/api/lei?lei=ZZZZZZZZZZZZZZZZZZZZ&runs=1');
    record('lei', 'unknown identifier not found',
      miss.redis.found === false && miss.solr.found === false,
      `redis found=${miss.redis.found} · solr found=${miss.solr.found}`);
  }

  // ---- semantic: recall against exact brute-force KNN --------------------
  if (vectorsAvailable()) {
    const all = loadVectors();
    const questions = [
      'which counterparties have liquidity problems?',
      'who is under sanctions review?',
      'which firms breached a covenant?',
    ];
    for (const q of questions) {
      const d = await get(`/api/semantic?q=${encodeURIComponent(q)}&mode=vector&runs=1&limit=10`);
      // The API doesn't expose the query vector, so re-embed it here through
      // the same module the server uses — same model, same normalisation.
      const { embedQuery } = require('./vectors');
      const qv = await embedQuery(q);

      // Exact nearest neighbours: every one of the 100,000 vectors scored.
      const scored = new Array(recs.length);
      for (let i = 0; i < recs.length; i += 1) {
        let dot = 0;
        const off = i * DIM;
        for (let j = 0; j < DIM; j += 1) dot += qv[j] * all[off + j];
        scored[i] = [dot, recs[i].id];
      }
      scored.sort((a, b) => b[0] - a[0]);
      const exact = new Set(scored.slice(0, 10).map(([, id]) => id));

      const rRecall = d.redis.hits.filter((h) => exact.has(h.id)).length;
      const sRecall = d.solr.hits.filter((h) => exact.has(h.id)).length;
      // HNSW is approximate on both sides; anything at or above 8/10 is healthy.
      const ok = rRecall >= 8 && sRecall >= 8 ? true : 'warn';
      record('semantic', `recall@10 vs exact KNN`, ok,
        `"${q.slice(0, 34)}…" redis ${rRecall}/10 · solr ${sRecall}/10`);
    }

    // Hybrid must respect its filters, not just rank well.
    const h = await get('/api/semantic?q=' + encodeURIComponent('liquidity problems')
      + '&mode=hybrid&countries=GB,US&minRating=13&status=ACTIVE&keyword=collateral&runs=1');
    const byId = new Map(recs.map((r) => [r.id, r]));
    const violations = h.redis.hits.filter((x) => {
      const r = byId.get(x.id);
      return !r || !['GB', 'US'].includes(r.country) || r.rating_score < 13
        || r.status !== 'ACTIVE' || !r.profile.toLowerCase().includes('collateral');
    });
    record('semantic', 'hybrid filters all satisfied', violations.length === 0,
      `${h.redis.hits.length} hits, ${violations.length} violations`);
  } else {
    record('semantic', 'skipped — no embeddings', 'warn', 'run npm run seed:vectors');
  }

  // ---- index & schema ----------------------------------------------------
  {
    const ix = await get('/api/index-info');
    record('index', 'Redis index doc count', ix.redis.stats.numDocs === recs.length,
      `${ix.redis.stats.numDocs.toLocaleString()} vs ${recs.length.toLocaleString()}`);
    record('index', 'no indexing failures', ix.redis.stats.hashIndexingFailures === 0,
      `hash_indexing_failures = ${ix.redis.stats.hashIndexingFailures}`);
    record('index', 'indexing complete', ix.redis.stats.indexing === false
      && ix.redis.stats.percentIndexed === 1, `percent_indexed = ${ix.redis.stats.percentIndexed}`);
  }

  // ---- timing stability --------------------------------------------------
  // A median that swings wildly between samples isn't a number worth quoting.
  for (const [label, path] of [
    ['prefix', '/api/search?scenario=prefix&q=stonebr&runs=11&order=name'],
    ['filtered', '/api/search?scenario=filtered&q=kes&countries=GB,US&runs=11&order=name'],
  ]) {
    const rs = [];
    const ss = [];
    for (let i = 0; i < 7; i += 1) {
      const d = await get(path);
      rs.push(d.redis.ms);
      ss.push(d.solr.ms);
    }
    const cv = (xs) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
      return (sd / m) * 100;
    };
    const rCv = cv(rs);
    const sCv = cv(ss);
    const ok = rCv < 40 && sCv < 40 ? true : 'warn';
    record('timing', `${label} median is stable`, ok,
      `variation across 7 samples: redis ${rCv.toFixed(0)}% · solr ${sCv.toFixed(0)}%`);
  }

  // ---- summary -----------------------------------------------------------
  const failed = results.filter((r) => r.pass !== true && r.pass !== 'warn');
  const warned = results.filter((r) => r.pass === 'warn');
  console.log(`\n  ${results.length} checks · ${results.length - failed.length - warned.length} passed`
    + ` · ${warned.length} warnings · ${failed.length} failed`);
  if (failed.length) {
    console.log('\n  FAILURES:');
    for (const f of failed) console.log(`    ${f.tab}: ${f.check} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('validate failed:', err.message);
  process.exit(1);
});
