'use strict';

// Embeds each counterparty's narrative credit-review note into a vector, and
// writes them to data/vectors.f32 as raw little-endian float32 in file order.
//
// Runs entirely locally: all-MiniLM-L6-v2 via transformers.js, no API key and no
// network once the model is cached. That matters for a laptop demo — an
// embedding API would make the vector tab depend on connectivity and a key, and
// would put per-query cost between the presenter and the point being made.
//
// 384 dimensions rather than a larger model on purpose: 100k × 384 × 4 bytes is
// ~153 MB per engine, which fits a laptop comfortably. A 1536-dim model would be
// 600 MB per side before either engine's index overhead.

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { DATA_FILE } = require('./config');

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;
const BATCH = 256;

const VECTOR_FILE = path.join(path.dirname(DATA_FILE), 'vectors.f32');
const META_FILE = path.join(path.dirname(DATA_FILE), 'vectors.meta.json');

async function main() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error(`${DATA_FILE} not found — run: npm run generate`);
  }

  // transformers.js is ESM-only; this file is CommonJS like the rest of src/.
  const { pipeline } = await import('@xenova/transformers');
  process.stdout.write(`Loading ${MODEL}...`);
  const started = Date.now();
  const extract = await pipeline('feature-extraction', MODEL);
  console.log(` ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const profiles = [];
  const stream = readline.createInterface({
    input: fs.createReadStream(DATA_FILE),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    if (!line) continue;
    const rec = JSON.parse(line);
    if (!rec.profile) {
      throw new Error('records have no `profile` field — re-run: npm run generate');
    }
    // Embed the narrative WITHOUT the leading identity sentence.
    //
    // The full profile opens with "<legal name> is a GB-domiciled bank operating
    // in the banking sector, headquartered in London." Embedding that made the
    // name tokens dominate similarity: every top-10 came back sharing one stem
    // (ten Ellesmere entities, ten Saltmarsh entities), which looks like name
    // matching rather than semantic matching and undercuts the whole point.
    // The identity sentence stays in `profile` for display and for the lexical
    // half of hybrid search — it just isn't what the vector represents.
    const narrative = rec.profile.slice(rec.profile.indexOf('. ') + 2);
    profiles.push(narrative);
  }
  console.log(`Embedding ${profiles.length.toLocaleString()} profiles in batches of ${BATCH}`);

  const out = new Float32Array(profiles.length * DIM);
  const t0 = Date.now();

  for (let i = 0; i < profiles.length; i += BATCH) {
    const batch = profiles.slice(i, i + BATCH);
    // normalize:true gives unit vectors, so cosine similarity is a dot product
    // and both engines can be configured for COSINE without rescaling.
    const res = await extract(batch, { pooling: 'mean', normalize: true });
    out.set(res.data, i * DIM);

    if ((i / BATCH) % 20 === 0 && i > 0) {
      const done = i + batch.length;
      const rate = done / ((Date.now() - t0) / 1000);
      const left = (profiles.length - done) / rate;
      process.stdout.write(
        `\r  ${done.toLocaleString()} / ${profiles.length.toLocaleString()}`
        + `  ${Math.round(rate)} docs/sec  ~${Math.ceil(left)}s left   `
      );
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  process.stdout.write('\r'.padEnd(70) + '\r');
  console.log(`Embedded in ${elapsed.toFixed(1)}s (${Math.round(profiles.length / elapsed)} docs/sec)`);

  fs.writeFileSync(VECTOR_FILE, Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  fs.writeFileSync(META_FILE, JSON.stringify({
    model: MODEL, dim: DIM, count: profiles.length,
  }, null, 2));

  console.log(`  ${VECTOR_FILE}`);
  console.log(`  ${(fs.statSync(VECTOR_FILE).size / 1024 / 1024).toFixed(1)} MB, ${DIM} dims, ${profiles.length.toLocaleString()} vectors`);
  console.log('\nNow load them:  npm run seed:redis && npm run seed:solr');
}

main().catch((err) => {
  console.error('Embedding failed:', err.message);
  process.exit(1);
});
