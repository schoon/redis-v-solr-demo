'use strict';

// FT.INFO, parsed from the raw reply rather than through node-redis's typed
// client.ft.info().
//
// Why: the v4 client's parser is positional, and Redis 8 returns fields it
// doesn't know about — tag_overhead_sz_mb, text_overhead_sz_mb,
// total_index_memory_sz_mb, geoshapes_sz_mb, number_of_uses, cleaning,
// dialect_stats, "Index Errors", "field statistics". Everything after the first
// unknown field comes back shifted. Measured against a live Redis 8.10.1:
//
//   field                    real     client.ft.info() said
//   indexing                 0        5.642642021179199
//   percent_indexed          1        0.6956239342689514
//   hash_indexing_failures   0        20.11318016052246
//   total_indexing_time      1155.09  undefined
//
// numDocs and the other early fields happen to be correct, which is why this
// went unnoticed — the seeder's "indexing: still running" message was this bug,
// not a genuine race. Reading the reply as the key/value map it actually is
// avoids depending on field order at all.

function pairsToObject(arr) {
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i += 2) {
    out[String(arr[i])] = arr[i + 1];
  }
  return out;
}

async function ftInfo(client, index) {
  const raw = await client.sendCommand(['FT.INFO', index]);
  const flat = pairsToObject(raw);

  // Each attribute is itself an alternating key/value list, e.g.
  // identifier legal_name attribute legal_name type TEXT WEIGHT 5
  const attributes = (flat.attributes || []).map((a) => {
    const o = pairsToObject(a);
    const options = [];
    for (const [k, v] of Object.entries(o)) {
      if (['identifier', 'attribute', 'type'].includes(k)) continue;
      // Flags arrive as bare strings rather than key/value, e.g. SORTABLE.
      options.push(v === undefined || v === null ? k : `${k} ${v}`);
    }
    return {
      field: String(o.attribute ?? o.identifier ?? ''),
      type: String(o.type ?? ''),
      options,
    };
  });

  // SORTABLE and similar flags come through as values with no pair partner, so
  // they land as a key whose value is the next flag. Detect them directly from
  // the raw attribute arrays instead.
  (flat.attributes || []).forEach((a, i) => {
    const flags = a.map(String).filter((t) => ['SORTABLE', 'NOSTEM', 'NOINDEX',
      'CASESENSITIVE', 'UNF', 'INDEXEMPTY', 'INDEXMISSING'].includes(t));
    if (flags.length) {
      const existing = attributes[i].options.filter((o) => !flags.includes(o.split(' ')[0]));
      attributes[i].options = [...existing, ...flags];
    }
  });

  const definition = pairsToObject(flat.index_definition);
  const num = (v) => (v === undefined ? null : Number(v));

  return {
    indexName: String(flat.index_name ?? index),
    keyType: String(definition.key_type ?? ''),
    prefixes: (definition.prefixes || []).map(String),
    attributes,
    stats: {
      numDocs: num(flat.num_docs),
      maxDocId: num(flat.max_doc_id),
      numTerms: num(flat.num_terms),
      numRecords: num(flat.num_records),
      invertedSzMb: num(flat.inverted_sz_mb),
      docTableSizeMb: num(flat.doc_table_size_mb),
      keyTableSizeMb: num(flat.key_table_size_mb),
      sortableValuesSizeMb: num(flat.sortable_values_size_mb),
      totalIndexMemorySzMb: num(flat.total_index_memory_sz_mb),
      recordsPerDocAvg: num(flat.records_per_doc_avg),
      totalIndexingTimeMs: num(flat.total_indexing_time),
      hashIndexingFailures: num(flat.hash_indexing_failures),
      // The two the shifted parser got wrong, and the reason this file exists.
      indexing: num(flat.indexing) === 1,
      percentIndexed: num(flat.percent_indexed),
      numberOfUses: num(flat.number_of_uses),
    },
  };
}

// Reconstructs the FT.CREATE that would build this index, for display. Useful
// in a demo: it's the single command that set the whole thing up.
function toCreateCommand(info) {
  const head = `FT.CREATE ${info.indexName} ON ${info.keyType} PREFIX ${info.prefixes.length} ${info.prefixes.join(' ')} SCHEMA`;
  const fields = info.attributes.map(
    (a) => `  ${a.field} ${a.type}${a.options.length ? ` ${a.options.join(' ')}` : ''}`
  );
  return [head, ...fields].join('\n');
}

module.exports = { ftInfo, toCreateCommand };
