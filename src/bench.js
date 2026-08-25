'use strict';

// Concurrent throughput benchmark: QPS and tail latency under load.
//
// Deliberately a CLI tool rather than a button in the web UI. Generating load
// from inside the same Node process that serves the page would have the load
// generator competing with the thing being measured, and the numbers would be
// describing the demo server rather than the engines.
//
// Three design decisions that matter for the numbers to mean anything:
//
// 1. worker_threads, not one event loop. A single-threaded client saturates
//    long before Redis does — you end up benchmarking Node's JSON parsing. Each
//    worker gets its own Redis connection and its own HTTP agent.
// 2. The engines are measured SEQUENTIALLY, never at the same time. Running
//    both at once on the same 14 cores would have them competing, and both
//    numbers would be wrong.
// 3. Client CPU is reported alongside the results. If the client is pinned, the
//    figure is a client limit rather than an engine limit, and you need to know
//    that rather than quote it.
//
// Usage:
//   npm run bench
//   npm run bench -- --scenario=filtered --concurrency=32 --duration=10

const os = require('os');
const path = require('path');
const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { createClient } = require('redis');
const { REDIS_URL, SOLR_URL, DATA_FILE } = require('./config');
const { sanitize, redisSearchArgs, solrParams, redisLeiKey, solrLeiParams } = require('./queries');

const RESULTS_FILE = path.join(path.dirname(DATA_FILE), 'bench-results.json');

// A pool of distinct queries, rotated through by the workers. Hammering one
// query would mostly measure Solr's filterCache; rotating a realistic spread
// is closer to production and doesn't hand either engine a free ride.
const TERM_POOL = [
  'kes', 'stone', 'aber', 'black', 'dray', 'farr', 'holl', 'iron', 'kelv',
  'lark', 'moor', 'neth', 'oster', 'pine', 'red', 'salt', 'tan', 'under',
  'ver', 'whit', 'cran', 'dover', 'elles', 'bex', 'mer', 'north', 'ald',
];

const FILTER_SETS = [
  { countries: ['GB', 'US'], status: 'ACTIVE', minRating: 13 },
  { countries: ['DE', 'FR'], status: 'ACTIVE', minRating: 16 },
  { countries: ['JP', 'SG'], status: '', minRating: 10 },
  { countries: ['CH'], status: 'ACTIVE', minRating: 19 },
];

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// ---------------------------------------------------------------- worker

if (!isMainThread) {
  const { engine, scenario, durationMs, workerIndex, leis } = workerData;

  (async () => {
    const latencies = [];
    let errors = 0;
    let redis;

    if (engine === 'redis') {
      redis = createClient({ url: REDIS_URL });
      redis.on('error', () => { errors += 1; });
      await redis.connect();
    }

    // Each worker starts at a different point in the pool so they aren't all
    // issuing the same query at the same instant.
    let i = workerIndex * 7;
    const deadline = nowMs() + durationMs;

    while (nowMs() < deadline) {
      i += 1;
      const term = TERM_POOL[i % TERM_POOL.length];
      const filters = {
        ...FILTER_SETS[i % FILTER_SETS.length],
        entityTypes: [], sectors: [], maxRisk: NaN, minExposure: NaN,
        onboardedSince: NaN, geo: null,
      };
      const lei = leis[i % leis.length];

      const t0 = nowMs();
      try {
        if (engine === 'redis') {
          if (scenario === 'lei') {
            await redis.hGetAll(redisLeiKey(lei));
          } else {
            const { index, query, options } = redisSearchArgs(
              scenario, sanitize(term), filters, 10, 'relevance'
            );
            await redis.ft.search(index, query, options);
          }
        } else if (scenario === 'lei') {
          const res = await fetch(`${SOLR_URL}/select?${solrLeiParams(lei).toString()}`);
          await res.json();
        } else {
          const params = solrParams(scenario, sanitize(term), filters, 10, 'relevance');
          const res = await fetch(`${SOLR_URL}/select?${params.toString()}`);
          await res.json();
        }
        latencies.push(nowMs() - t0);
      } catch {
        errors += 1;
      }
    }

    if (redis) await redis.quit();

    // No CPU accounting here on purpose: process.cpuUsage() inside a worker
    // reports the whole process, not the thread, so summing it across workers
    // multiplies the same figure by the worker count. The main thread measures
    // it once instead.
    parentPort.postMessage({ latencies, errors });
  })().catch((err) => {
    parentPort.postMessage({ latencies: [], errors: 1, fatal: err.message });
  });

  return;
}

// ---------------------------------------------------------------- main

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

async function runEngine(engine, scenario, concurrency, durationMs, leis) {
  const workers = [];
  const results = [];
  // Process-wide, so it covers the main thread and every worker exactly once.
  const cpu0 = process.cpuUsage();
  const wall0 = nowMs();

  for (let w = 0; w < concurrency; w += 1) {
    workers.push(new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: { engine, scenario, durationMs, workerIndex: w, leis },
      });
      worker.on('message', (m) => { results.push(m); resolve(); });
      worker.on('error', reject);
    }));
  }
  await Promise.all(workers);

  const wallMs = nowMs() - wall0;
  const cpu1 = process.cpuUsage(cpu0);
  const cpuMs = (cpu1.user + cpu1.system) / 1000;
  const all = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const errors = results.reduce((n, r) => n + r.errors, 0);

  return {
    engine,
    count: all.length,
    errors,
    wallMs: Number(wallMs.toFixed(0)),
    qps: Math.round(all.length / (wallMs / 1000)),
    p50: Number(percentile(all, 50).toFixed(3)),
    p95: Number(percentile(all, 95).toFixed(3)),
    p99: Number(percentile(all, 99).toFixed(3)),
    max: Number((all[all.length - 1] || 0).toFixed(3)),
    // Client CPU seconds consumed per wall second. Compare against the number
    // of cores: if this approaches the core count, the load generator is the
    // bottleneck and the QPS figure is a client limit.
    clientCpuRatio: Number((cpuMs / wallMs).toFixed(2)),
  };
}

async function main() {
  const scenario = arg('scenario', 'prefix');
  const concurrency = Math.min(Number(arg('concurrency', 16)), 64);
  const durationMs = Number(arg('duration', 10)) * 1000;
  const warmupMs = 2000;
  const cores = os.cpus().length;

  if (!['prefix', 'filtered', 'fuzzy', 'lei'].includes(scenario)) {
    console.error(`unknown scenario "${scenario}" — use prefix | filtered | fuzzy | lei`);
    process.exit(1);
  }

  // Real identifiers for the lei scenario, pulled once up front.
  const seed = createClient({ url: REDIS_URL });
  await seed.connect();
  const sample = await seed.ft.search('cp:idx', '*', { LIMIT: { from: 0, size: 200 }, RETURN: ['id'] });
  const leis = sample.documents.map((d) => d.value.id);
  const corpus = Number((await seed.ft.info('cp:idx')).numDocs);
  await seed.quit();

  console.log(`Concurrent throughput — scenario "${scenario}"`);
  console.log(`  corpus:      ${corpus.toLocaleString()} counterparties`);
  console.log(`  concurrency: ${concurrency} worker threads per engine`);
  console.log(`  duration:    ${durationMs / 1000}s measured, ${warmupMs / 1000}s warm-up`);
  console.log(`  host:        ${cores} cores`);
  console.log(`  engines run sequentially, never simultaneously\n`);

  const out = { scenario, corpus, concurrency, durationSec: durationMs / 1000, cores, engines: {} };

  for (const engine of ['redis', 'solr']) {
    process.stdout.write(`  ${engine}: warming up...`);
    await runEngine(engine, scenario, concurrency, warmupMs, leis);
    process.stdout.write(' measuring...');
    const r = await runEngine(engine, scenario, concurrency, durationMs, leis);
    out.engines[engine] = r;
    process.stdout.write(' done\n');
  }

  const r = out.engines.redis;
  const s = out.engines.solr;

  console.log('\n           QPS        p50       p95       p99       max     errors');
  for (const e of [r, s]) {
    console.log(
      `  ${e.engine.padEnd(6)} ${String(e.qps).padStart(8)}  ` +
      `${e.p50.toFixed(2).padStart(8)}  ${e.p95.toFixed(2).padStart(8)}  ` +
      `${e.p99.toFixed(2).padStart(8)}  ${e.max.toFixed(2).padStart(8)}  ${String(e.errors).padStart(6)}`
    );
  }
  console.log(`\n  throughput ratio: ${(r.qps / s.qps).toFixed(2)}x  (redis / solr)`);

  // Saturation disclosure. Without this the QPS numbers can't be interpreted.
  console.log('\n  client CPU per wall second (vs %d cores):', cores);
  for (const e of [r, s]) {
    const pct = ((e.clientCpuRatio / cores) * 100).toFixed(0);
    const warn = e.clientCpuRatio > cores * 0.8
      ? '  <-- CLIENT-BOUND: this is a load-generator limit, not an engine limit'
      : '';
    console.log(`    ${e.engine.padEnd(6)} ${e.clientCpuRatio.toFixed(2)} (${pct}% of host)${warn}`);
  }

  out.generatedAt = new Date().toISOString();
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
  console.log(`\n  results written to ${RESULTS_FILE}`);
  console.log('  the demo UI reads this file for its Throughput tab');
}

main().catch((err) => {
  console.error('bench failed:', err.message);
  process.exit(1);
});
