// Convert SQLite `datetime('now', …)` in test SQL strings to Postgres text-format
// equivalents. Timestamp columns (created_at, last_checked_at, …) are `text` holding
// the SQLite-canonical 'YYYY-MM-DD HH:MM:SS' UTC, so every replacement uses to_char
// to emit exactly that shape.
//
// Only literals that EMBED datetime() inside a larger SQL string are rewritten.
// A literal that is *only* `datetime('now')` is a bind parameter (stores the literal
// text) and is left untouched — SQLite behaved the same way there.
import fs from 'node:fs';
import ts from 'typescript';

const NOW = `(now() at time zone 'utc')`;
const FMT = `'YYYY-MM-DD HH24:MI:SS'`;
const toChar = (expr) => `to_char(${expr}, ${FMT})`;

function convertSql(sql) {
  let out = sql;
  // datetime('now', 'start of month')
  out = out.replace(/datetime\(\s*'now'\s*,\s*'start of month'\s*\)/g,
    toChar(`date_trunc('month', ${NOW})`));
  // datetime('now', '-N unit')
  out = out.replace(/datetime\(\s*'now'\s*,\s*'-\s*(\d+)\s*(minute|hour|day|week|month)s?'\s*\)/g,
    (_m, n, unit) => toChar(`${NOW} - interval '${n} ${unit}'`));
  // datetime('now', '+N unit')
  out = out.replace(/datetime\(\s*'now'\s*,\s*'\+\s*(\d+)\s*(minute|hour|day|week|month)s?'\s*\)/g,
    (_m, n, unit) => toChar(`${NOW} + interval '${n} ${unit}'`));
  // datetime('now')
  out = out.replace(/datetime\(\s*'now'\s*\)/g, toChar(NOW));
  return out;
}

const isBareDatetime = (s) => /^\s*datetime\([\s\S]*\)\s*$/.test(s);

function fixFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [];
  let count = 0;

  const escapeFor = (quote, value) => {
    if (quote === '`') return value.replace(/\\|`|\$\{/g, (m) => '\\' + m);
    return value.replace(new RegExp(`\\\\|${quote}`, 'g'), (m) => '\\' + m);
  };

  const visit = (node) => {
    const isStr = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
    if (isStr) {
      const raw = node.text;
      if (raw.includes('datetime(') && !isBareDatetime(raw)) {
        const next = convertSql(raw);
        if (next !== raw) {
          const quote = node.getText(sf)[0];
          edits.push([node.getStart(sf), node.end, quote + escapeFor(quote, next) + quote]);
          count++;
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
  return { file, count };
}

const results = process.argv.slice(2).map(fixFile);
const total = results.reduce((a, r) => a + r.count, 0);
console.log(JSON.stringify({ files: results.length, conversions: total }));
for (const r of results.filter((x) => x.count)) console.log(`  ${r.count}\t${r.file}`);
