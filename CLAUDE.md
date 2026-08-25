# redis-v-solr-demo

A customer-facing demo comparing Redis Query Engine against Apache Solr for
counterparty search. Node/Express backend, single-file vanilla frontend, both
engines in Docker.

Published at <https://github.com/schoon/redis-v-solr-demo> (private).

## Stack

- **Backend:** Node.js + Express
- **Redis client:** the `redis` meta-package. Unlike the leaderboard project,
  this one *needs* a module — `FT.*` lives in `@redis/search`, and the peer
  ranges of `@redis/client@1` and a standalone `@redis/search` don't line up.
  The meta-package ships a coherent set, so it wins here.
- **Solr:** plain HTTP via global `fetch`. No client library.
- **Frontend:** one `public/index.html`. No framework, no build step.

## Commands

```bash
docker compose up -d     # Redis 8 on :6380, Solr 9 on :8983
npm run seed             # generate + load both engines (~10s)
npm start                # demo on :3010
```

`npm run seed` is safe to re-run; both seeders wipe their engine first.

## The one rule that matters: the comparison must stay fair

This is vendor-authored competitive material. A customer's search architect will
read `src/queries.js`. If the two engines are found to be answering different
questions, the demo is worse than useless — it costs credibility.

So, before changing anything about how a query is built:

**Both engines must answer the same question.** Same corpus, same boolean
semantics, same edit distance, same field boosts. `mm=100%` on the Solr side is
not optional — it's what makes Solr's multi-term behaviour match Redis's default
intersection. Without it `kestral capitol` returns 158 documents from Redis and
8,662 from Solr.

**The UI must keep refusing to show a multiplier when result counts differ.**
`totalsMatch` exists for that. Don't "fix" a totals mismatch by hiding it.

**Solr must stay warm and keep-alive'd.** The seeder's warm-up pass and Node's
connection reuse are both load-bearing. Timing a cold Solr, or one paying a TCP
handshake per query, would be a cheap trick.

**Report the median, never the minimum**, and keep alternating which engine runs
first.

**Keep showing Solr's `QTime` next to its wall clock.** Its internal search is
sub-millisecond; most of its wall time is HTTP and JSON. Hiding that invites the
accusation that the whole demo is a transport-overhead measurement dressed up as
a search comparison. Showing it, and saying so in the README, is what makes the
rest of the numbers trustworthy.

**Don't quietly widen the claim.** What this demo supports is "end-to-end cost
of asking Redis a question is several times lower on this corpus." It does not
support "Lucene is slow", anything about corpora larger than RAM, anything
distributed, or anything about relevance quality. The README's "Where this
comparison does not apply" section is a feature — keep it current.

## Conventions

**Comment the query construction.** Both engines' queries live together in
`src/queries.js` on purpose. Each clause gets a comment naming the operator and
what it does, so the file doubles as an explanation during a demo.

**Synthetic names only.** The generator invents institution names. Never seed
real firm names — fabricated credit ratings and risk scores attached to a real
institution is a liability in a customer meeting.

**Deterministic data.** `config.js` holds a fixed PRNG seed so reruns produce
identical data. Don't introduce `Math.random()` into the generator.

**Redis is on 6380.** Deliberately not 6379, so the demo can't collide with a
Redis the presenter already has running. Don't "tidy" it back to the default.

## Redis data model

One Hash per counterparty at `cp:<LEI>`, one index over the prefix.

- `cp:<LEI>` — Hash. All 15 fields as strings; the NUMERIC index parses the
  numeric ones.
- `cp:idx` — the index. `ON HASH PREFIX 1 cp:`.

`rating_score` (1–22) is the numeric twin of the ordinal `credit_rating`, which
is what turns "BBB- or better" into a single range query. Keep them in sync if
the rating scale changes.

The index is created *before* the data loads in `seed-redis.js`. That's
intentional: it demonstrates that Redis indexes synchronously on write, with no
commit step, which is one of the things the demo is showing.

## Layout

```
docker-compose.yml
src/config.js  generate.js  seed-redis.js  seed-solr.js  queries.js  server.js
public/index.html
data/                      generated, gitignored
```

Keep the frontend a single self-contained `index.html` — no build step.
