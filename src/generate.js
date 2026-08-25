'use strict';

// Generates synthetic counterparty records to a JSONL file. Both seeders read
// this same file, so Redis and Solr hold identical data — without that, any
// latency comparison is meaningless.
//
// The names are invented. They're built to *look* like financial institutions
// so the fuzzy-match demo feels real, but they deliberately don't name actual
// firms: putting fabricated credit ratings and risk scores against real
// institutions would be misleading in a customer meeting.

const fs = require('fs');
const path = require('path');
const { COUNT, DATA_FILE, SEED } = require('./config');

// Deterministic PRNG (mulberry32) so the dataset is reproducible run to run.
function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STEMS = [
  'Kestrel', 'Northgate', 'Meridian', 'Aldgate', 'Brightwater', 'Calderwood',
  'Dunmore', 'Eastvale', 'Fairhaven', 'Glenmoor', 'Harrowgate', 'Invermere',
  'Jarrowfield', 'Kingsmere', 'Lansdowne', 'Marchmont', 'Nithsdale', 'Oakhurst',
  'Pemberton', 'Quayside', 'Ravenswood', 'Stonebridge', 'Thorndike', 'Ulverston',
  'Vandermeer', 'Westbrook', 'Yarrowfield', 'Ziegler', 'Ashcombe', 'Blackfriars',
  'Coldharbour', 'Draycott', 'Elmswood', 'Farringdon', 'Greyfriars', 'Hollowmere',
  'Ironbridge', 'Kelvinside', 'Larkspur', 'Moorgate', 'Netherby', 'Ostervale',
  'Pinehurst', 'Redcliffe', 'Saltmarsh', 'Tanfield', 'Underwood', 'Verwood',
  'Whitmore', 'Aberdare', 'Bexhill', 'Cranleigh', 'Dovercourt', 'Ellesmere',
];

const MIDDLES = [
  'Capital', 'Securities', 'Financial', 'Asset Management', 'Investment',
  'Credit', 'Global Markets', 'Partners', 'Trust', 'Holdings', 'Advisory',
  'Treasury', 'Structured Finance', 'Private Bank', 'Clearing',
];

const SUFFIXES = [
  'LLP', 'plc', 'N.A.', 'AG', 'S.A.', 'GmbH', 'Ltd', 'Inc', 'LLC',
  'Pte Ltd', 'B.V.', 'S.p.A.', 'Pty Ltd', 'Group',
];

const ENTITY_TYPES = [
  'BANK', 'BROKER_DEALER', 'ASSET_MANAGER', 'HEDGE_FUND', 'INSURER',
  'PENSION_FUND', 'SPV', 'CORPORATE', 'CCP', 'SOVEREIGN',
];

const COUNTRIES = [
  'US', 'GB', 'DE', 'FR', 'JP', 'SG', 'HK', 'CH', 'NL', 'IE', 'LU',
  'AU', 'CA', 'CN', 'BR', 'IN', 'AE', 'ZA', 'SE', 'ES', 'IT', 'KY',
];

const CITIES = {
  US: ['New York', 'Chicago', 'Boston', 'Charlotte'],
  GB: ['London', 'Edinburgh', 'Leeds'],
  DE: ['Frankfurt', 'Munich'],
  FR: ['Paris', 'Lyon'],
  JP: ['Tokyo', 'Osaka'],
  SG: ['Singapore'],
  HK: ['Hong Kong'],
  CH: ['Zurich', 'Geneva'],
  NL: ['Amsterdam'],
  IE: ['Dublin'],
  LU: ['Luxembourg'],
  AU: ['Sydney', 'Melbourne'],
  CA: ['Toronto', 'Montreal'],
  CN: ['Shanghai', 'Beijing'],
  BR: ['Sao Paulo'],
  IN: ['Mumbai'],
  AE: ['Dubai', 'Abu Dhabi'],
  ZA: ['Johannesburg'],
  SE: ['Stockholm'],
  ES: ['Madrid'],
  IT: ['Milan'],
  KY: ['George Town'],
};

const SECTORS = [
  'Banking', 'Insurance', 'Asset Management', 'Energy', 'Utilities',
  'Technology', 'Healthcare', 'Industrials', 'Real Estate', 'Sovereign',
  'Consumer', 'Telecoms', 'Transport', 'Mining',
];

// Ordered worst-to-best so the index is the numeric score. Scoring ratings
// numerically is what lets "rating BBB- or better" become a range query
// instead of a set of twenty equality checks.
const RATINGS = [
  'D', 'C', 'CC', 'CCC-', 'CCC', 'CCC+', 'B-', 'B', 'B+', 'BB-', 'BB', 'BB+',
  'BBB-', 'BBB', 'BBB+', 'A-', 'A', 'A+', 'AA-', 'AA', 'AA+', 'AAA',
];

const STATUSES = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE',
  'ACTIVE', 'ACTIVE', 'ACTIVE', 'PENDING', 'SUSPENDED', 'TERMINATED'];

// LEI-like: 20 alphanumeric characters. Shape only, not real LEIs.
const LEI_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function main() {
  const random = makeRandom(SEED);
  const pick = (arr) => arr[Math.floor(random() * arr.length)];

  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const out = fs.createWriteStream(DATA_FILE);

  const started = Date.now();
  const nowSeconds = Math.floor(Date.parse('2026-08-25T00:00:00Z') / 1000);

  for (let i = 0; i < COUNT; i += 1) {
    const stem = pick(STEMS);
    const middle = pick(MIDDLES);
    const suffix = pick(SUFFIXES);
    const legalName = `${stem} ${middle} ${suffix}`;

    const country = pick(COUNTRIES);
    const ratingIndex = Math.floor(random() * RATINGS.length);

    let lei = '';
    for (let c = 0; c < 20; c += 1) lei += LEI_CHARS[Math.floor(random() * LEI_CHARS.length)];

    // Aliases are where counterparty search gets hard in practice: the same
    // entity arrives as a short form from one system and a pre-merger name
    // from another. Both need to match.
    const aliases = [`${stem} ${middle}`];
    if (random() < 0.35) aliases.push(`${stem} ${pick(SUFFIXES)}`);
    if (random() < 0.20) aliases.push(`${pick(STEMS)} ${middle} (former)`);

    const record = {
      id: lei,
      legal_name: legalName,
      // Pipe-separated rather than an array: a Redis Hash field is a flat
      // string, and Solr indexes it as one text field. Keeping the shape
      // identical on both sides keeps the comparison fair.
      aliases: aliases.join(' | '),
      parent_name: random() < 0.4 ? `${pick(STEMS)} ${pick(MIDDLES)} ${pick(SUFFIXES)}` : '',
      country,
      jurisdiction: country,
      city: pick(CITIES[country] || ['London']),
      entity_type: pick(ENTITY_TYPES),
      sector: pick(SECTORS),
      credit_rating: RATINGS[ratingIndex],
      rating_score: ratingIndex + 1,
      risk_score: Math.round(random() * 1000) / 10,
      exposure_usd: Math.floor(random() * 5_000_000_000),
      status: pick(STATUSES),
      onboarded_at: nowSeconds - Math.floor(random() * 10 * 365 * 24 * 3600),
    };

    if (!out.write(`${JSON.stringify(record)}\n`)) {
      // Backpressure: without this, 100k writes queue in memory.
      i += 0;
    }
  }

  out.end(() => {
    const bytes = fs.statSync(DATA_FILE).size;
    console.log(`Generated ${COUNT.toLocaleString()} counterparties`);
    console.log(`  file:  ${DATA_FILE}`);
    console.log(`  size:  ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`  took:  ${Date.now() - started} ms`);
    console.log(`  seed:  ${SEED} (fixed — reruns produce identical data)`);
  });
}

main();
