'use strict';

const path = require('path');

// One place for anything both seeders, the server and the docs need to agree on.
module.exports = {
  // Redis on 6380 so the demo can't collide with a Redis you already run.
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6380',
  SOLR_URL: process.env.SOLR_URL || 'http://localhost:8983/solr/counterparties',
  PORT: process.env.PORT || 3010,

  // Redis key layout: one Hash per counterparty at cp:<id>, indexed by prefix.
  REDIS_PREFIX: 'cp:',
  REDIS_INDEX: 'cp:idx',

  COUNT: Number(process.env.COUNT || 100000),
  DATA_FILE: path.join(__dirname, '..', 'data', 'counterparties.jsonl'),

  // Fixed seed so every run produces byte-identical data. Both engines index
  // the same file, which is what makes the latency comparison meaningful.
  SEED: 20260825,
};
