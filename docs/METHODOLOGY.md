# Methodology, caveats and full results

Read this before presenting. It covers how fairness is enforced, the scenario
Solr wins, why the result largely inverts at a million records, and the things
this demo does not support.

This is vendor-authored competitive material, so the method is stated in full and
the code is short enough to audit. A rigged benchmark is worse than no benchmark:
the first thing a customer's search architect does is read `src/queries.js`.

---

## How fairness is enforced

**What is held identical**

- **Same corpus.** One generator writes `data/counterparties.jsonl`; both seeders
  read that file. A fixed PRNG seed means reruns produce byte-identical data.
- **Same machine, no network.** Both engines run in Docker on the host. Neither
  pays for a network hop the other doesn't.
- **Equivalent schemas.** Fields are declared explicitly on both sides, not left
  to dynamic-field or schemaless inference. `TEXT`↔`text_general`, `TAG`↔`string`
  with docValues, `NUMERIC`↔`pint`/`pdouble`/`plong`, `GEO`↔`location`.
  Name-field boosts are 5 and 2 on both. Every TAG field the breakdown can group
  by carries `SORTABLE`, matching `docValues: true` on the Solr side, so neither
  engine groups from a row store while the other reads columns.
- **Equivalent boolean semantics.** Solr gets `mm=100%` so every term is
  mandatory, matching Redis's default term intersection. This mattered: without
  it, `kestral capitol` returned **158** documents from Redis and **8,662** from
  Solr — the engines were answering different questions and the timing was
  meaningless. (Those counts are from the run that found the bug; the corpus has
  since changed, see *Numbers drift* below.)
- **Equivalent edit distance.** Levenshtein 1 on both sides, and terms of 1–2
  characters are left exact on both — fuzzing them matches nearly everything.
- **Solr's caches are warm.** The seeder runs each query shape three times after
  indexing, so Solr isn't paying JIT, filterCache or docValues load costs on the
  first timed query.
- **HTTP keep-alive.** Node reuses one connection to Solr; verified with `lsof`
  (1 established socket, 0 `TIME_WAIT` after 60 queries). Solr is not being
  charged TCP handshakes.
- **Solr gets the larger memory allowance.** The image defaults to a 512 MB heap,
  which thrashes GC at 1M documents. It's raised to 2 GB so a heap-starved JVM
  isn't mistaken for a slow search engine. Redis has no ceiling either.

**How timing works**

- Each engine runs the query the configured number of times, **alternating which
  goes first**, so neither systematically benefits from running second.
- The **median** is reported, never the minimum.
- Times are wall clock measured in the application via
  `process.hrtime.bigint()` — sub-millisecond resolution, because Redis responses
  land well under 1 ms and `Date.now()` would quantise them to 0 or 1.
- **No speed multiplier is displayed unless both engines returned the same result
  count.** Geo is the single exception, below.

## The honest caveat about Solr's numbers

Solr reports `QTime: 0` — its internal search really is sub-millisecond on this
corpus. Most of its wall clock is HTTP and JSON, not searching.

Both readings are shown in the UI deliberately. The wall-clock figure is what an
application actually waits for, and Redis's figure includes its round trip too,
so the comparison is symmetric. But anyone claiming "Redis's query engine is 4×
faster than Lucene" from this chart is overreading it. What the chart shows is
that **the end-to-end cost of asking Redis a question is several times lower**,
and on this corpus that difference is dominated by transport: a persistent binary
protocol versus HTTP request/response with JSON serialisation. That is a real
architectural difference with real latency consequences — and it is not the same
claim as "Lucene is slow."

## Solr wins the portfolio breakdown

Not included for balance — it's a real result, and it is robust. Over 8 repeated
samples (each a median of 11 runs) Solr won **8 of 8**: median 7.18 ms against
Redis's 10.22 ms. On `sector` the gap is similar. The counts and sums are
identical, so it's like-for-like — Solr's JSON Facet API over column-oriented
docValues is simply very good at this shape of work.

Two things worth knowing about that number:

- **It was much worse before a fairness fix.** Redis first measured ~61 ms,
  because only `country` had `SORTABLE` on it. `SORTABLE` is the counterpart to
  Solr's `docValues: true` — without it, `FT.AGGREGATE` loads each Hash instead
  of reading a column. With `SORTABLE` on every groupable TAG field, Redis went
  from 61 ms to ~10 ms. Solr still wins, but 61 ms would have been a
  misconfiguration on our side presented as a Solr victory.
- **Redis returns lowercase bucket labels** (`a+`, not `A+`) because grouping on a
  `SORTABLE` tag reads the normalised copy. The UI shows each engine's labels as
  returned rather than rewriting them. Preserving the original casing needs
  `LOAD`, which measured roughly 3× slower.

Lead with latency, and if a customer asks about faceting, show them this tab and
say Solr is stronger at it. That answer buys credibility for the rest.

## Result ordering

There's an **order** toggle, defaulting to **name**.

Wildcard and prefix queries are constant-scored on both engines — a search for
`kes*` returned 2,210 hits from Redis all scoring `6.9221677`, and the same 2,210
from Solr all scoring `5.0`. When every match ties, "top 10" is settled by each
engine's internal document order, which differs, so the two panes showed a
different arbitrary ten out of an identical result set. That reads as the engines
disagreeing when they don't.

Sorting both sides by name fixes it: the panes then match row for row, and on a
fully tied result set nothing is lost. Redis sorts on the `SORTABLE` copy of
`legal_name`; Solr sorts on `legal_name_sort`, a lowercased untokenised copy —
lowercased because Redis normalises sortable text to lowercase while a Solr
`string` sorts raw bytes, so otherwise `"…plc"` and `"…Pty Ltd"` would order
differently on the two engines.

Switch to **relevance** to discuss ranking instead. Worth knowing: Redis *does*
differentiate scores on fuzzy queries, so the name sort discards real ranking
information there. That's why it's a toggle and not a hardcoded sort.

## Concurrent throughput

`npm run bench` loads both engines under concurrency and reports QPS with tail
latency.

100k corpus, 14-core host, each engine loaded separately:

| Concurrency | Redis QPS | Solr QPS | Redis p99 | Solr p99 | Redis max | Solr max |
| ----------- | --------- | -------- | --------- | -------- | --------- | -------- |
| 8 | 10,227 | 4,273 | 1.23 ms | 2.58 ms | 3.2 ms | 39.9 ms |
| 16 | 11,401 | 7,776 | 2.69 ms | 3.59 ms | 7.9 ms | 58.9 ms |
| 32 | 11,553 | 8,494 | 5.88 ms | 10.69 ms | 108 ms | 267 ms |
| 48 | 11,848 | **5,377** | 8.17 ms | **53.05 ms** | 219 ms | 295 ms |

**Redis's throughput is flat and Solr's is not monotonic.** Redis saturates around
11–12k QPS and stays there as concurrency climbs. Solr peaks near 8.5k at 32
threads and then *falls* to 5,377 at 48 — past its knee, adding clients makes it
slower. For capacity planning that shape matters more than the peak: one degrades
gracefully, the other has a cliff.

**The tail diverges faster than the median.** At 48 threads the p50 gap is 1.6×
but the p99 gap is 6.5×. Solr's worst case is poor even at low load — 39.9 ms max
at 8 concurrent clients, where Redis is at 3.2 ms — consistent with JVM GC pauses.

`--scenario=lei` is the widest margin: 38,108 QPS against 8,645 (4.4×), p99
0.77 ms against 3.62 ms.

Methodology, since throughput benchmarks are easy to get wrong:

- **worker_threads, not one event loop.** A single-threaded Node client saturates
  before Redis does, and you end up benchmarking JSON parsing. Each worker gets
  its own Redis connection and HTTP agent.
- **Engines are loaded sequentially, never simultaneously.** Both at once on the
  same 14 cores would have them competing and both numbers would be wrong.
- **A rotating pool of 27 distinct query terms and 4 filter sets,** so neither
  engine rides one hot cache entry.
- **Client CPU is reported and checked.** At 48 threads the load generator used
  2.67 of 14 cores driving Redis and 5.67 driving Solr, so these are engine limits
  rather than client limits. The tool prints a `CLIENT-BOUND` warning if that
  stops being true — believe the warning, not the QPS.

### Where query performance factor fits

This is the axis on which Redis Software's [query performance
factor](https://redis.io/docs/latest/operate/oss_and_stack/stack-with-enterprise/search/query-performance-factor/)
applies: it provisions additional vCPUs per shard for the query engine and scales
throughput up to 16×. It is **not** available in the OSS `redis:8` container this
demo uses, and it wouldn't change the single-query latency numbers elsewhere —
it's a throughput lever. If the customer's question is "can this keep up at our
peak," that feature is the answer and this tab is the right place to raise it.
Note the docs are candid that some use cases don't scale effectively, so it needs
measuring rather than asserting.

## At 1,000,000 counterparties the result largely inverts

The 100k numbers do **not** scale. `npm run seed:1m` loads a million records.
Median of 11, `order=relevance`:

| Scenario | Redis | Solr | Winner |
| -------- | ----- | ---- | ------ |
| Exact LEI (`HGETALL`) | 0.32 ms | 2.68 ms | **Redis, 8.3×** |
| Typo-tolerant name | 2.19 ms | 4.09 ms | **Redis, 1.9×** |
| Prefix | 3.57 ms | 3.21 ms | Solr, 1.1× |
| Filtered screening | 6.93 ms | 3.46 ms | Solr, 2.0× |
| Geo, 50 km | 5.00 ms | 3.09 ms | Solr, 1.6× |
| Portfolio breakdown | 76.2 ms | 20.4 ms | Solr, 3.7× |

Redis still wins decisively on **known-key lookup** and clearly on **fuzzy name
matching**. Solr wins prefix, filtering, geo and aggregation. At 100k Redis led
almost everything; at 1M it doesn't.

Some of that gap was self-inflicted:

- **The name sort costs Redis roughly 2× on large result sets.** `SORTBY` sorts
  the whole matching set — prefix `stonebr` matches 22,228 documents and went from
  3.57 ms to 6.53 ms; geo from 5.00 ms to 9.81 ms. Solr sorts via docValues with
  early termination and barely moves. The table uses `order=relevance` to exclude
  this; the UI's default `order=name` is slower for Redis at scale.
- **Solr's filterCache rewards repeated queries, and median-of-N feeds it.**
  Asking the same filtered query 15 times: Solr 3.08 ms vs Redis 6.59 ms (2.0×).
  Asking 12 *distinct* queries once each: Solr 6.00 ms vs Redis 7.22 ms (1.2×).
  Quote the 1.2× for high-cardinality ad-hoc search and the 2× if they re-run
  similar screens.
- **It is not a threading or memory handicap.** `FT.CONFIG GET WORKERS` reports
  14 on a 14-core host, and Solr had the larger heap. `FT.PROFILE` puts 14 ms of
  the filtered query in the `Index` processor: `status:ACTIVE` alone matches
  750,186 documents, and intersecting that with a prefix expansion is real work
  Redis redoes each time.

**What still holds at 1M:**

| | Redis | Solr |
| --- | ----- | ---- |
| Ingest rate | 47,600 docs/sec | 28,500 docs/sec |
| Commit before searchable | none | required |
| Write-to-visible | ~5 ms | until commit, or your soft-commit window |
| Known-key retrieval | `HGETALL`, O(1), index not consulted | query only |

The defensible 1M story is **freshness, ingest and identifier lookup**, not
"faster search across the board". If the customer's corpus is that size and their
workload is prefix, filter and facet heavy, this demo will not support a
Redis-wins conclusion — and pretending otherwise in front of their search team
would be worse than conceding it.

## Write-to-visible latency

Add one counterparty, then search for it:

| | Time until searchable |
|---|---|
| Redis | **5 ms**, no commit parameter, no extra call |
| Solr, default config | **never** — still invisible after 1,500 ms of polling |
| Solr, explicit commit | 63 ms total, but requires an app-level commit call |
| Solr, `commitWithin=1000` | 1,142 ms |
| Solr, `commitWithin=200` | 224 ms |

The default-config row needs its explanation, and it's one to know before a
customer says it: `solr:9` ships `autoCommit maxTime=15000` with
**`openSearcher=false`**, and `autoSoftCommit` commented out. So the hard
autocommit flushes to disk without making anything searchable. Real deployments
set `autoSoftCommit` or `commitWithin` — which is why those are measured too.
Even tuned, you're choosing a staleness window, and tightening it costs searcher
churn and cache invalidation. Redis has no window to choose.

For counterparty reference data that's a compliance-shaped argument, not just a
performance one.

## Memory is deliberately not compared

An earlier draft of the README quoted container memory — Redis ~245 MB against
Solr ~2.3 GB. That comparison was wrong in Redis's favour and has been removed.

Measured properly at 100k:

| | Redis | Solr |
| --- | ----- | ---- |
| Process / heap | 133 MB used | 864 MB heap *used*, of a 2 GB pinned heap |
| Index on disk | n/a — index lives in RAM | **27 MB** |

Three reasons the figures don't compare:

- **The JVM's heap is preallocated,** not consumed. `-Xms2g` means the container
  reports ~2.3 GB whatever the corpus size, and a JVM with headroom doesn't
  collect aggressively — 864 MB "used" is not 864 MB "needed".
- **Solr's index is far smaller in bytes.** 27 MB on disk against roughly 133 MB
  resident in Redis. Lucene keeps a compact on-disk index and leans on the OS
  page cache; Redis holds the data and index in RAM by design. That is the
  architectural trade the latency numbers are buying.
- **The two aren't measuring the same thing.** Redis's RSS is the dataset. Solr's
  RSS is a JVM whose working set includes page cache you can't attribute to the
  process.

If a customer asks about memory, the honest answer is that Redis trades RAM for
latency, Solr trades latency for a smaller resident footprint, and sizing needs
their corpus rather than a number from this demo.

## Index internals

The **Index & schema** tab shows the Redis index definition next to the Solr
schema, with field types lined up row for row. It reconstructs the `FT.CREATE`
that built the index — one command, against a core plus a Schema API declaration
per field. Solr carries one field Redis doesn't, `legal_name_sort`, which exists
only because a tokenised field can't be sorted on.

Where the index memory goes at 100k:

| | MB |
| --- | -- |
| SORTABLE copies | 43.3 |
| inverted index | 10.8 |
| doc table | 9.5 |
| key table | 5.7 |
| **total index memory** | **70.6** |

**Over half the index is SORTABLE copies.** Those are what make the portfolio
breakdown and the name sort fast — the same flags that took aggregation from
61 ms to 10 ms — and they are not free. If someone asks what the query speed
costs, that's the honest answer.

### A node-redis parsing bug worth knowing about

`client.ft.info()` in node-redis v4 uses a positional parser, and Redis 8 returns
fields it doesn't know (`tag_overhead_sz_mb`, `text_overhead_sz_mb`,
`total_index_memory_sz_mb`, `geoshapes_sz_mb`, `number_of_uses`, `cleaning`,
`dialect_stats`, `Index Errors`, `field statistics`). Everything after the first
unknown field comes back shifted. Measured against Redis 8.10.1:

| field | real | `client.ft.info()` reported |
| ----- | ---- | -------------------------- |
| `indexing` | `0` | `5.642642021179199` |
| `percent_indexed` | `1` | `0.6956239342689514` |
| `hash_indexing_failures` | `0` | `20.11318016052246` |
| `total_indexing_time` | `1155.09` | `undefined` |

`num_docs` and the other early fields are fine, which is why it went unnoticed —
the seeder's "indexing: still running" message was this, not a genuine race.
`src/ft-info.js` reads the reply as the key/value map it actually is, so field
order doesn't matter. Use it rather than `client.ft.info()`.

## Three silent-failure traps

These cost real debugging time, and all three produce wrong results rather than
errors.

**Coordinate order is reversed between the engines.** Redis `GEO` takes
`"lon,lat"`; Solr's `LatLonPointSpatialField` takes `"lat,lon"`. Get it backwards
and London lands in the Indian Ocean — no error, just a radius query that quietly
disagrees. The seeders write each in its own order, and the geo scenario is
verified to return identical counts at 10, 50 and 200 km.

**`*` cannot be combined with other clauses in Redis.** `* @location:[…]` is a
syntax error, so with no name terms the wildcard is dropped and the filters stand
alone. Solr's `q=*:*` composes with `fq` happily, which is why this only broke one
side.

**TAG values containing spaces need escaping.** `@sector:{Asset Management}`
silently truncates at the space; it has to be `@sector:{Asset\ Management}`.
Solr's equivalent is quoting: `sector:("Asset Management")`.

### Geo counts can differ by a handful of documents

Expected, and disclosed in the UI. The two engines use different earth models and
coordinate quantisation, so a document sitting essentially on the radius boundary
can fall inside for one and outside for the other. Across all 24 centre/radius
pairs the demo can pick, the largest divergence was 7 documents in 5,215
(Frankfurt at 200 km, 0.134%). The geo scenario therefore accepts a **0.25%**
tolerance — chosen from that measured worst case, not guessed — and the UI prints
the exact document count and percentage whenever the tolerance is what's carrying
the comparison. Every other scenario stays on strict equality: for reference, the
`mm=100%` bug this mechanism is designed to catch produced 158 against 8,662,
which the tolerance rejects by three orders of magnitude.

## Where this comparison does not apply

- **Corpus size.** 100k documents fits comfortably in memory on both sides. Solr's
  architecture is built for corpora far larger than RAM, and this demo says
  nothing about that regime.
- **Distributed operation.** Single-node both sides. No SolrCloud sharding, no
  Redis Cluster.
- **Analysis depth.** Solr's analysis chains, language-specific stemmers, synonym
  graphs and phonetic filters go well beyond what's configured here. Same for
  faceting, pivot facets and grouping.
- **Relevance quality.** This measures latency and result counts, not ranking
  quality. Both engines return sensible top hits, but nobody has judged which
  ordering is *better*.
- **Cold start.** Both are measured warm. Solr's first query per shape pays JIT
  and cache-fill costs that aren't in these numbers.

If a customer pushes on any of those, the honest answer is that this demo doesn't
cover it.

## Numbers drift when the generator changes

The corpus is deterministic, but it's deterministic *for a given generator*.
Adding `lat`/`lon` consumed extra PRNG draws and shifted every record, so counts
quoted before that change no longer match: `kes*` moved from 2,205 to 2,210,
`kestral capitol` from 158 to 152.

The counts and timings in the README carry a measurement date for that reason. If
you change `src/generate.js`, re-measure before quoting anything.
