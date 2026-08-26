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

// Approximate city centres, for the geo-proximity scenario. Each record gets a
// small random offset from its city so the points spread across a metro area
// instead of stacking on one coordinate.
//
// Stored [lat, lon] here. Watch the ordering downstream: Redis GEO wants
// "lon,lat" while Solr's LatLonPointSpatialField wants "lat,lon". Getting that
// backwards puts London in the Indian Ocean and the two engines disagree
// silently, which is exactly the sort of bug that discredits a demo.
const CITY_COORDS = {
  'New York': [40.7128, -74.006], Chicago: [41.8781, -87.6298],
  Boston: [42.3601, -71.0589], Charlotte: [35.2271, -80.8431],
  London: [51.5072, -0.1276], Edinburgh: [55.9533, -3.1883],
  Leeds: [53.8008, -1.5491], Frankfurt: [50.1109, 8.6821],
  Munich: [48.1351, 11.582], Paris: [48.8566, 2.3522],
  Lyon: [45.764, 4.8357], Tokyo: [35.6762, 139.6503],
  Osaka: [34.6937, 135.5023], Singapore: [1.3521, 103.8198],
  'Hong Kong': [22.3193, 114.1694], Zurich: [47.3769, 8.5417],
  Geneva: [46.2044, 6.1432], Amsterdam: [52.3676, 4.9041],
  Dublin: [53.3498, -6.2603], Luxembourg: [49.6116, 6.1319],
  Sydney: [-33.8688, 151.2093], Melbourne: [-37.8136, 144.9631],
  Toronto: [43.6532, -79.3832], Montreal: [45.5019, -73.5674],
  Shanghai: [31.2304, 121.4737], Beijing: [39.9042, 116.4074],
  'Sao Paulo': [-23.5505, -46.6333], Mumbai: [19.076, 72.8777],
  Dubai: [25.2048, 55.2708], 'Abu Dhabi': [24.4539, 54.3773],
  Johannesburg: [-26.2041, 28.0473], Stockholm: [59.3293, 18.0686],
  Madrid: [40.4168, -3.7038], Milan: [45.4642, 9.19],
  'George Town': [19.2866, -81.3744],
};

// Narrative credit-review text, for the semantic-search tab. Themes are keyed
// to the record's risk score so the corpus is internally coherent: asking
// "who has liquidity problems" should surface genuinely distressed names, not
// random ones, otherwise the vector demo proves nothing.
const DISTRESS = [
  'liquidity has deteriorated sharply across two consecutive quarters',
  'the firm missed two collateral calls in the last ninety days',
  'auditors issued a qualified opinion on the latest annual accounts',
  'a covenant breach was waived pending refinancing negotiations',
  'rating agencies placed the entity on negative outlook',
  'material litigation is outstanding with a former clearing counterparty',
  'funding costs have risen steeply as wholesale lines were withdrawn',
];

const WATCH = [
  'concentration in commercial real estate lending remains elevated',
  'exposure to crypto-asset intermediaries is under active monitoring',
  'sanctions screening flagged a beneficial owner for enhanced review',
  'a cyber incident briefly disrupted settlement operations',
  'senior management turnover has slowed remediation work',
  'the ESG assessment highlighted financed-emissions concerns',
  'intragroup guarantees make the true recourse position hard to assess',
];

const HEALTHY = [
  'capital ratios remain comfortably above regulatory minimums',
  'the funding profile is diversified with stable deposit inflows',
  'the most recent onboarding refresh produced no adverse findings',
  'collateral posting has been timely throughout the period',
  'the relationship has expanded into cleared derivatives',
  'stress testing showed resilience to a severe rates shock',
];

const BUSINESS = [
  'Primary business is structured lending to mid-market borrowers',
  'The firm intermediates FX and rates flow for regional banks',
  'It manages segregated mandates for pension and insurance clients',
  'Activity is concentrated in securities financing and repo',
  'It underwrites trade finance across emerging markets',
  'The desk runs systematic equity strategies',
  'It provides custody and fund administration services',
];

const STATUS_NOTE = {
  ACTIVE: 'The relationship is active and in good standing.',
  PENDING: 'Onboarding is incomplete pending outstanding KYC documentation.',
  SUSPENDED: 'Trading is suspended pending remediation of control failures.',
  TERMINATED: 'The relationship is being wound down and limits have been revoked.',
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

  // Deliberately a SEPARATE stream. Drawing the narrative text from `random`
  // would consume extra values and shift every subsequent field, changing the
  // whole corpus and invalidating every count quoted in the docs — which is
  // exactly what happened when lat/lon was added. An independent stream leaves
  // the original fifteen fields byte-identical.
  const randomText = makeRandom(SEED + 1);
  const pickText = (arr) => arr[Math.floor(randomText() * arr.length)];

  // Two themed observations, weighted by how risky the record already is.
  function profileFor(rec) {
    const themes = rec.risk_score > 70
      ? [DISTRESS, randomText() < 0.6 ? DISTRESS : WATCH]
      : rec.risk_score > 35
        ? [WATCH, randomText() < 0.5 ? WATCH : HEALTHY]
        : [HEALTHY, randomText() < 0.7 ? HEALTHY : WATCH];
    const a = pickText(themes[0]);
    let b = pickText(themes[1]);
    if (b === a) b = pickText(themes[1]);

    const type = rec.entity_type.toLowerCase().replace(/_/g, ' ');
    return `${rec.legal_name} is a ${rec.country}-domiciled ${type} operating in the `
      + `${rec.sector.toLowerCase()} sector, headquartered in ${rec.city}. `
      + `${pickText(BUSINESS)}. Credit review notes that ${a}, and that ${b}. `
      + `${STATUS_NOTE[rec.status]} `
      + `Internal risk score ${rec.risk_score} against a ${rec.credit_rating} rating, `
      + `with total exposure of ${(rec.exposure_usd / 1e6).toFixed(0)} million US dollars.`;
  }

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

    const city = pick(CITIES[country] || ['London']);
    const [baseLat, baseLon] = CITY_COORDS[city] || CITY_COORDS.London;
    // ±~0.35 degrees, roughly a 40km metro spread.
    const lat = Math.round((baseLat + (random() - 0.5) * 0.7) * 1e5) / 1e5;
    const lon = Math.round((baseLon + (random() - 0.5) * 0.7) * 1e5) / 1e5;

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
      city,
      lat,
      lon,
      entity_type: pick(ENTITY_TYPES),
      sector: pick(SECTORS),
      credit_rating: RATINGS[ratingIndex],
      rating_score: ratingIndex + 1,
      risk_score: Math.round(random() * 1000) / 10,
      exposure_usd: Math.floor(random() * 5_000_000_000),
      status: pick(STATUSES),
      onboarded_at: nowSeconds - Math.floor(random() * 10 * 365 * 24 * 3600),
    };

    // Added after the record is complete, so it can read the other fields.
    record.profile = profileFor(record);

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
