'use strict';

// Shared access to the embeddings produced by src/embed.js, plus the one
// function that has to embed at query time: turning the user's English question
// into a vector.
//
// Both seeders and the server use this, so there is a single definition of the
// model, the dimension and the on-disk layout.

const fs = require('fs');
const path = require('path');
const { DATA_FILE } = require('./config');

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;

const VECTOR_FILE = path.join(path.dirname(DATA_FILE), 'vectors.f32');
const META_FILE = path.join(path.dirname(DATA_FILE), 'vectors.meta.json');

function vectorsAvailable() {
  return fs.existsSync(VECTOR_FILE) && fs.existsSync(META_FILE);
}

function readMeta() {
  return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
}

// The whole set as one Float32Array; record i occupies [i*DIM, (i+1)*DIM).
// 153 MB at 100k, which is cheaper to hold once than to seek per record.
function loadVectors() {
  const buf = fs.readFileSync(VECTOR_FILE);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// Redis stores the vector as raw float32 bytes in a Hash field, so it needs a
// Buffer rather than an array.
function vectorBuffer(all, index) {
  return Buffer.from(all.buffer, all.byteOffset + index * DIM * 4, DIM * 4);
}

// Query-time embedding. The pipeline is loaded once and reused — reloading it
// per query would add seconds and make the latency numbers meaningless.
let extractor = null;
async function embedQuery(text) {
  if (!extractor) {
    const { pipeline } = await import('@xenova/transformers');
    extractor = await pipeline('feature-extraction', MODEL);
  }
  const res = await extractor([text], { pooling: 'mean', normalize: true });
  return Array.from(res.data);
}

// Warms the model at server start so the first question a presenter types
// doesn't pay the load cost and look slow.
async function warmEmbedder() {
  await embedQuery('warm up');
}

// Solr's JSON parser rejects vector components whose decimal representation is
// very long. This cost real debugging time, so the finding is recorded here:
//
//   0.0000070493265411641914  (24 chars)  -> HTTP 500, ClassCastException
//   0.00000704932654          (16 chars)  -> HTTP 200
//
// It failed on 1 record in 20 — enough to reject a whole 5,000-document batch
// while single-document posts of the same field succeeded, which is what made it
// look like a batch-size problem rather than a value problem. Redis, taking the
// raw float32 bytes, never cared.
//
// 9 significant digits is the fix: it's the number of decimal digits needed to
// round-trip a float32 exactly, verified as 384/384 components identical after
// the round trip. So Solr receives the same float32 values Redis does — this is
// a serialisation fix, not a precision compromise.
function solrFloats(values) {
  return Array.from(values, (v) => Number(v.toPrecision(9)));
}

module.exports = {
  MODEL, DIM, VECTOR_FILE,
  vectorsAvailable, readMeta, loadVectors, vectorBuffer,
  embedQuery, warmEmbedder, solrFloats,
};
