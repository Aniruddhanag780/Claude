// Repair await-precedence bugs left by the earlier codemod run:
//   `await db.run(sql).lastInsertRowid`  ->  `(await db.run(sql)).lastInsertRowid`
// As written, `await` binds only to `db.run(sql)`, so `.lastInsertRowid` is read
// off the Promise (undefined -> NaN). Parenthesizing the awaited call is always
// safe: await on a non-promise is identity, on a promise it fixes the read.
// Only member/element-access chains whose base is a db run/get/all/query/prepare
// call are touched.
import fs from 'node:fs';
import ts from 'typescript';

const DB_METHODS = new Set(['run', 'get', 'all', 'query', 'prepare']);

function fixFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [];
  let count = 0;

  const visit = (node) => {
    if (ts.isAwaitExpression(node)) {
      // Walk the member/element-access chain down to its base expression.
      let cur = node.expression;
      while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = cur.expression;
      // `cur` is now the base of the chain (a call, identifier, etc.).
      if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) &&
          DB_METHODS.has(cur.expression.name.text)) {
        // node = `await BASE.m1.m2...`; rewrite to `(await BASE).m1.m2...`
        const rest = text.slice(cur.end, node.end);
        edits.push([node.getStart(sf), node.end, `(await ${cur.getText(sf)})${rest}`]);
        count++;
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
console.log(JSON.stringify({ files: results.length, fixes: total }));
for (const r of results.filter((x) => x.count)) console.log(`  ${r.count}\t${r.file}`);
