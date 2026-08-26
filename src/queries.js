'use strict';

// Query construction for both engines, kept side by side in one file so the
// two are easy to compare — and so it's obvious that neither is being handed
// an easier question than the other.
//
// The three scenarios:
//   fuzzy    — typo-tolerant name match   (Redis %term%      / Solr term~1)
//   prefix   — type-ahead on a name       (Redis term*       / Solr term*)
//   filtered — name match plus screening filters
//              (Redis TAG + NUMERIC       / Solr fq params)

const { REDIS_INDEX } = require('./config');
const { solrFloats } = require('./vectors');

// User input goes into two different query languages, both of which have
// special characters. Rather than escape for each dialect, reduce input to
// letters, digits and spaces — enough for counterparty names and impossible
// to inject through.
function sanitize(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
}

// ---------------------------------------------------------------- Redis

function redisQuery(scenario, terms, filters) {
  let namePart;

  if (terms.length === 0) {
    namePart = '*';
  } else if (scenario === 'fuzzy') {
    // %term% is Levenshtein distance 1. Terms of 1-2 characters are left
    // exact: fuzzing them matches almost everything and tells you nothing.
    namePart = `@legal_name|aliases:(${terms
      .map((t) => (t.length > 2 ? `%${t}%` : t))
      .join(' ')})`;
  } else if (scenario === 'prefix') {
    // Only the final term gets the wildcard — that's the one still being
    // typed. Earlier terms are complete words.
    const head = terms.slice(0, -1);
    const last = terms[terms.length - 1];
    const parts = [...head, `${last}*`];
    namePart = `@legal_name|aliases:(${parts.join(' ')})`;
  } else {
    // filtered: prefix-match the name, then narrow with the screening filters.
    const head = terms.slice(0, -1);
    const last = terms[terms.length - 1];
    namePart = `@legal_name|aliases:(${[...head, `${last}*`].join(' ')})`;
  }

  // '*' means "everything" in Redis and cannot be combined with other clauses —
  // `* @location:[...]` is a syntax error. So when there are no name terms, the
  // wildcard is dropped and the filters stand alone.
  const clauses = namePart === '*' ? [] : [namePart];

  if (scenario === 'filtered' || scenario === 'geo') {
    // TAG filters use {a|b} for "any of". NUMERIC uses inclusive ranges.
    if (filters.countries?.length) {
      clauses.push(`@country:{${filters.countries.join('|')}}`);
    }
    if (filters.status) {
      clauses.push(`@status:{${filters.status}}`);
    }
    if (filters.entityTypes?.length) {
      clauses.push(`@entity_type:{${filters.entityTypes.join('|')}}`);
    }
    if (filters.sectors?.length) {
      // Sector values contain spaces ("Asset Management"). Inside a TAG filter
      // a bare space would end the tag, so it has to be backslash-escaped.
      clauses.push(`@sector:{${filters.sectors.map(escapeTag).join('|')}}`);
    }
    if (Number.isFinite(filters.minRating)) {
      clauses.push(`@rating_score:[${filters.minRating} +inf]`);
    }
    if (Number.isFinite(filters.maxRisk)) {
      clauses.push(`@risk_score:[-inf ${filters.maxRisk}]`);
    }
    if (Number.isFinite(filters.minExposure)) {
      clauses.push(`@exposure_usd:[${filters.minExposure} +inf]`);
    }
    if (Number.isFinite(filters.onboardedSince)) {
      clauses.push(`@onboarded_at:[${filters.onboardedSince} +inf]`);
    }
  }

  if (scenario === 'geo' && filters.geo) {
    // @location:[<lon> <lat> <radius> <unit>] — longitude FIRST.
    const { lon, lat, radiusKm } = filters.geo;
    clauses.push(`@location:[${lon} ${lat} ${radiusKm} km]`);
  }

  // If nothing at all was specified, fall back to the bare wildcard.
  return clauses.length ? clauses.join(' ') : '*';
}

// Backslash-escapes the characters that terminate a Redis TAG value.
function escapeTag(value) {
  return String(value).replace(/([ \-.,{}|])/g, '\\$1');
}

const REDIS_RETURN = [
  'id', 'legal_name', 'aliases', 'country', 'entity_type',
  'credit_rating', 'rating_score', 'risk_score', 'status',
];

// order = 'name' | 'relevance'
//
// Why 'name' is the default: for wildcard and prefix queries both engines apply
// constant scoring, so every match ties on relevance — Redis returned 2,205
// hits all scoring 6.9221677, Solr the same 2,205 all scoring 5.0. With a total
// tie, "top 10" is decided by each engine's internal document order, which
// differs, so the two panes showed a different arbitrary ten out of the same
// set. Sorting both by name makes them line up row for row, and on a fully
// tied result set nothing is lost by doing so.
//
// It is not free on the fuzzy scenario, though: there Redis *does* differentiate
// (scores spread across 10.94-11.49), so a name sort discards real ranking
// information. Hence the toggle rather than a hardcoded sort.
function redisSearchArgs(scenario, terms, filters, limit, order = 'name') {
  const options = {
    LIMIT: { from: 0, size: limit },
    RETURN: REDIS_RETURN,
  };

  if (order === 'name') {
    // legal_name is declared SORTABLE, so this reads a stored normalised copy
    // rather than re-deriving it per query.
    options.SORTBY = { BY: 'legal_name', DIRECTION: 'ASC' };
  }

  return {
    index: REDIS_INDEX,
    query: redisQuery(scenario, terms, filters),
    options,
  };
}

// ---------------------------------------------------------------- Solr

function solrParams(scenario, terms, filters, limit, order = 'name') {
  const params = new URLSearchParams();

  // Matches the Redis SORTBY above. legal_name_sort is the lowercased,
  // untokenised copy — see the schema comment in seed-solr.js for why the
  // lowercasing is required for the two orderings to agree.
  if (order === 'name') {
    params.set('sort', 'legal_name_sort asc');
  }

  // edismax gives Solr the multi-field-with-boosts behaviour that Redis gets
  // from `@legal_name|aliases` plus WEIGHT in the schema. Same boosts: 5 and 2.
  params.set('defType', 'edismax');
  params.set('qf', 'legal_name^5 aliases^2');

  // mm=100% makes every term mandatory. Without this the two engines answer
  // different questions: Redis intersects multiple terms by default, while
  // edismax unions them — searching "kestral capitol" returned 158 documents
  // from Redis and 8,662 from Solr, and comparing the speed of those two
  // queries would be meaningless. AND on both sides, or no comparison.
  params.set('mm', '100%');
  params.set('rows', String(limit));
  params.set('wt', 'json');
  params.set('fl', REDIS_RETURN.join(','));

  if (terms.length === 0) {
    params.set('q', '*:*');
  } else if (scenario === 'fuzzy') {
    // term~1 is Levenshtein distance 1 — the same edit distance Redis's
    // %term% applies, with the same 1-2 character exemption.
    params.set('q', terms.map((t) => (t.length > 2 ? `${t}~1` : t)).join(' '));
  } else {
    const head = terms.slice(0, -1);
    const last = terms[terms.length - 1];
    params.set('q', [...head, `${last}*`].join(' '));
  }

  if (scenario === 'filtered' || scenario === 'geo') {
    // Filter queries are Solr's equivalent of Redis TAG/NUMERIC clauses, and
    // they're the right tool here: cacheable and not score-affecting.
    if (filters.countries?.length) {
      params.append('fq', `country:(${filters.countries.join(' OR ')})`);
    }
    if (filters.status) {
      params.append('fq', `status:${filters.status}`);
    }
    if (filters.entityTypes?.length) {
      params.append('fq', `entity_type:(${filters.entityTypes.join(' OR ')})`);
    }
    if (filters.sectors?.length) {
      // Values with spaces have to be quoted, the Solr equivalent of the
      // backslash-escaping the Redis TAG filter needs.
      params.append('fq', `sector:(${filters.sectors.map((s) => `"${s}"`).join(' OR ')})`);
    }
    if (Number.isFinite(filters.minRating)) {
      params.append('fq', `rating_score:[${filters.minRating} TO *]`);
    }
    if (Number.isFinite(filters.maxRisk)) {
      params.append('fq', `risk_score:[* TO ${filters.maxRisk}]`);
    }
    if (Number.isFinite(filters.minExposure)) {
      params.append('fq', `exposure_usd:[${filters.minExposure} TO *]`);
    }
    if (Number.isFinite(filters.onboardedSince)) {
      params.append('fq', `onboarded_at:[${filters.onboardedSince} TO *]`);
    }
  }

  if (scenario === 'geo' && filters.geo) {
    // geofilt takes pt=<lat>,<lon> — latitude FIRST, the reverse of Redis.
    const { lat, lon, radiusKm } = filters.geo;
    params.append('fq', `{!geofilt sfield=location pt=${lat},${lon} d=${radiusKm}}`);
  }

  return params;
}

// ------------------------------------------------ facets / aggregation

// Redis: FT.AGGREGATE walks the index and groups in one server-side pass.
// Returned as raw command arguments so the exact command is displayable in the
// UI — this is the scenario where the two engines' models differ most.
function redisAggregateArgs(field, limit = 25) {
  return [
    'FT.AGGREGATE', REDIS_INDEX, '*',
    'GROUPBY', '1', `@${field}`,
    'REDUCE', 'COUNT', '0', 'AS', 'cnt',
    'REDUCE', 'SUM', '1', '@exposure_usd', 'AS', 'exposure',
    'SORTBY', '2', '@cnt', 'DESC',
    'LIMIT', '0', String(limit),
  ];
}

// Solr: the JSON Facet API is the like-for-like feature — terms buckets with a
// sub-aggregation. This is territory Solr is traditionally strong in, so it's
// worth showing rather than avoiding.
function solrFacetParams(field, limit = 25) {
  const params = new URLSearchParams();
  params.set('q', '*:*');
  params.set('rows', '0');
  params.set('wt', 'json');
  params.set(
    'json.facet',
    JSON.stringify({
      by: {
        type: 'terms',
        field,
        limit,
        sort: { count: 'desc' },
        facet: { exposure: 'sum(exposure_usd)' },
      },
    })
  );
  return params;
}

// ------------------------------------------------ vector / semantic search

// Redis: FT.SEARCH with a KNN clause.
//
//   *=>[KNN 10 @vector $BLOB AS vscore]
//
// The part before => is an ordinary filter; the part after is the vector
// search. With `*` it's pure semantic search over everything. Substituting a
// real filter expression makes it hybrid, and Redis applies that filter
// BEFORE the KNN — the vector search runs only over the surviving documents.
// DIALECT 2 is required for this syntax.
//
// COSINE returns a *distance* (0 = identical), so similarity is 1 - distance.
function redisVectorArgs(vectorBuf, limit, filterExpr = '*') {
  // EF_RUNTIME controls how much of the HNSW graph is explored. Redis defaults
  // to 10, which with topK=10 is the least work possible and measurably hurts
  // recall — the two engines agreed on as few as 0 of 10 results before this.
  // Solr's default beam width is 100, so 100 here is the matching setting
  // rather than a thumb on the scale.
  //
  // Runtime attributes go in a trailing `=>{...}` block. Putting EF_RUNTIME
  // inside the KNN clause is a syntax error:
  //   SEARCH_SYNTAX Syntax error at offset 35 near EF_RUNTIME
  const query = `${filterExpr}=>[KNN ${limit} @vector $BLOB AS vscore]=>{$EF_RUNTIME: 100}`;
  return [
    'FT.SEARCH', REDIS_INDEX, query,
    'PARAMS', '2', 'BLOB', vectorBuf,
    'SORTBY', 'vscore',
    'LIMIT', '0', String(limit),
    'RETURN', '8', 'id', 'legal_name', 'country', 'credit_rating',
    'risk_score', 'status', 'profile', 'vscore',
    'DIALECT', '2',
  ];
}

// Solr: the {!knn} query parser over a DenseVectorField. Score is cosine
// similarity (higher is better), the opposite convention to Redis's distance.
//
// Filters go in fq. Whether Solr treats those as a pre-filter or a post-filter
// matters for hybrid search and is measured rather than assumed — see the
// methodology notes.
function solrVectorParams(vector, limit, filters = []) {
  const params = new URLSearchParams();
  // Same 9-significant-digit encoding as the seeder: a query vector can carry
  // the same long decimals that Solr rejects on ingest.
  params.set('q', `{!knn f=vector topK=${limit}}[${solrFloats(vector).join(',')}]`);
  params.set('rows', String(limit));
  params.set('wt', 'json');
  params.set('fl', 'id,legal_name,country,credit_rating,risk_score,status,profile,score');
  for (const f of filters) params.append('fq', f);
  return params;
}

// Builds the filter expression for each engine from the same inputs, so the
// hybrid comparison is like-for-like.
function hybridFilters(filters) {
  const redisClauses = [];
  const solrFq = [];

  if (filters.countries?.length) {
    redisClauses.push(`@country:{${filters.countries.join('|')}}`);
    solrFq.push(`country:(${filters.countries.join(' OR ')})`);
  }
  if (filters.status) {
    redisClauses.push(`@status:{${filters.status}}`);
    solrFq.push(`status:${filters.status}`);
  }
  if (Number.isFinite(filters.minRating)) {
    redisClauses.push(`@rating_score:[${filters.minRating} +inf]`);
    solrFq.push(`rating_score:[${filters.minRating} TO *]`);
  }
  if (Number.isFinite(filters.maxRisk)) {
    redisClauses.push(`@risk_score:[-inf ${filters.maxRisk}]`);
    solrFq.push(`risk_score:[* TO ${filters.maxRisk}]`);
  }
  // A keyword requirement on the narrative text, which is what makes this
  // genuinely hybrid rather than just filtered-vector.
  if (filters.keyword) {
    redisClauses.push(`@profile:(${filters.keyword})`);
    solrFq.push(`profile:(${filters.keyword})`);
  }

  return {
    redis: redisClauses.length ? `(${redisClauses.join(' ')})` : '*',
    solr: solrFq,
  };
}

// ------------------------------------------------ exact LEI lookup

// Structurally different rather than merely faster: the record lives at a known
// key, so Redis reads it directly with HGETALL and never consults the index.
// Solr has to run a query, because a document is only reachable through search.
function redisLeiKey(lei) {
  return `cp:${String(lei).replace(/[^A-Z0-9]/gi, '').toUpperCase()}`;
}

function solrLeiParams(lei) {
  const params = new URLSearchParams();
  params.set('q', `id:"${String(lei).replace(/[^A-Z0-9]/gi, '').toUpperCase()}"`);
  params.set('rows', '1');
  params.set('wt', 'json');
  params.set('fl', REDIS_RETURN.join(','));
  return params;
}

module.exports = {
  sanitize,
  redisQuery,
  redisSearchArgs,
  solrParams,
  redisAggregateArgs,
  solrFacetParams,
  redisVectorArgs,
  solrVectorParams,
  hybridFilters,
  redisLeiKey,
  solrLeiParams,
  REDIS_RETURN,
};
