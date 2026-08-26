'use strict';

// Loads the same generated counterparties into Solr and defines an equivalent
// schema.
//
// Fairness matters here more than anywhere else in this demo. Solr gets:
//   - explicitly declared fields (not dynamic-field fallbacks)
//   - text_general analysis on the name fields, which is Solr's standard
//     tokenise + lowercase chain — the closest equivalent to Redis TEXT
//   - string fields for the filter facets, so filters are exact-match and
//     docValues-backed, exactly as TAG fields are in Redis
//   - a proper hard commit and a warm-up pass before any timing is taken
//
// A hobbled Solr would make the demo useless: the first thing a search
// architect does is read this file.

const fs = require('fs');
const readline = require('readline');
const { SOLR_URL, DATA_FILE } = require('./config');

const BATCH = 5000;

// Mirrors the Redis schema field for field.
//   text_general <-> TEXT     (tokenised, supports term~ fuzzy and term* prefix)
//   string       <-> TAG      (exact match, for filter queries)
//   pint/pdouble/plong <-> NUMERIC (range queries)
// multiValued: false on every field. Solr's text_general defaults to
// multi-valued, which makes it return ["Kestrel Capital AG"] where Redis
// returns "Kestrel Capital AG" — a single Hash field. Declaring them
// single-valued keeps the two engines structurally identical rather than
// papering over the difference in the response handler.
const FIELDS = [
  { name: 'legal_name', type: 'text_general', indexed: true, stored: true, multiValued: false },
  // Sort-only companion to legal_name. You can't sort on a tokenised text
  // field, so this holds an untokenised copy with docValues.
  //
  // It is populated *lowercased* on purpose. Redis normalises SORTABLE TEXT to
  // lowercase, while a Solr `string` field sorts by raw bytes — so with the
  // original casing, "Kestrel Capital plc" and "Kestrel Capital Pty Ltd" would
  // order differently on the two engines ('P' is 0x50, 'p' is 0x70). Matching
  // Redis's normalisation is what makes the two panes line up exactly.
  { name: 'legal_name_sort', type: 'string', indexed: false, stored: false, docValues: true, multiValued: false },
  { name: 'aliases', type: 'text_general', indexed: true, stored: true, multiValued: false },
  { name: 'parent_name', type: 'text_general', indexed: true, stored: true, multiValued: false },
  { name: 'city', type: 'text_general', indexed: true, stored: true, multiValued: false },
  { name: 'country', type: 'string', indexed: true, stored: true, docValues: true, multiValued: false },
  { name: 'jurisdiction', type: 'string', indexed: true, stored: true, docValues: true, multiValued: false },
  { name: 'entity_type', type: 'string', indexed: true, stored: true, docValues: true, multiValued: false },
  { name: 'sector', type: 'string', indexed: true, stored: true, docValues: true, multiValued: false },
  { name: 'credit_rating', type: 'string', indexed: true, stored: true, docValues: true, multiValued: false },
  { name: 'status', type: 'string', indexed: true, stored: true, docValues: true, multiValued: false },
  { name: 'rating_score', type: 'pint', indexed: true, stored: true, docValues: true, multiValued: false },
  { name: 'risk_score', type: 'pdouble', indexed: true, stored: true, docValues: true, multiValued: false },
  { name: 'exposure_usd', type: 'plong', indexed: true, stored: true, docValues: true, multiValued: false },
  { name: 'onboarded_at', type: 'plong', indexed: true, stored: true, docValues: true, multiValued: false },
  // Solr's `location` type is LatLonPointSpatialField, which takes "lat,lon".
  // Redis GEO takes "lon,lat". The seeders below write each in its own order —
  // swapping them silently relocates every counterparty and the two engines
  // then disagree about what's within a radius.
  { name: 'location', type: 'location', indexed: true, stored: true, multiValued: false },
];

async function solrPost(pathname, body) {
  const res = await fetch(`${SOLR_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

async function solrGet(pathname) {
  const res = await fetch(`${SOLR_URL}${pathname}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function ensureSchema() {
  const existing = await solrGet('/schema/fields?wt=json');
  const have = new Set(existing.fields.map((f) => f.name));

  const toAdd = FIELDS.filter((f) => !have.has(f.name));
  const toReplace = FIELDS.filter((f) => have.has(f.name));

  // Schema API: declares the fields up front rather than letting Solr guess
  // types from the first document it sees. Existing fields are replaced rather
  // than skipped, so re-running the seeder after a schema edit actually
  // applies it instead of silently keeping the old definition.
  if (toAdd.length) {
    await solrPost('/schema', { 'add-field': toAdd });
    console.log(`Added ${toAdd.length} fields to the Solr schema`);
  }
  if (toReplace.length) {
    await solrPost('/schema', { 'replace-field': toReplace });
    console.log(`Reconciled ${toReplace.length} existing fields`);
  }
}

// `docker compose up -d` returns as soon as the containers start, not when Solr
// is ready to serve — its first boot has to create the core. On this machine
// Solr happened to come up during the Redis seed, so the documented steps
// worked; on a slower laptop, or the first run where the images are still being
// pulled, the seeder would hit a Solr that isn't listening yet and fail with a
// connection error. Waiting here makes the documented path reliable instead of
// timing-dependent, and beats telling people to insert a sleep.
async function waitForSolr(timeoutMs = 120000) {
  const started = Date.now();
  let announced = false;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${SOLR_URL}/admin/ping?wt=json`);
      if (res.ok) {
        if (announced) console.log(` ready after ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return;
      }
    } catch {
      // Not listening yet.
    }
    if (!announced) {
      process.stdout.write('Waiting for Solr to accept connections...');
      announced = true;
    } else {
      process.stdout.write('.');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Solr did not become ready within ${timeoutMs / 1000}s at ${SOLR_URL}. `
    + 'Check `docker compose ps` and `docker compose logs solr`.'
  );
}

async function main() {
  console.log(`Solr at ${SOLR_URL}`);
  await waitForSolr();

  // Clean slate, same as FLUSHALL on the Redis side.
  await solrPost('/update?commit=true', { delete: { query: '*:*' } });
  console.log('Cleared existing documents');

  await ensureSchema();

  const loadStarted = Date.now();
  let count = 0;
  let batch = [];
  let postMs = 0;

  const flush = async () => {
    const t0 = Date.now();
    // No commit on these posts — documents accumulate in the indexing buffer
    // and are not searchable yet. That is Solr's design, and the commit cost
    // below is a real part of its write path, so it gets measured separately
    // rather than hidden inside the loop.
    await solrPost('/update', batch);
    postMs += Date.now() - t0;
    batch = [];
  };

  const stream = readline.createInterface({
    input: fs.createReadStream(DATA_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of stream) {
    if (!line) continue;
    const rec = JSON.parse(line);
    batch.push({
      id: rec.id,
      legal_name: rec.legal_name,
      legal_name_sort: rec.legal_name.toLowerCase(),
      aliases: rec.aliases,
      parent_name: rec.parent_name,
      city: rec.city,
      country: rec.country,
      jurisdiction: rec.jurisdiction,
      entity_type: rec.entity_type,
      sector: rec.sector,
      credit_rating: rec.credit_rating,
      rating_score: rec.rating_score,
      risk_score: rec.risk_score,
      exposure_usd: rec.exposure_usd,
      status: rec.status,
      onboarded_at: rec.onboarded_at,
      // "lat,lon" — the order Solr expects, the reverse of Redis.
      location: `${rec.lat},${rec.lon}`,
    });

    count += 1;
    if (batch.length >= BATCH) {
      await flush();
      if (count % 20000 === 0) console.log(`  ${count.toLocaleString()} posted...`);
    }
  }
  if (batch.length) await flush();

  // Until this returns, nothing posted above is searchable. Redis had no
  // equivalent step — its writes were queryable as they landed.
  const commitStarted = Date.now();
  await solrPost('/update?commit=true&waitSearcher=true', {});
  const commitMs = Date.now() - commitStarted;

  const totalMs = Date.now() - loadStarted;

  const check = await solrGet('/select?q=*:*&rows=0&wt=json');
  const indexed = check.response.numFound;

  console.log(`\nPosted ${count.toLocaleString()} documents in ${totalMs} ms`);
  console.log(`  post time:  ${postMs} ms`);
  console.log(`  commit:     ${commitMs} ms  <- Redis has no equivalent step`);
  console.log(`  rate:       ${Math.round(count / (totalMs / 1000)).toLocaleString()} docs/sec`);
  console.log(`  searchable: ${indexed.toLocaleString()} docs`);

  if (indexed !== count) {
    console.error(`\nMISMATCH: posted ${count} but Solr reports ${indexed} searchable`);
    process.exitCode = 1;
  }

  // Warm-up. Solr's first query per shape pays for JIT, filter-cache fills and
  // field-cache loading. Timing a cold Solr against a warm Redis would be a
  // cheap trick, so the caches get primed here instead.
  console.log('\nWarming Solr caches (JIT, filterCache, docValues)...');
  const warm = [
    '/select?q=legal_name:kestrel&rows=10&wt=json',
    '/select?q=legal_name:kestral~1&rows=10&wt=json',
    '/select?q=legal_name:kes*&rows=10&wt=json',
    '/select?q=*:*&fq=country:(GB OR US)&fq=status:ACTIVE&fq=rating_score:[13 TO *]&rows=10&wt=json',
  ];
  for (let pass = 0; pass < 3; pass += 1) {
    for (const q of warm) await solrGet(q);
  }
  console.log('Warm-up complete');
}

main().catch((err) => {
  console.error('Seeding Solr failed:', err.message);
  process.exit(1);
});
