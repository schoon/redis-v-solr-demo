'use strict';

// Loads the generated counterparties into Redis as Hashes and builds the
// search index over them.
//
// Note the ordering: the index is created BEFORE the data is written. Redis
// indexes synchronously on write, so by the time the last HSET returns the
// index is already queryable — there is no commit step and no visibility lag.
// That difference is one of the things this demo exists to show, so it's worth
// seeing it in the seeding code rather than only in the query latency.

const fs = require('fs');
const readline = require('readline');
const { createClient, SchemaFieldTypes } = require('redis');
const { REDIS_URL, REDIS_PREFIX, REDIS_INDEX, DATA_FILE } = require('./config');
const { ftInfo } = require('./ft-info');

const BATCH = 2000;

async function main() {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err) => console.error('Redis error:', err.message || err.code || err));
  await client.connect();
  console.log(`Connected to Redis at ${REDIS_URL}`);

  // FLUSHALL — this container is dedicated to the demo, so a clean slate each
  // run keeps the comparison honest (no leftovers inflating or deflating counts).
  await client.flushAll();

  // FT.CREATE cp:idx ON HASH PREFIX 1 cp: SCHEMA ...
  // The index attaches to every key matching the prefix. Nothing copies the
  // data — the index points at the Hashes that already live in the keyspace.
  //
  // Field types drive what queries are possible:
  //   TEXT    — tokenised, stemmed, supports fuzzy (%term%) and prefix (term*)
  //   TAG     — exact-match sets, for the filters an analyst screens on
  //   NUMERIC — range queries, e.g. "rating BBB- or better"
  // WEIGHT boosts legal_name over aliases so an exact legal-name hit ranks
  // above an alias hit. SORTABLE keeps a sortable copy for ORDER BY.
  const started = Date.now();
  await client.ft.create(
    REDIS_INDEX,
    {
      legal_name: { type: SchemaFieldTypes.TEXT, WEIGHT: 5, SORTABLE: true },
      aliases: { type: SchemaFieldTypes.TEXT, WEIGHT: 2 },
      parent_name: { type: SchemaFieldTypes.TEXT },
      city: { type: SchemaFieldTypes.TEXT },
      // SORTABLE on the TAG fields is the counterpart to docValues:true on the
      // Solr side. It keeps a column-oriented copy, which is what FT.AGGREGATE
      // needs to group without loading each Hash. Every field that the facet
      // scenario can GROUPBY gets it, so neither engine is grouping from a
      // row store while the other reads columns.
      country: { type: SchemaFieldTypes.TAG, SORTABLE: true },
      jurisdiction: { type: SchemaFieldTypes.TAG },
      entity_type: { type: SchemaFieldTypes.TAG, SORTABLE: true },
      sector: { type: SchemaFieldTypes.TAG, SORTABLE: true },
      credit_rating: { type: SchemaFieldTypes.TAG, SORTABLE: true },
      status: { type: SchemaFieldTypes.TAG, SORTABLE: true },
      rating_score: { type: SchemaFieldTypes.NUMERIC, SORTABLE: true },
      risk_score: { type: SchemaFieldTypes.NUMERIC, SORTABLE: true },
      exposure_usd: { type: SchemaFieldTypes.NUMERIC, SORTABLE: true },
      onboarded_at: { type: SchemaFieldTypes.NUMERIC, SORTABLE: true },
      // GEO indexes a "lon,lat" string and enables radius queries.
      // Note the ordering — lon first. Solr's equivalent field wants lat first.
      location: { type: SchemaFieldTypes.GEO },
    },
    { ON: 'HASH', PREFIX: REDIS_PREFIX }
  );
  console.log(`Created index ${REDIS_INDEX} in ${Date.now() - started} ms`);

  const loadStarted = Date.now();
  let count = 0;
  let batch = [];

  const flush = async () => {
    // HSET cp:<id> field value ...
    // Issued concurrently so node-redis pipelines them into one round trip
    // per batch instead of one per record.
    await Promise.all(batch);
    batch = [];
  };

  const stream = readline.createInterface({
    input: fs.createReadStream(DATA_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of stream) {
    if (!line) continue;
    const rec = JSON.parse(line);

    // Hash values are strings, so numerics are stored as their decimal
    // representation. The NUMERIC index parses them — no separate typed
    // column is needed.
    batch.push(
      client.hSet(`${REDIS_PREFIX}${rec.id}`, {
        id: rec.id,
        legal_name: rec.legal_name,
        aliases: rec.aliases,
        parent_name: rec.parent_name,
        city: rec.city,
        country: rec.country,
        jurisdiction: rec.jurisdiction,
        entity_type: rec.entity_type,
        sector: rec.sector,
        credit_rating: rec.credit_rating,
        status: rec.status,
        rating_score: String(rec.rating_score),
        risk_score: String(rec.risk_score),
        exposure_usd: String(rec.exposure_usd),
        onboarded_at: String(rec.onboarded_at),
        // "lon,lat" — the order Redis GEO expects.
        location: `${rec.lon},${rec.lat}`,
      })
    );

    count += 1;
    if (batch.length >= BATCH) {
      await flush();
      if (count % 20000 === 0) console.log(`  ${count.toLocaleString()} loaded...`);
    }
  }
  if (batch.length) await flush();

  const loadMs = Date.now() - loadStarted;

  // FT.INFO cp:idx — confirms how many documents the index actually holds.
  // Worth asserting rather than assuming: a silent indexing failure would
  // otherwise show up as suspiciously fast queries returning nothing.
  //
  // Read through ftInfo() rather than client.ft.info(): the client's positional
  // parser is shifted against Redis 8's reply, and `indexing` came back as a
  // float. That's why this used to print "still running" after it had finished.
  const info = await ftInfo(client, REDIS_INDEX);
  const indexed = info.stats.numDocs;

  console.log(`\nLoaded ${count.toLocaleString()} Hashes in ${loadMs} ms`);
  console.log(`  rate:     ${Math.round(count / (loadMs / 1000)).toLocaleString()} docs/sec`);
  console.log(`  indexed:  ${indexed.toLocaleString()} docs (FT.INFO num_docs)`);
  console.log(`  indexing: ${info.stats.indexing ? 'still running' : 'complete'} (${(info.stats.percentIndexed * 100).toFixed(0)}%)`);
  console.log(`  index mem: ${info.stats.totalIndexMemorySzMb.toFixed(1)} MB`
    + ` (${info.stats.sortableValuesSizeMb.toFixed(1)} MB of it SORTABLE copies)`);

  if (indexed !== count) {
    console.error(`\nMISMATCH: loaded ${count} but index reports ${indexed}`);
    process.exitCode = 1;
  }

  await client.quit();
}

main().catch((err) => {
  console.error('Seeding Redis failed:', err.message || err.code || err);
  process.exit(1);
});
