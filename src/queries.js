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

  const clauses = [namePart];

  if (scenario === 'filtered') {
    // TAG filters use {a|b} for "any of". NUMERIC uses inclusive ranges.
    if (filters.countries?.length) {
      clauses.push(`@country:{${filters.countries.join('|')}}`);
    }
    if (filters.status) {
      clauses.push(`@status:{${filters.status}}`);
    }
    if (Number.isFinite(filters.minRating)) {
      clauses.push(`@rating_score:[${filters.minRating} +inf]`);
    }
    if (Number.isFinite(filters.maxRisk)) {
      clauses.push(`@risk_score:[-inf ${filters.maxRisk}]`);
    }
  }

  return clauses.join(' ');
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

  if (scenario === 'filtered') {
    // Filter queries are Solr's equivalent of Redis TAG/NUMERIC clauses, and
    // they're the right tool here: cacheable and not score-affecting.
    if (filters.countries?.length) {
      params.append('fq', `country:(${filters.countries.join(' OR ')})`);
    }
    if (filters.status) {
      params.append('fq', `status:${filters.status}`);
    }
    if (Number.isFinite(filters.minRating)) {
      params.append('fq', `rating_score:[${filters.minRating} TO *]`);
    }
    if (Number.isFinite(filters.maxRisk)) {
      params.append('fq', `risk_score:[* TO ${filters.maxRisk}]`);
    }
  }

  return params;
}

module.exports = { sanitize, redisQuery, redisSearchArgs, solrParams, REDIS_RETURN };
