# redis-v-solr-demo

Side-by-side counterparty search: **Redis Query Engine** vs **Apache Solr**, on
the same laptop, over an identical 100,000-record corpus, with per-query latency
shown live.

Built for a financial-services counterparty-search conversation: fuzzy name
matching, type-ahead, and filtered screening — the three query shapes that
actually show up in KYC and onboarding workflows.

## Quick start

Requires **Docker** and **Node.js 18+**. Copy-paste the whole block:

```bash
git clone https://github.com/schoon/redis-v-solr-demo.git
cd redis-v-solr-demo

docker compose up -d          # Redis 8 on :6380, Solr 9 on :8983
npm install
npm run seed                  # generate 100k records, load both engines
npm start
```

Then open **<http://localhost:3010>**.

`npm run seed` takes about 10 seconds end to end. Redis is on **6380**, not the
default 6379, so it can't collide with a Redis you already have running.

### Stopping

```bash
docker compose down           # add -v to delete the volumes too
```

## The three scenarios

| Scenario | The real-world question | Redis | Solr |
| -------- | ----------------------- | ----- | ---- |
| **Typo-tolerant name** | "Our file says *Kestral Capitol* — who is that?" | `%term%` (Levenshtein 1) | `term~1` |
| **Prefix / autocomplete** | An analyst typing a name, one query per keystroke | `term*` | `term*` |
| **Filtered screening** | Name match, restricted by jurisdiction, rating, type, sector, risk, exposure and onboarding date | `TAG` + `NUMERIC` clauses | `fq` filter queries |
| **Geo proximity** | "Which counterparties are within 50km of London?" | `@location:[lon lat r km]` | `{!geofilt}` |
| **Portfolio breakdown** | "Total exposure by credit rating" | `FT.AGGREGATE` | JSON Facet API |
| **Exact LEI lookup** | Known-item retrieval by identifier | `HGETALL` — no index at all | `q=id:"…"` |

The exact query sent to each engine is displayed under its results pane, so
there's nothing hidden.

Filtered screening exposes eight filters: country, credit rating floor, status,
entity type, sector, risk-score ceiling, minimum exposure, and onboarding
recency. They compose — `kes` alone matches 2,210 counterparties; adding
`entity_type=BANK` cuts it to 229, `sector=Energy` to 14, and
`exposure ≥ $1bn` to 10.

### Result ordering

There's an **order** toggle, defaulting to **name**.

Wildcard and prefix queries are constant-scored on both engines — a search for
`kes*` returned 2,205 hits from Redis all scoring `6.9221677`, and the same 2,205
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
differentiate scores on fuzzy queries (they spread across 10.94–11.49 for
`kestral capitol`), so the name sort discards real ranking information there.
That's why it's a toggle and not a hardcoded sort.

### Why a search for "kes" returns "Aberdare Advisory GmbH"

Because that record carries the alias `Kestrel Advisory (former)`. Aliases are
indexed and displayed beneath each legal name, which is the point: the same
entity arrives as a short form from one system and a pre-merger name from
another, and a counterparty search has to find it either way.

## Observed on one laptop

Median of 11 runs, 100,000 counterparties, Redis 8.10.1 and Solr 9 both in
Docker on an Apple-silicon MacBook. **Indicative, not a benchmark** — see
Methodology.

| Scenario | Redis | Solr (wall) | Solr (QTime) | Ratio |
| -------- | ----- | ----------- | ------------ | ----- |
| Typo-tolerant | ~1.2 ms | ~3.5 ms | ~0 ms | ~2.9× |
| Prefix | ~1.6 ms | ~3.1 ms | ~0 ms | ~2× |
| Filtered (8 filters) | ~0.8 ms | ~2.9 ms | ~0 ms | ~3.7× |
| Geo, 50km radius | ~2.1 ms | ~3.1 ms | ~0 ms | ~1.4× |
| Exact LEI (`HGETALL`) | ~0.3 ms | ~2.1 ms | ~0 ms | ~7.7× |
| **Portfolio breakdown** | **~7.5 ms** | **~5.3 ms** | ~2 ms | **0.7× — Solr wins** |

### Solr wins the aggregation scenario

That last row is not a mistake and it is not there for balance. Grouping 100,000
documents by credit rating and summing exposure takes Redis ~7.5 ms and Solr
~5.3 ms. On `sector` the gap is wider: ~6.8 ms against ~4.2 ms. The counts and
sums are identical, so it's a like-for-like comparison — Solr is simply faster
here, and its JSON Facet API over column-oriented docValues is very good at
exactly this shape of work.

Two things worth knowing about that number:

- **It was much worse before a fairness fix.** Redis first measured ~61 ms,
  because only `country` had `SORTABLE` on it. `SORTABLE` is the counterpart to
  Solr's `docValues: true` — without it, `FT.AGGREGATE` loads each Hash instead
  of reading a column. With `SORTABLE` on every groupable TAG field, Redis went
  from 61 ms to ~7.5 ms. Solr still wins, but 61 ms would have been a
  misconfiguration on our side presented as a Solr victory.
- **Redis returns lowercase bucket labels** (`a+`, not `A+`) because grouping on
  a `SORTABLE` tag reads the normalised copy. The UI shows each engine's labels
  as returned rather than rewriting them. Preserving the original casing needs
  `LOAD`, which measured roughly 3× slower.

Lead with latency, and if a customer asks about faceting, show them this tab and
say Solr is stronger at it. That answer buys credibility for the rest.

Indexing the same 100k records:

| | Redis | Solr |
| --- | ----- | ---- |
| Load rate | ~68,000 docs/sec | ~28,000 docs/sec |
| Commit step | none — writes are queryable as they land | 0.5–0.7 s hard commit before anything is searchable |

That second table is arguably the more interesting one for a counterparty
system, where reference data changes through the day and staleness has
compliance consequences.

## Methodology

This is a vendor-authored comparison, so the method is stated in full and the
code is short enough to audit. A rigged benchmark is worse than no benchmark.

**What is held identical**

- **Same corpus.** One generator writes `data/counterparties.jsonl`; both
  seeders read that file. A fixed PRNG seed means reruns produce byte-identical
  data.
- **Same machine, no network.** Both engines run in Docker on the host. Neither
  pays for a network hop the other doesn't.
- **Equivalent schemas.** Fields are declared explicitly on both sides, not left
  to dynamic-field or schemaless inference. `TEXT`↔`text_general`,
  `TAG`↔`string` with docValues, `NUMERIC`↔`pint`/`pdouble`/`plong`,
  `GEO`↔`location`. Name-field boosts are 5 and 2 on both. Every TAG field the
  breakdown can group by carries `SORTABLE`, matching `docValues: true` on the
  Solr side, so neither engine groups from a row store while the other reads
  columns.
- **Equivalent boolean semantics.** Solr gets `mm=100%` so every term is
  mandatory, matching Redis's default term intersection. This mattered: without
  it, `kestral capitol` returned **158** documents from Redis and **8,662** from
  Solr, and timing those two against each other would have been meaningless. The
  UI refuses to display a speed multiplier whenever the two result counts
  disagree, for exactly this reason.
- **Equivalent edit distance.** Levenshtein 1 on both sides, and terms of 1–2
  characters are left exact on both — fuzzing them matches nearly everything.
- **Solr's caches are warm.** The seeder runs each query shape three times after
  indexing, so Solr isn't paying JIT, filterCache or docValues load costs on the
  first timed query.
- **HTTP keep-alive.** Node reuses one connection to Solr; verified with `lsof`
  (1 established socket, 0 `TIME_WAIT` after 60 queries). Solr is not being
  charged TCP handshakes.

**How timing works**

- Each engine runs the query the configured number of times, **alternating which
  goes first**, so neither systematically benefits from running second.
- The **median** is reported, never the minimum.
- Times are wall clock measured in the application, via
  `process.hrtime.bigint()` — sub-millisecond resolution, because Redis
  responses land well under 1 ms and `Date.now()` would quantise them to 0 or 1.

**The honest caveat about Solr's numbers**

Solr reports `QTime: 0` — its internal search really is sub-millisecond on this
corpus. Most of its ~3.5 ms wall clock is HTTP and JSON, not searching.

Both readings are shown in the UI, deliberately. The wall-clock figure is what
an application actually waits for, and Redis's figure includes its round trip
too, so the comparison is symmetric. But anyone claiming "Redis's query engine
is 4× faster than Lucene" from this chart is overreading it. What the chart
shows is that **the end-to-end cost of asking Redis a question is several times
lower**, and on this corpus that difference is dominated by transport: a
persistent binary protocol versus HTTP request/response with JSON
serialisation. That is a real architectural difference with real latency
consequences — and it is not the same claim as "Lucene is slow."

**Where this comparison does not apply**

- **Corpus size.** 100k documents fits comfortably in memory on both sides.
  Solr's architecture is built for corpora far larger than RAM, and this demo
  says nothing about that regime.
- **Distributed operation.** Single-node both sides. No SolrCloud sharding, no
  Redis Cluster.
- **Analysis depth.** Solr's analysis chains, language-specific stemmers,
  synonym graphs and phonetic filters go well beyond what's configured here.
  Same for faceting, pivot facets and grouping.
- **Relevance quality.** This measures latency and result counts, not ranking
  quality. Both engines return sensible top hits for these queries, but nobody
  has judged which ordering is *better*.

If a customer pushes on any of those, the honest answer is that this demo
doesn't cover it.

## Three gotchas worth knowing if you extend this

These cost real debugging time while building the demo, and all three produce
silently wrong results rather than errors.

**Coordinate order is reversed between the engines.** Redis `GEO` takes
`"lon,lat"`; Solr's `LatLonPointSpatialField` takes `"lat,lon"`. Get it backwards
and London lands in the Indian Ocean — no error, just a radius query that
quietly disagrees. The seeders write each in its own order, and the geo scenario
is verified to return identical counts at 10 km, 50 km and 200 km.

**`*` cannot be combined with other clauses in Redis.** `* @location:[…]` is a
syntax error, so with no name terms the wildcard is dropped and the filters
stand alone. Solr's `q=*:*` composes with `fq` happily, which is why this only
broke one side.

**TAG values containing spaces need escaping.** `@sector:{Asset Management}`
silently truncates at the space; it has to be `@sector:{Asset\ Management}`.
Solr's equivalent is quoting: `sector:("Asset Management")`.

## Data model

100,000 synthetic counterparties. The names are invented — deliberately not real
institutions, because attaching fabricated credit ratings and risk scores to
real firms would be misleading in a customer meeting.

In Redis each record is one **Hash** at `cp:<LEI>`, with a single index over the
key prefix:

```
FT.CREATE cp:idx ON HASH PREFIX 1 cp: SCHEMA
  legal_name    TEXT WEIGHT 5 SORTABLE
  aliases       TEXT WEIGHT 2
  parent_name   TEXT
  city          TEXT
  country       TAG SORTABLE
  jurisdiction  TAG
  entity_type   TAG
  sector        TAG
  credit_rating TAG
  status        TAG
  rating_score  NUMERIC SORTABLE
  risk_score    NUMERIC SORTABLE
  exposure_usd  NUMERIC SORTABLE
  onboarded_at  NUMERIC SORTABLE
```

Nothing is copied into the index — it points at the Hashes already in the
keyspace.

Two modelling details worth pointing out in a demo:

- **`rating_score` is the numeric twin of `credit_rating`.** Ratings are ordinal
  (`D` … `AAA`), so scoring them 1–22 turns "BBB- or better" into one range
  query instead of ten equality checks.
- **`aliases` carries short forms and pre-merger names.** That's where
  counterparty matching gets hard in practice: the same entity arrives as a
  short form from one system and a former name from another.

## Layout

```
docker-compose.yml     Redis 8 (:6380) and Solr 9 (:8983)
src/
  config.js            ports, URLs, corpus size, PRNG seed
  generate.js          writes data/counterparties.jsonl
  seed-redis.js        HSET + FT.CREATE
  seed-solr.js         Schema API + bulk post + commit + cache warm-up
  queries.js           both engines' query construction, side by side
  server.js            /api/search, /api/stats, static hosting
public/index.html      the whole UI, one file
```

`src/queries.js` is the file to read if you want to check the two engines are
being asked the same question. That's why both live in one file.

## Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `COUNT` | `100000` | Corpus size for `npm run generate` |
| `REDIS_URL` | `redis://localhost:6380` | Redis connection |
| `SOLR_URL` | `http://localhost:8983/solr/counterparties` | Solr core |
| `PORT` | `3010` | Demo web server |

```bash
COUNT=1000000 npm run seed     # bigger corpus; slower to seed
PORT=3011 npm start
```

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `index cp:idx not found — run: npm run seed` | The Redis container was recreated. Re-run `npm run seed`. |
| `Solr not reachable … is docker compose up?` | `docker compose ps` — Solr takes ~20s to become healthy on first boot. |
| Corpus banner says **COUNTS DIFFER** | The engines hold different data; the comparison is invalid until you re-run `npm run seed`. |
| `Port 3010 is in use` | `PORT=3011 npm start` |
