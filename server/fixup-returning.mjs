// Append `RETURNING id` to INSERT statements in test seed SQL so PG returns the
// inserted id (SQLite's `.lastInsertRowid` had it implicitly). Only applied when:
//   * the SQL is a plain string / no-substitution template literal;
//   * it is an `INSERT INTO <table>` with no existing `RETURNING`;
//   * it has no `ON CONFLICT` (avoids changing upsert row-count semantics);
//   * `<table>` has an `id` column (id-less tables are left for manual review).
// Awaiting/ignoring the extra RETURNING column is harmless for callers that do
// not read `.lastInsertRowid`, so this is safe to apply broadly.
import fs from 'node:fs';
import ts from 'typescript';

// Tables with NO single `id` column — RETURNING id would error here.
const ID_LESS = new Set([
  'catalog_model_tombstones', 'custom_model_tombstones', 'key_monthly_usage',
  'model_overrides', 'provider_quota_state', 'rate_limit_cooldowns',
  'request_hourly', 'response_cache', 'sessions', 'settings',
]);

function fixFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = []; // [start, end, replacement]
  let changed = 0;
  let skippedConflict = 0;
  let skippedIdLess = 0;

  const literalText = (node) => {
    if (ts.isStringLiteral(node)) return { value: node.text, quote: node.getText(sf)[0] };
    if (ts.isNoSubstitutionTemplateLiteral(node)) return { value: node.text, quote: '`' };
    return null;
  };
  const replaceLiteral = (node, newValue) => {
    const full = node.getText(sf);
    const q = full[0];
    // preserve any escape style by rewriting the raw text with the same quote
    const escaped = newValue.replace(new RegExp(`\\\\|${q}`, 'g'), (m) => '\\' + m);
    return q + escaped + q;
  };

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (['run', 'get', 'all', 'query'].includes(method) && node.arguments.length) {
        const sqlArg = node.arguments[0];
        const lit = literalText(sqlArg);
        if (lit) {
          const sql = lit.value;
          const m = /insert\s+into\s+([a-z_]+)/i.exec(sql);
          if (m && !/returning/i.test(sql)) {
            const table = m[1];
            if (/on\s+conflict/i.test(sql)) {
              skippedConflict++;
            } else if (ID_LESS.has(table)) {
              skippedIdLess++;
            } else {
              const newText = sql.replace(/\s*$/, '') + ' RETURNING id';
              edits.push([sqlArg.getStart(sf), sqlArg.end, replaceLiteral(sqlArg, newText)]);
              changed++;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (edits.length) {
    edits.sort((a, b) => b[0] - a[0]);
    let out = text;
    for (const [s, e, rep] of edits) out = out.slice(0, s) + rep + out.slice(e);
    fs.writeFileSync(file, out);
  }
  return { file, changed, skippedConflict, skippedIdLess };
}

const results = process.argv.slice(2).map(fixFile);
const totals = results.reduce((a, r) => ({
  changed: a.changed + r.changed,
  skippedConflict: a.skippedConflict + r.skippedConflict,
  skippedIdLess: a.skippedIdLess + r.skippedIdLess,
}), { changed: 0, skippedConflict: 0, skippedIdLess: 0 });
console.log(JSON.stringify({ files: results.length, ...totals }, null, 2));
const flagged = results.filter((r) => r.skippedIdLess || r.skippedConflict);
if (flagged.length) {
  console.log('--- files with id-less / ON CONFLICT inserts left for manual review ---');
  for (const r of flagged) console.log(r.file, `id_less=${r.skippedIdLess} conflict=${r.skippedConflict}`);
}
