// One-shot codemod: migrate test files from the upstream sync-SQLite DB API
// (`getDb().prepare(sql).run/get/all(...)`, `initDb(':memory:')`) to the
// async PostgreSQL contract (`await getDb().run/get/all(sql, [params])`,
// `await initTestDb()`).
//
// Deliberately conservative: a file is only rewritten when EVERY database
// call it contains is a shape the codemod understands end-to-end. Anything
// else is left untouched and reported for manual migration.
//
// Design notes:
//   * edits are rendered inside-out (containment tree), so nested rewrites
//     like `.run(keyId())` -> `.run([await keyId()])` compose correctly;
//   * `helper(x).prop` becomes `(await helper(x)).prop` (paren rule);
//   * same-named `stmt` variables in sibling functions are bound by their
//     enclosing function, never merged;
//   * dynamic `const { initDb } = await import('...')` is handled by editing
//     the destructuring, not by requiring a static import.
//
// Usage: node codemod-tests.mjs <file.ts> [...]   (prints a JSON report)
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const METHODS = new Set(['run', 'get', 'all']);
const HAZARD_CALLERS = new Set([
  'map', 'forEach', 'filter', 'some', 'every', 'reduce', 'find', 'findIndex', 'sort', 'flatMap',
]);
// Shared helpers that are already async after the PG migration — their call
// sites in every file must be awaited.
const SHARED_ASYNC = new Set([
  'addToActiveChain', 'seedDecisionModels', 'seedSearchEngines',
  'mintDashboardToken', 'initTestDb',
]);

const TESTS_ROOT = path.resolve('src/__tests__');

// Cache: absolute source path -> Set of exported async function names.
const asyncExportsCache = new Map();

/** Resolve a relative import specifier (…/*.js) to the on-disk .ts source. */
function resolveSource(importerFile, specifier) {
  const base = path.resolve(path.dirname(importerFile), specifier);
  const candidates = base.endsWith('.js')
    ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')]
    : [base + '.ts', base, path.join(base, 'index.ts')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  return null;
}

/** Names exported as `async` functions from a product source file. */
function asyncExportsOf(srcPath) {
  if (asyncExportsCache.has(srcPath)) return asyncExportsCache.get(srcPath);
  const names = new Set();
  try {
    const text = fs.readFileSync(srcPath, 'utf8');
    const sf = ts.createSourceFile(srcPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) && st.name) {
        names.add(st.name.text);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          const init = d.initializer;
          const isAsyncFn = init && ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
            init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));
          if (isAsyncFn && ts.isIdentifier(d.name)) names.add(d.name.text);
        }
      }
    }
  } catch { /* unresolvable — treat as no async exports */ }
  asyncExportsCache.set(srcPath, names);
  return names;
}

/**
 * Local names imported from relative product modules that resolve to an async
 * function. Awaiting a non-promise is a no-op, so a false positive is safe;
 * false negatives just leave a file for the manual bucket.
 */
function asyncImportedNames(sf, file) {
  const out = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const spec = st.moduleSpecifier.getText(sf).replace(/^['"]|['"]$/g, '');
    if (!spec.startsWith('.')) continue;           // only relative product imports
    if (/__tests__|\/helpers\//.test(spec)) continue; // skip test helpers
    const src = resolveSource(file, spec);
    if (!src) continue;
    const asyncNames = asyncExportsOf(src);
    if (!asyncNames.size) continue;
    const clause = st.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const el of clause.namedBindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (asyncNames.has(imported)) out.add(el.name.text); // local alias
    }
  }
  return out;
}

function codemodFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const reasons = [];
  /** @type {Array<{start:number,end:number,build?:(r:Function)=>string,replacement?:string}>} */
  const edits = [];
  const addEdit = (start, end, build) =>
    edits.push(typeof build === 'function' ? { start, end, build } : { start, end, replacement: build });

  const isFnLike = (n) =>
    ts.isArrowFunction(n) || ts.isFunctionExpression(n) ||
    ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);

  // ---- pass 1: facts -------------------------------------------------------
  const initDbCalls = [];        // {node, fn}
  const directCalls = [];        // {node, fn, receiverNode, sqlNode}
  const stmtDecls = [];          // {ident, stmt, receiverNode, sqlNode, fn, refs, bound}
  const dynamicImportStmts = []; // VariableStatements destructure initDb
  let usesInitDb = false;
  let initDbVariants = 0;

  {
    const stack = [];
    const enc = () => (stack.length ? stack[stack.length - 1] : null);
    const visit = (node) => {
      if (isFnLike(node)) { stack.push(node); ts.forEachChild(node, visit); stack.pop(); return; }

      if (ts.isVariableDeclaration(node) && node.initializer &&
        ts.isAwaitExpression(node.initializer) &&
        ts.isCallExpression(node.initializer.expression) &&
        node.initializer.expression.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.name && ts.isObjectBindingPattern(node.name) &&
        node.name.elements.some((e) => e.name.getText(sf) === 'initDb')) {
        dynamicImportStmts.push(node.parent.parent); // VariableStatement
      }

      if (ts.isVariableDeclaration(node) && node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isPropertyAccessExpression(node.initializer.expression) &&
        node.initializer.expression.name.text === 'prepare' &&
        node.initializer.arguments.length === 1 &&
        ts.isIdentifier(node.name)) {
        const stmt = node.parent.parent; // VariableStatement
        stmtDecls.push({
          ident: node.name.text,
          stmt,
          receiverNode: node.initializer.expression.expression,
          sqlNode: node.initializer.arguments[0],
          fn: enc(),
          refs: 0,
          bound: 0,
          unsupported: !stmt || !ts.isVariableStatement(stmt) ||
            stmt.declarationList.declarations.length !== 1,
        });
      }

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'initDb') {
        usesInitDb = true;
        initDbCalls.push({ node, fn: enc() });
        const arg = node.arguments[0];
        const isMemory = arg && ts.isStringLiteral(arg) && arg.text === ':memory:';
        if (!isMemory || node.arguments.length !== 1) initDbVariants++;
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const inner = node.expression.expression;
        if (METHODS.has(method) && ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          inner.expression.name.text === 'prepare' && inner.arguments.length === 1) {
          directCalls.push({
            node, fn: enc(),
            receiverNode: inner.expression.expression,
            sqlNode: inner.arguments[0],
          });
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Names of file-local functions the edits below will make async — their
  // call sites must be awaited as well.
  const localAsyncedNames = new Set();
  for (const { fn } of [...initDbCalls, ...directCalls]) {
    if (!fn) continue;
    if (ts.isFunctionDeclaration(fn) && fn.name) localAsyncedNames.add(fn.name.text);
    else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
      localAsyncedNames.add(fn.parent.name.text);
    }
  }
  const asyncedNames = new Set([...SHARED_ASYNC, ...localAsyncedNames, ...asyncImportedNames(sf, file)]);

  // ---- pass 2: stmt-var uses, helper calls, stray refs ---------------------
  const stmtUses = [];   // {decl, call, fn}
  const helperCalls = []; // {node, fn}
  const badStmtRefs = []; // {ident, snippet}
  {
    const stack = [];
    const enc = () => (stack.length ? stack[stack.length - 1] : null);
    const fnInside = (uFn, dFn) => {
      if (!dFn) return true; // top-level decl visible everywhere (uniqueness checked later)
      if (!uFn) return false;
      return uFn === dFn || (uFn.pos >= dFn.pos && uFn.end <= dFn.end);
    };
    const visit = (node) => {
      if (isFnLike(node)) { stack.push(node); ts.forEachChild(node, visit); stack.pop(); return; }

      // IDENT.method(...) where IDENT is a recorded stmt var — the only
      // supported use form.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && METHODS.has(node.expression.name.text)) {
        const ident = node.expression.expression.text;
        if (stmtDecls.some((d) => d.ident === ident)) {
          const uFn = enc();
          const cands = stmtDecls.filter((d) => d.ident === ident && !d.unsupported && fnInside(uFn, d.fn));
          if (cands.length === 1) {
            stmtUses.push({ decl: cands[0], call: node, fn: uFn });
            cands[0].refs++; cands[0].bound++;
          } else {
            badStmtRefs.push({ ident, snippet: node.getText(sf).slice(0, 60) });
          }
          return;
        }
      }
      // any other reference to a stmt-var ident
      if (ts.isIdentifier(node) && stmtDecls.some((d) => d.ident === node.text)) {
        const inOwnDecl = stmtDecls.some((d) => d.stmt &&
          node.pos >= d.stmt.pos && node.end <= d.stmt.end);
        const isPropName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
        if (!inOwnDecl && !isPropName) {
          badStmtRefs.push({ ident: node.text, snippet: node.getText(sf).slice(0, 60) });
        }
      }

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        asyncedNames.has(node.expression.text) &&
        !ts.isAwaitExpression(node.parent)) {
        helperCalls.push({ node, fn: enc() });
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // ---- safety gates --------------------------------------------------------
  if (initDbVariants > 0) reasons.push(`initDb with non-':memory:' args (${initDbVariants}x)`);
  for (const r of badStmtRefs.slice(0, 3)) reasons.push(`stmt var '${r.ident}' used in unsupported way: ${r.snippet}`);
  for (const d of stmtDecls) {
    if (d.unsupported && d.refs > 0) reasons.push(`stmt var '${d.ident}' declared in unsupported form`);
  }

  const checkHazards = (node, fn, what) => {
    if (!fn) return; // top-level await — fine in ESM
    if (ts.isMethodDeclaration(fn) || fn.asteriskToken !== undefined || ts.isGetAccessor(fn)) {
      reasons.push(`${what} inside a method/generator — needs manual async handling`);
      return;
    }
    const parent = fn.parent;
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isIdentifier(callee) ? callee.text : '';
      if (name === 'describe') {
        reasons.push(`${what} directly in describe scope`);
        return;
      }
      if (HAZARD_CALLERS.has(name)) {
        // `await rows.map(async ...)` under Promise.all is legitimate.
        const mapOk = name === 'map' && (
          ts.isAwaitExpression(parent.parent) ||
          (ts.isCallExpression(parent.parent) &&
            ts.isPropertyAccessExpression(parent.parent.expression) &&
            parent.parent.expression.name.text === 'all'));
        if (!mapOk) {
          reasons.push(`${what} inside .${name}() callback — needs for-of/Promise.all rewrite`);
        }
      }
    }
  };
  for (const c of directCalls) checkHazards(c.node, c.fn, 'DB call');
  for (const c of initDbCalls) checkHazards(c.node, c.fn, 'initDb call');
  for (const c of stmtUses) checkHazards(c.call, c.fn, 'DB call');
  for (const c of helperCalls) checkHazards(c.node, c.fn, `call to ${c.node.expression.text}()`);

  // leftover prepare() that matched no pattern => unknown shape
  {
    const leftovers = [];
    const known = new Set([
      ...directCalls.map((c) => c.node.expression.expression),
      ...stmtDecls.map((d) => d.receiverNode.parent.parent), // the prepare(...) initializer call
    ]);
    const check = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'prepare' && !known.has(node)) {
        leftovers.push(node.getText(sf).slice(0, 60));
      }
      ts.forEachChild(node, check);
    };
    check(sf);
    if (leftovers.length) reasons.push(`unrecognized prepare() shape: ${leftovers[0]}`);
  }

  if (reasons.length) return { file, status: 'manual', reasons };

  // ---- build edits (deferred rendering) ------------------------------------
  const asyncFns = new Set();
  const markAsync = (fn) => {
    if (fn && !(ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async)) asyncFns.add(fn);
  };

  const rangeOf = (n) => [n.getStart(sf), n.end];
  const chainBuild = (receiverNode, sqlNode, method, args) => (r) => {
    const params = args.length ? `, [${args.map((a) => r(...rangeOf(a))).join(', ')}]` : '';
    return `await ${r(...rangeOf(receiverNode))}.${method}(${r(...rangeOf(sqlNode))}${params})`;
  };
  const chainEdit = (call, receiverNode, sqlNode) => {
    const method = call.expression.name.text;
    // `await db.run(...).lastInsertRowid` binds await to db.run(...) only — the
    // member access would read off the Promise. Parenthesize the awaited call.
    const p = call.parent;
    const memberAccessed =
      (ts.isPropertyAccessExpression(p) && p.expression === call) ||
      (ts.isElementAccessExpression(p) && p.expression === call) ||
      (ts.isCallExpression(p) && p.expression === call);
    const target = ts.isAwaitExpression(p) ? p : call;
    addEdit(...rangeOf(target), (r) => {
      const body = chainBuild(receiverNode, sqlNode, method, call.arguments)(r);
      return memberAccessed ? `(${body})` : body;
    });
  };

  for (const c of directCalls) { chainEdit(c.node, c.receiverNode, c.sqlNode); markAsync(c.fn); }
  for (const u of stmtUses) { chainEdit(u.call, u.decl.receiverNode, u.decl.sqlNode); markAsync(u.fn); }

  // delete consumed stmt-var declarations
  for (const d of stmtDecls) {
    if (d.unsupported || d.refs !== d.bound) continue;
    if (d.refs === 0 && stmtDecls.some((o) => o !== d && o.ident === d.ident)) continue; // ambiguous
    let start = d.stmt.getStart(sf);
    while (start > 0 && /[ \t]/.test(text[start - 1])) start--;
    let end = d.stmt.end;
    if (text[end] === '\n') end++;
    addEdit(start, end, () => '');
  }

  // initDb(':memory:') -> await initTestDb()
  for (const c of initDbCalls) {
    const target = ts.isAwaitExpression(c.node.parent) ? c.node.parent : c.node;
    addEdit(...rangeOf(target), () => 'await initTestDb()');
    markAsync(c.fn);
  }

  // call sites of functions made/known async: await them (paren rule)
  for (const c of helperCalls) {
    const call = c.node;
    const p = call.parent;
    const needsParens = (ts.isPropertyAccessExpression(p) && p.expression === call) ||
      (ts.isCallExpression(p) && p.expression === call);
    addEdit(...rangeOf(call), (r) => {
      const rendered = r(...rangeOf(call));
      return needsParens ? `(await ${rendered})` : `await ${rendered}`;
    });
    markAsync(c.fn);
  }

  // await call sites of LOCAL functions this run made async that aren't already
  // awaited via asyncedNames (e.g. header builders `auth()` that now return a
  // Promise). Names already in asyncedNames were handled above — skip to avoid
  // `await await x()`.
  {
    const enclosingFnOf = (node) => {
      let n = node.parent;
      while (n) {
        if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) ||
            ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) return n;
        n = n.parent;
      }
      return null;
    };
    const asyncLocalNames = new Set();
    for (const fn of asyncFns) {
      let name = null;
      if (ts.isFunctionDeclaration(fn) && fn.name) name = fn.name.text;
      else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
               ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
        name = fn.parent.name.text;
      }
      if (name && !asyncedNames.has(name)) asyncLocalNames.add(name);
    }
    if (asyncLocalNames.size) {
      const localCalls = [];
      const collect = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
            asyncLocalNames.has(node.expression.text) &&
            !ts.isAwaitExpression(node.parent)) {
          localCalls.push(node);
        }
        ts.forEachChild(node, collect);
      };
      collect(sf);
      for (const call of localCalls) {
        const fn = enclosingFnOf(call);
        checkHazards(call, fn, `call to ${call.expression.text}()`);
        const p = call.parent;
        const needsParens = (ts.isPropertyAccessExpression(p) && p.expression === call) ||
          (ts.isCallExpression(p) && p.expression === call);
        addEdit(...rangeOf(call), (r) => {
          const rendered = r(...rangeOf(call));
          return needsParens ? `(await ${rendered})` : `await ${rendered}`;
        });
        markAsync(fn);
      }
    }
  }

  // 'async ' inserts
  for (const fn of asyncFns) {
    if (ts.isArrowFunction(fn)) addEdit(fn.getStart(sf), fn.getStart(sf), () => 'async ');
    else if (ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) {
      const kw = fn.getFirstToken(sf); // 'function'
      addEdit(kw.getStart(sf), kw.getStart(sf), () => 'async ');
    } else if (ts.isMethodDeclaration(fn) && fn.name && text[fn.name.getEnd()] === ':') {
      const at = fn.name.getEnd() + 1;
      addEdit(at, at, () => ' async');
    } else {
      reasons.push('cannot async-ize a function shape');
    }
  }
  if (reasons.length) return { file, status: 'manual', reasons };

  // ---- import fixups -------------------------------------------------------
  const removeSpecifierEdit = (els, idx, what) => {
    if (els.length === 1) return false; // caller drops the whole statement
    const start = idx === 0 ? els[0].getStart(sf) : els[idx - 1].end;
    const end = idx === els.length - 1 ? els[idx].end : els[idx + 1].getStart(sf);
    addEdit(start, end, () => '');
    void what;
    return true;
  };
  const dropStatementEdit = (imp) => {
    let s = imp.getStart(sf);
    while (s > 0 && /[ \t]/.test(text[s - 1])) s--;
    let e = imp.end;
    if (text[e] === '\n') e++;
    addEdit(s, e, () => '');
  };

  if (usesInitDb) {
    let handled = false;
    for (const imp of sf.statements.filter(ts.isImportDeclaration)) {
      const spec = imp.moduleSpecifier.getText(sf);
      if (!/db\/index\.js'?$/.test(spec)) continue;
      const clause = imp.importClause;
      if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
      const els = clause.namedBindings.elements;
      const idx = els.findIndex((e) => e.name.text === 'initDb');
      if (idx === -1) continue;
      if (els.length === 1) dropStatementEdit(imp);
      else removeSpecifierEdit(els, idx);
      handled = true;
      break;
    }
    if (!handled) {
      for (const stmt of dynamicImportStmts) {
        const binding = stmt.declarationList.declarations[0].name;
        const els = binding.elements;
        const idx = els.findIndex((e) => e.name.getText(sf) === 'initDb');
        if (idx === -1) continue;
        if (els.length === 1) dropStatementEdit(stmt);
        else removeSpecifierEdit(els, idx);
        handled = true;
        break;
      }
    }
    if (!handled) {
      reasons.push('initDb used but its import was not found');
      return { file, status: 'manual', reasons };
    }
  }

  // ---- render & apply (containment tree) -----------------------------------
  const render = (ed) => (ed.build ? ed.build((s, e) => renderInside(s, e, ed)) : ed.replacement);
  function renderInside(s, e, excluded) {
    const kids = edits
      .filter((k) => k !== excluded && k.start >= s && k.end <= e)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    let out = '';
    let pos = s;
    for (const k of kids) {
      if (k.start < pos) continue; // already covered by a parent edit
      out += text.slice(pos, k.start) + render(k);
      pos = Math.max(pos, k.end);
    }
    return out + text.slice(pos, e);
  }
  let out = renderInside(0, text.length, null);

  // add the initTestDb import after the last import statement
  if (usesInitDb) {
    const relDir = path.relative(TESTS_ROOT, path.dirname(file));
    const depth = relDir === '' ? 0 : relDir.split(path.sep).length;
    const rel = `${'../'.repeat(depth)}helpers/test-db.js`;
    const imports = out.match(/^import .*?;$/gm);
    const insertAt = imports ? out.indexOf(imports[imports.length - 1]) + imports[imports.length - 1].length : 0;
    out = out.slice(0, insertAt) + `\nimport { initTestDb } from '${rel}';` + out.slice(insertAt);
  }

  if (/\.prepare\(/.test(
    out
      .replace(/`[\s\S]*?`|'[^']*'|"[^"]*"/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, ''),
  )) {
    const m = out.match(/[\s\S]{0,80}\.prepare\([\s\S]{0,80}/);
    return { file, status: 'manual', reasons: [`prepare() remains after rewrite: ${JSON.stringify(m ? m[0] : '')}`] };
  }

  fs.writeFileSync(file, out);
  return { file, status: 'ok', edits: edits.length };
}

const files = process.argv.slice(2);
const report = files.map((f) => {
  try {
    return codemodFile(path.resolve(f));
  } catch (err) {
    return { file: f, status: 'manual', reasons: [`codemod threw: ${String(err.stack).split('\n').slice(0, 4).join(' @ ')}`] };
  }
});
console.log(JSON.stringify(report, null, 1));
