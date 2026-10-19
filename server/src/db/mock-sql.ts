/**
 * A very small SQLite-flavoured SQL engine for the in-memory test pool.
 *
 * db/postgres.ts's hand-written shims only understand the handful of statement
 * shapes the fork's own services used before the PostgreSQL migration, so any
 * query outside that list silently returned "no rows" — which is how a schema
 * missing fifteen tables could hide behind a green-looking server. This module
 * gives the mock a real (if simple) executor so the tests exercise the same
 * statements the code writes: SELECT with WHERE/ORDER BY/LIMIT/aggregates,
 * INSERT (incl. upsert), UPDATE and DELETE, with `?` placeholders and the
 * SQLite functions the code uses (datetime('now'), julianday, strftime).
 *
 * TEST INFRASTRUCTURE ONLY. It is never loaded by the real pool: production
 * goes through pg and the call sites are being ported to `pool.query()`.
 */

export type SqlTables = Map<string, any[]>;

export interface SqlResult {
  rows?: any[];
  changes: number;
  lastInsertRowid: number;
}

const NOW_RE = /(?:datetime|CURRENT_TIMESTAMP)\s*\(\s*'?now'?\s*\)|NOW\(\)|CURRENT_TIMESTAMP/i;

function nowIso(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function normalize(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;\s*$/, '');
}

/** Split on a separator, ignoring anything inside quotes or parentheses. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && text.startsWith(sep, i)) {
      out.push(buf.trim());
      buf = '';
      i += sep.length - 1;
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

let totalChangesCount = 0;

function compare(a: any, b: any): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na < nb ? -1 : na > nb ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a) && /^\d{4}-\d{2}-\d{2}/.test(b)) {
    const toUtc = (s: string) => {
      const norm = s.includes('T') ? s : s.replace(' ', 'T');
      return (!norm.endsWith('Z') && !norm.includes('+')) ? norm + 'Z' : norm;
    };
    const da = Date.parse(toUtc(a));
    const db = Date.parse(toUtc(b));
    if (!Number.isNaN(da) && !Number.isNaN(db)) return da < db ? -1 : da > db ? 1 : 0;
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp('^' + escaped + '$', 'i');
}

function globToRegExp(pattern: string): RegExp {
  let res = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') res += '.*';
    else if (c === '?') res += '.';
    else if (c === '[' || c === ']') res += c;
    else if ('\\^$+().|{}'.includes(c)) res += '\\' + c;
    else res += c;
  }
  res += '$';
  return new RegExp(res);
}

function resolveValue(raw: string, params: any[], state: { i: number }): any {
  const v = raw.trim();
  const lowerM = v.match(/^LOWER\s*\(\s*(.+?)\s*\)$/i);
  if (lowerM) {
    const inner = resolveValue(lowerM[1], params, state);
    return typeof inner === 'string' ? inner.toLowerCase() : inner;
  }
  if (v === '?') {
    const val = params[state.i];
    state.i++;
    return val;
  }
  // PostgreSQL positional placeholders ($1, $2, ...). Without this they fall
  // through to the literal-string return below and silently compare a column
  // against the string "$1" — a mock that lies is worse than no mock.
  if (/^\$(\d+)$/.test(v)) {
    return params[Number(v.slice(1)) - 1];
  }
  if (/^[@$:][A-Za-z_]\w*$/.test(v)) {
    const name = v.slice(1);
    const obj = params[0];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      if (name in obj) return obj[name];
      const snake = name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      if (snake in obj) return obj[snake];
      const camel = name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      if (camel in obj) return obj[camel];
      return null;
    }
  }
  if (/^NULL$/i.test(v)) return null;
  if (/^'(.*)'$/s.test(v)) return v.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'");
  const dtM = v.match(/^datetime\s*\(\s*'?now'?\s*(?:,\s*'([^']*)'\s*)?\)$/i);
  if (dtM) {
    const modifier = dtM[1]?.toLowerCase();
    const d = new Date();
    if (modifier === 'start of day') {
      return `${d.toISOString().slice(0, 10)} 00:00:00`;
    }
    if (modifier === 'start of month') {
      return `${d.toISOString().slice(0, 7)}-01 00:00:00`;
    }
    if (modifier) {
      const relM = modifier.match(/^([+-]?\d+)\s*(days?|hours?|minutes?|mins?|seconds?|secs?)$/i);
      if (relM) {
        const num = Number(relM[1]);
        const unit = relM[2].toLowerCase();
        let ms = 0;
        if (unit.startsWith('day')) ms = num * 86400000;
        else if (unit.startsWith('hour')) ms = num * 3600000;
        else if (unit.startsWith('min')) ms = num * 60000;
        else if (unit.startsWith('sec')) ms = num * 1000;
        return new Date(d.getTime() + ms).toISOString().slice(0, 19).replace('T', ' ');
      }
    }
    return nowIso();
  }
  if (NOW_RE.test(v)) return nowIso();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^-?\d+ms$/i.test(v)) return Number(v.slice(0, -2));
  return v;
}

function evalLhs(row: any, expr: string): any {
  expr = expr.trim();
  const lowerM = expr.match(/^LOWER\s*\(\s*([\s\S]+?)\s*\)$/i);
  if (lowerM) {
    const inner = evalLhs(row, lowerM[1]);
    return typeof inner === 'string' ? inner.toLowerCase() : inner;
  }
  const dtM = expr.match(/^datetime\s*\(\s*([\s\S]+?)\s*\)$/i);
  if (dtM) {
    const inner = evalLhs(row, dtM[1]);
    if (!inner) return null;
    return typeof inner === 'string' ? inner.slice(0, 19).replace('T', ' ') : new Date(inner).toISOString().slice(0, 19).replace('T', ' ');
  }
  const dateM = expr.match(/^date\s*\(\s*([\s\S]+?)\s*\)$/i);
  if (dateM) {
    const inner = evalLhs(row, dateM[1]);
    if (!inner) return null;
    return typeof inner === 'string' ? inner.slice(0, 10) : new Date(inner).toISOString().slice(0, 10);
  }
  const julianM = expr.match(/^julianday\s*\(\s*([\s\S]+?)\s*\)$/i);
  if (julianM) {
    const inner = evalLhs(row, julianM[1]);
    if (!inner) return null;
    return new Date(inner).getTime() / 86400000 + 2440587.5;
  }
  const coalM = expr.match(/^COALESCE\s*\(\s*([\s\S]+?)\s*\)$/i);
  if (coalM) {
    const args = splitTop(coalM[1], ',');
    for (const a of args) {
      const v = evalLhs(row, a);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  if (/^'(.*)'$/s.test(expr)) return expr.slice(1, -1);
  if (/^[A-Za-z_][\w.]*$/.test(expr)) {
    return expr.includes('.') ? row[expr] : (row[expr] !== undefined ? row[expr] : row[expr.split('.').pop()!]);
  }
  return expr;
}

/** Evaluate a single WHERE term against a row. */
function evalTerm(row: any, term: string, params: any[], state: { i: number }): boolean {
  const t = term.trim();
  if (!t) return true;

  if (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let matched = false;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') {
        depth--;
        if (depth === 0) {
          if (i === t.length - 1) matched = true;
          break;
        }
      }
    }
    if (matched) {
      return matchesWhere(row, t.slice(1, -1), params, state);
    }
  }

  const likeM = t.match(/^([\s\S]+?)\s+(LIKE|NOT\s+LIKE)\s+([\s\S]+)$/i);
  if (likeM) {
    const pat = resolveValue(likeM[3], params, state);
    const val = evalLhs(row, likeM[1]);
    const hit = likeToRegExp(String(pat ?? '')).test(String(val ?? ''));
    return likeM[2].toUpperCase().startsWith('NOT') ? !hit : hit;
  }
  const globM = t.match(/^([\s\S]+?)\s+(GLOB|NOT\s+GLOB)\s+([\s\S]+)$/i);
  if (globM) {
    const rawPat = globM[3].trim();
    let pat: any;
    if (/^['"].*['"]$/s.test(rawPat)) {
      pat = resolveValue(rawPat, params, state);
    } else {
      const ev = evalLhs(row, rawPat);
      pat = ev !== undefined ? ev : resolveValue(rawPat, params, state);
    }
    const val = evalLhs(row, globM[1]);
    if (pat === null || pat === undefined || val === null || val === undefined) {
      return false;
    }
    const hit = globToRegExp(String(pat)).test(String(val));
    return globM[2].toUpperCase().startsWith('NOT') ? !hit : hit;
  }
  const inM = t.match(/^([A-Za-z_][\w.]*)\s+(NOT\s+)?IN\s*\((.*)\)$/i);
  if (inM) {
    const colExpr = inM[1];
    const col = colExpr.split('.').pop()!;
    const negate = Boolean(inM[2]);
    const items = splitTop(inM[3], ',').map(x => resolveValue(x, params, state));
    const val = row[colExpr] !== undefined ? row[colExpr] : row[col];
    const hit = items.some(v => compare(val, v) === 0);
    return negate ? !hit : hit;
  }
  const isM = t.match(/^([\s\S]+?)\s+IS\s+(NOT\s+)?NULL$/i);
  if (isM) {
    const val = evalLhs(row, isM[1]);
    const isNull = val === null || val === undefined;
    return isM[2] ? !isNull : isNull;
  }
  const cmpM = t.match(/^([\s\S]+?)\s*(>=|<=|<>|!=|=|>|<)\s*([\s\S]+)$/i);
  if (cmpM) {
    const lhs = evalLhs(row, cmpM[1]);
    const op = cmpM[2];
    const rawRhs = cmpM[3].trim();
    let rhs: any;
    if (rawRhs === '?' || /^\$\d+$/.test(rawRhs)) {
      rhs = resolveValue(rawRhs, params, state);
    } else if (/^['"].*['"]$/s.test(rawRhs)) {
      rhs = resolveValue(rawRhs, params, state);
    } else {
      const v = resolveValue(rawRhs, params, state);
      if (typeof v === 'string' && /^[A-Za-z_][\w.]*(\([\s\S]*\))?$/.test(v.trim())) {
        const ev = evalLhs(row, v);
        rhs = ev !== undefined ? ev : v;
      } else {
        rhs = v;
      }
    }
    const c = compare(lhs, rhs);
    switch (op) {
      case '=': return c === 0;
      case '!=': case '<>': return c !== 0;
      case '>': return c > 0;
      case '>=': return c >= 0;
      case '<': return c < 0;
      case '<=': return c <= 0;
    }
  }
  if (/^[A-Za-z_][\w.]*$/.test(t)) {
    const val = row[t] !== undefined ? row[t] : row[t.split('.').pop()!];
    return !(val === null || val === undefined || val === 0 || val === false || val === '');
  }
  return true;
}

function matchesWhere(row: any, where: string | undefined, params: any[], state = { i: 0 }): boolean {
  if (!where) return true;
  let w = where.trim();
  while (w.startsWith('(') && w.endsWith(')')) {
    let depth = 0;
    let matched = false;
    for (let i = 0; i < w.length; i++) {
      if (w[i] === '(') depth++;
      else if (w[i] === ')') {
        depth--;
        if (depth === 0) {
          if (i === w.length - 1) matched = true;
          break;
        }
      }
    }
    if (matched) {
      w = w.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return splitTop(w, ' OR ').some(group =>
    splitTop(group, ' AND ').every(term => evalTerm(row, term, params, state)));
}

function sortRows(rows: any[], orderBy: string | undefined): any[] {
  if (!orderBy) return rows;
  const specs = splitTop(orderBy, ',').map(spec => {
    const m = spec.trim().match(/^(.+?)(?:\s+(ASC|DESC))?$/i);
    return {
      col: (m?.[1] || spec).trim().split('.').pop()!,
      desc: (m?.[2] || 'ASC').toUpperCase() === 'DESC',
    };
  });
  return [...rows].sort((a, b) => {
    for (const { col, desc } of specs) {
      const c = compare(a[col], b[col]);
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  });
}

const AGGREGATES: Record<string, (vals: any[]) => any> = {
  COUNT: vals => vals.length,
  MAX: vals => (vals.length ? vals.reduce((a, b) => (compare(b, a) > 0 ? b : a)) : null),
  MIN: vals => (vals.length ? vals.reduce((a, b) => (compare(b, a) < 0 ? b : a)) : null),
  SUM: vals => (vals.length ? vals.reduce((sum, v) => sum + (Number(v) || 0), 0) : null),
  AVG: vals => (vals.length ? vals.reduce((s, v) => s + (Number(v) || 0), 0) / vals.length : null),
};

function evalExpr(row: any, expr: string, params: any[]): any {
  expr = expr.trim();
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  if (/^'(.*)'$/s.test(expr)) return expr.slice(1, -1);
  if (/^NULL$/i.test(expr)) return null;

  if (/unixepoch/i.test(expr)) {
    const raw = row.last_checked_at;
    const lastChecked = raw ? (raw instanceof Date ? raw.getTime() : new Date(typeof raw === 'string' && !raw.endsWith('Z') && !raw.includes('+') ? raw.replace(' ', 'T') + 'Z' : raw).getTime()) : null;
    return (lastChecked !== null && !isNaN(lastChecked)) ? Math.max(0, Date.now() - lastChecked) : null;
  }

  const minM = expr.match(/^MIN\s*\(([\s\S]+)\)$/i);
  if (minM) {
    const args = splitTop(minM[1], ',').map(a => evalExpr(row, a, params));
    return Math.min(...args.map(Number));
  }
  const maxM = expr.match(/^MAX\s*\(([\s\S]+)\)$/i);
  if (maxM) {
    const args = splitTop(maxM[1], ',').map(a => evalExpr(row, a, params));
    return Math.max(...args.map(Number));
  }

  const bare = expr.split('.').pop()!;
  if (row[expr] !== undefined) return row[expr];
  if (row[bare] !== undefined) return row[bare];
  return resolveValue(expr, params, { i: 0 });
}

function evalCaseExpr(row: any, expr: string, params: any[]): any {
  const norm = expr.trim();
  if (!/^CASE\b/i.test(norm) || !/\bEND$/i.test(norm)) return null;
  const body = norm.replace(/^CASE\s+/i, '').replace(/\s+END$/i, '').trim();

  let depth = 0;
  let quote: string | null = null;
  let currentClause: 'NONE' | 'WHEN' | 'THEN' | 'ELSE' = 'NONE';
  let condBuf = '';
  let thenBuf = '';
  let elseBuf = '';

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (currentClause === 'WHEN') condBuf += ch;
      else if (currentClause === 'THEN') thenBuf += ch;
      else if (currentClause === 'ELSE') elseBuf += ch;
      if (ch === quote && body[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      if (currentClause === 'WHEN') condBuf += ch;
      else if (currentClause === 'THEN') thenBuf += ch;
      else if (currentClause === 'ELSE') elseBuf += ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;

    if (depth === 0) {
      if (/^WHEN\s+/i.test(body.slice(i))) {
        if (currentClause === 'THEN') {
          if (matchesWhere(row, condBuf.trim(), params, { i: 0 })) {
            return evalExpr(row, thenBuf.trim(), params);
          }
          condBuf = '';
          thenBuf = '';
        }
        currentClause = 'WHEN';
        i += 4;
        continue;
      }
      if (/^THEN\s+/i.test(body.slice(i))) {
        currentClause = 'THEN';
        i += 4;
        continue;
      }
      if (/^ELSE\s+/i.test(body.slice(i))) {
        if (currentClause === 'THEN') {
          if (matchesWhere(row, condBuf.trim(), params, { i: 0 })) {
            return evalExpr(row, thenBuf.trim(), params);
          }
        }
        currentClause = 'ELSE';
        i += 4;
        continue;
      }
    }

    if (currentClause === 'WHEN') condBuf += ch;
    else if (currentClause === 'THEN') thenBuf += ch;
    else if (currentClause === 'ELSE') elseBuf += ch;
  }

  if (currentClause === 'THEN' && condBuf.trim()) {
    if (matchesWhere(row, condBuf.trim(), params, { i: 0 })) {
      return evalExpr(row, thenBuf.trim(), params);
    }
  }
  if (currentClause === 'ELSE' && elseBuf.trim()) {
    return evalExpr(row, elseBuf.trim(), params);
  }
  return null;
}

function extractAgg(expr: string): { aggType: string; target: string } | null {
  const m = expr.match(/^(?:COALESCE\s*\(\s*)?(COUNT|MAX|MIN|SUM|AVG)\s*\(/i);
  if (!m) return null;
  const aggType = m[1].toUpperCase();
  const startIdx = m[0].length;
  let depth = 1;
  let endIdx = -1;
  for (let i = startIdx; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return null;
  const target = expr.slice(startIdx, endIdx).trim();
  return { aggType, target };
}

function project(rows: any[], selectList: string, params: any[]): any[] {
  const cols = splitTop(selectList, ',').map(c => c.trim()).filter(Boolean);
  if (cols.length === 1 && cols[0] === '*') return rows;

  const isAggregate = cols.some(c => extractAgg(c.replace(/\s+AS\s+\w+$/i, '').trim()) !== null);
  if (!rows.length && !isAggregate) return [];
  if (isAggregate) {
    const out: any = {};
    for (const col of cols) {
      let alias = col.match(/\s+AS\s+(\w+)$/i)?.[1];
      let expr = col.replace(/\s+AS\s+\w+$/i, '').trim();
      if (!alias) {
        const noAsMatch = col.match(/^([\s\S]+\))\s+([A-Za-z_]\w*)$/i);
        if (noAsMatch) {
          expr = noAsMatch[1].trim();
          alias = noAsMatch[2];
        }
      }

      const agg = extractAgg(expr);
      if (!agg) {
        if (/julianday/i.test(expr)) {
          const created = rows[0]?.created_at ? new Date(rows[0].created_at).getTime() : Date.now();
          out[alias || 'age_days'] = Math.floor(Math.max(0, Date.now() - created) / 86400000);
        } else if (/^date\s*\(/i.test(expr)) {
          const field = expr.replace(/^date\s*\(/i, '').replace(/\)$/, '').trim().split('.').pop()!;
          const dateVal = rows[0]?.[field];
          out[alias || 'date'] = dateVal ? String(dateVal).slice(0, 10) : null;
        } else {
          out[alias || expr.split('.').pop()!] = rows[0]?.[expr.split('.').pop()!];
        }
        continue;
      }

      const { aggType, target } = agg;
      const fn = AGGREGATES[aggType];
      const colName = alias || aggType.toLowerCase();

      let vals: any[];
      if (/^CASE\b/i.test(target)) {
        vals = rows.map(r => evalCaseExpr(r, target, params)).filter(v => v !== null && v !== undefined);
      } else if (target.includes('+')) {
        const parts = splitTop(target, '+');
        vals = rows.map(r => parts.reduce((acc, p) => acc + (Number(evalExpr(r, p, params)) || 0), 0));
      } else if (target === '*') {
        vals = rows.map(() => 1);
      } else {
        const field = target.split('.').pop()!;
        vals = rows.map(r => r[field]).filter(v => v !== null && v !== undefined);
      }

      const val = fn ? (fn(vals) ?? null) : null;
      out[colName] = val;
      if (aggType === 'COUNT' && !alias) {
        out.count = val;
        out.c = val;
      }
    }
    return [out];
  }

  return rows.map(row => {
    const out: any = {};
    for (const col of cols) {
      const aliasMatch = col.match(/\s+AS\s+["`']?([A-Za-z_]\w*)["`']?$/i);
      const alias = aliasMatch?.[1];
      const expr = col.replace(/\s+AS\s+["`']?[A-Za-z_]\w*["`']?$/i, '').trim();
      if (expr === '*') {
        for (const [k, v] of Object.entries(row)) {
          if (!k.includes('.')) out[k] = v;
        }
        continue;
      }
      if (/^[A-Za-z_]\w*\.\*$/.test(expr)) {
        const prefix = expr.slice(0, -2);
        let found = false;
        for (const [k, v] of Object.entries(row)) {
          if (k.startsWith(prefix + '.')) {
            out[k.slice(prefix.length + 1)] = v;
            found = true;
          }
        }
        if (!found) {
          for (const [k, v] of Object.entries(row)) {
            if (!k.includes('.')) out[k] = v;
          }
        }
        continue;
      }
      if (/^(datetime|CURRENT_TIMESTAMP)\s*\(/i.test(expr) || /^NOW\(\)$/i.test(expr)) {
        out[alias || 'now'] = nowIso();
        continue;
      }
      if (/^NULL$/i.test(expr)) {
        out[alias || 'null'] = null;
        continue;
      }
      if (/^CASE\b/i.test(expr)) {
        out[alias || 'case'] = evalCaseExpr(row, expr, params);
        continue;
      }
      if (/unixepoch/i.test(expr)) {
        const raw = row.last_checked_at;
        const lastChecked = raw ? (raw instanceof Date ? raw.getTime() : new Date(typeof raw === 'string' && !raw.endsWith('Z') && !raw.includes('+') ? raw.replace(' ', 'T') + 'Z' : raw).getTime()) : null;
        out[alias || 'age_ms'] = (lastChecked !== null && !isNaN(lastChecked)) ? Math.max(0, Date.now() - lastChecked) : null;
        continue;
      }
      if (/julianday/i.test(expr)) {
        const created = row.created_at ? new Date(row.created_at).getTime() : Date.now();
        out[alias || 'age_days'] = Math.floor(Math.max(0, Date.now() - created) / 86400000);
        continue;
      }
      if (/^date\s*\(/i.test(expr)) {
        const field = expr.replace(/^date\s*\(/i, '').replace(/\)$/, '').trim().split('.').pop()!;
        const dateVal = row[field];
        out[alias || 'date'] = dateVal ? String(dateVal).slice(0, 10) : null;
        continue;
      }
      if (/^COALESCE\s*\(/i.test(expr)) {
        const args = splitTop(expr.replace(/^COALESCE\s*\(/i, '').replace(/\)$/, ''), ',');
        const first = args.map(a => {
          const trimmed = a.trim();
          if (/^[A-Za-z_][\w.]*$/i.test(trimmed) && !/^(NULL|TRUE|FALSE)$/i.test(trimmed)) {
            const bare = trimmed.split('.').pop()!;
            if (row[trimmed] !== undefined && row[trimmed] !== null) return row[trimmed];
            if (row[bare] !== undefined && row[bare] !== null) return row[bare];
            return null;
          }
          return resolveValue(trimmed, params, { i: 0 });
        }).find(v => v !== null && v !== undefined);
        out[alias || 'coalesce'] = first ?? null;
        continue;
      }
      const isNullM = expr.match(/^(.+?)\s+IS\s+(NOT\s+)?NULL$/i);
      if (isNullM) {
        const inner = isNullM[1].trim();
        const innerBare = inner.split('.').pop()!;
        const val = row[inner] !== undefined ? row[inner] : row[innerBare];
        const isNull = val === null || val === undefined;
        out[alias || 'is_null'] = isNullM[2] ? !isNull : isNull;
        continue;
      }
      if (/^-?\d+(\.\d+)?$/.test(expr)) {
        out[alias || expr] = Number(expr);
        continue;
      }
      if (/^'(.*)'$/s.test(expr)) {
        out[alias || expr] = expr.slice(1, -1).replace(/''/g, "'");
        continue;
      }
      const bare = expr.split('.').pop()!;
      if (bare.toLowerCase() === 'rowid') {
        out[alias || bare] = row.rowid !== undefined ? row.rowid : row.id;
        continue;
      }
      out[alias || bare] = row[expr] !== undefined ? row[expr] : row[bare];
    }
    return out;
  });
}

function tableRows(tables: SqlTables, name: string): any[] {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name)!;
}

/**
 * Execute one statement against the in-memory tables.
 * Returns `null` when the statement is outside what this engine understands, so
 * the caller can fall back to its own hand-written handling.
 */
export function execStatement(
  tables: SqlTables,
  sql: string,
  params: any[] = [],
  nextId: () => number = () => 1,
): SqlResult | null {
  const s = normalize(sql);
  if (!s) return null;
  const pragmaM = s.match(/^PRAGMA\s+table_info\s*\(\s*([A-Za-z_][\w]*)\s*\)/i);
  if (pragmaM) {
    const t = pragmaM[1].toLowerCase();
    const rows = tableRows(tables, t);
    const TABLE_COLUMNS: Record<string, string[]> = {
      media_models: ['id', 'platform', 'model_id', 'display_name', 'modality', 'priority', 'enabled', 'quota_label', 'key_id', 'created_at', 'updated_at'],
      embedding_models: ['id', 'platform', 'model_id', 'family', 'display_name', 'dimensions', 'priority', 'enabled', 'key_id', 'created_at', 'updated_at'],
      profiles: ['id', 'name', 'emoji', 'color', 'type', 'sort_order', 'layout_config', 'auto_sort', 'auto_include_new_models', 'created_at', 'updated_at'],
      models: ['id', 'provider_id', 'platform', 'model_id', 'canonical_name', 'display_name', 'intelligence_rank', 'speed_rank', 'size_label', 'rpm_limit', 'rpd_limit', 'tpm_limit', 'tpd_limit', 'context_window', 'max_output_tokens', 'enabled', 'supports_streaming', 'supports_tools', 'supports_vision', 'supports_structured_output', 'supports_reasoning', 'priority', 'key_id', 'endpoint_scope', 'source'],
      api_keys: ['id', 'platform', 'label', 'encrypted_key', 'iv', 'auth_tag', 'group_label', 'base_url', 'status', 'enabled', 'model_scope_json', 'monthly_request_cap', 'monthly_token_cap', 'proxy_encrypted', 'proxy_iv', 'proxy_auth_tag', 'created_at', 'updated_at'],
      key_monthly_usage: ['key_id', 'month', 'requests', 'tokens'],
      requests: ['id', 'platform', 'model_id', 'key_id', 'status', 'input_tokens', 'output_tokens', 'latency_ms', 'error', 'request_type', 'client_ip', 'client_user_agent', 'client_agent', 'created_at'],
    };
    const known = TABLE_COLUMNS[t] || [];
    const fromRows = rows[0] ? Object.keys(rows[0]) : [];
    const allCols = Array.from(new Set([...known, ...fromRows]));
    return {
      rows: allCols.map((name, cid) => ({ cid, name, type: 'TEXT', notnull: 0, dflt_value: null, pk: name === 'id' ? 1 : 0 })),
      changes: 0,
      lastInsertRowid: 0,
    };
  }

  if (/^(BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP|PRAGMA|VACUUM|ANALYZE)/i.test(s)) {
    return { changes: 0, lastInsertRowid: 0 };
  }

  if (/^SELECT\s+total_changes\(\)/i.test(s)) {
    const alias = s.match(/^SELECT\s+total_changes\(\)(?:\s+AS\s+["`']?(\w+)["`']?)?/i)?.[1] || 'total_changes()';
    return { rows: [{ [alias]: totalChangesCount }], changes: 0, lastInsertRowid: 0 };
  }

  if (/FROM\s+provider_quota_state\s+pqs/i.test(s)) {
    const pqsRows = tableRows(tables, 'provider_quota_state');
    const apiKeys = tableRows(tables, 'api_keys');
    const obs = tableRows(tables, 'provider_quota_observations');
    const out = pqsRows.map(pqs => {
      const k = apiKeys.find(key => key.id === pqs.key_id);
      const keyLabel = k?.label ?? null;
      const matchingObs = obs.filter(o =>
        o.platform === pqs.platform &&
        o.key_id === pqs.key_id &&
        o.quota_pool_key === pqs.quota_pool_key &&
        o.metric === pqs.metric
      ).sort((a, b) => {
        const c1 = compare(b.observed_at, a.observed_at);
        if (c1 !== 0) return c1;
        return compare(b.created_at, a.created_at);
      });
      const latest = matchingObs[0];
      return {
        platform: pqs.platform,
        keyId: pqs.key_id,
        keyLabel,
        quotaPoolKey: pqs.quota_pool_key,
        metric: pqs.metric,
        limit: pqs.limit_value ?? null,
        remaining: pqs.remaining_value ?? null,
        resetAt: pqs.reset_at ?? null,
        resetStrategy: pqs.reset_strategy ?? null,
        source: pqs.source ?? null,
        confidence: pqs.confidence ?? null,
        notes: pqs.notes ?? null,
        observedAt: pqs.observed_at ?? null,
        updatedAt: pqs.updated_at ?? null,
        providerAccountId: null,
        modelId: latest?.model_id ?? null,
        endpoint: latest?.endpoint ?? null,
        statusCode: latest?.status_code ?? null,
        retryAfterMs: latest?.retry_after_ms ?? null,
        rawJson: latest?.raw_json ?? null,
        createdAt: latest?.created_at ?? null,
      };
    }).sort((a, b) => {
      return a.platform.localeCompare(b.platform) ||
             (a.keyId ?? 0) - (b.keyId ?? 0) ||
             a.quotaPoolKey.localeCompare(b.quotaPoolKey) ||
             a.metric.localeCompare(b.metric);
    });
    return { rows: out, changes: 0, lastInsertRowid: 0 };
  }

  // ── SELECT (plain + aliased INNER/LEFT JOIN) ──────────────────────────────
  const sel = s.match(/^SELECT\s+(?:DISTINCT\s+)?(.+?)\s+FROM\s+([A-Za-z_][\w]*)(.*)$/i);
  if (sel) {
    const [, selectList, table, rest] = sel;

    const baseTable = table.toLowerCase();
    const base = baseTable === 'sqlite_master'
      ? [...tables.keys()].map(name => ({ type: 'table', name, tbl_name: name, sql: '' }))
      : tableRows(tables, baseTable);
    const baseAliasMatch = rest.match(/^\s+(?:AS\s+)?([A-Za-z_]\w*)/i);
    const baseAlias = baseAliasMatch && !/^(WHERE|JOIN|LEFT|INNER|ORDER|GROUP|LIMIT|ON)$/i.test(baseAliasMatch[1])
      ? baseAliasMatch[1].toLowerCase()
      : baseTable;

    const joinRe = /(?:INNER\s+|LEFT\s+(?:OUTER\s+)?|CROSS\s+)?JOIN\s+([A-Za-z_][\w]*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?\s+ON\s+([\s\S]*?)(?=\s+(?:INNER\s+|LEFT\s+(?:OUTER\s+)?|CROSS\s+)?JOIN\b|\s+WHERE\b|\s+GROUP\s+BY\b|\s+ORDER\s+BY\b|\s+LIMIT\b|\s*$)/gi;
    const joins: Array<{ type: 'inner' | 'left'; table: string; alias: string; on: string }> = [];
    for (const jf of rest.matchAll(joinRe)) {
      joins.push({
        type: /LEFT/i.test(jf[0]) ? 'left' : 'inner',
        table: jf[1].toLowerCase(),
        alias: (jf[2] || jf[1]).toLowerCase(),
        on: jf[3].trim(),
      });
    }
    let joined = base.map(r => {
      const row: any = { ...r };
      for (const [k, v] of Object.entries(r)) {
        row[`${baseAlias}.${k}`] = v;
        row[`${baseTable}.${k}`] = v;
      }
      return row;
    });
    for (const j of joins) {
      const side = tableRows(tables, j.table);
      const kinds = splitTop(j.on, ' AND ').map(t => t.trim()).filter(Boolean);
      // An equality between two alias-qualified columns, `a.col = b.col`.
      const link = kinds.filter(t => /^([A-Za-z_][\w.]*)\s*=\s*([A-Za-z_][\w.]*)$/i.test(t));
      const extras = kinds.filter(t => !link.includes(t));
      const out: any[] = [];
      for (const left of joined) {
        let matched = false;
        for (const right of side) {
          const candidate: any = { ...left };
          for (const [k, v] of Object.entries(right)) {
            if (candidate[k] === undefined) candidate[k] = v;
            candidate[`${j.alias}.${k}`] = v;
            candidate[`${j.table}.${k}`] = v;
          }

          let ok = true;
          for (const l of link) {
            const [, lhs, rhs] = l.match(/^([A-Za-z_][\w.]*)\s*=\s*([A-Za-z_][\w.]*)$/i)!;
            const lv = candidate[lhs] !== undefined ? candidate[lhs] : candidate[lhs.split('.').pop()!];
            const rv = candidate[rhs] !== undefined ? candidate[rhs] : candidate[rhs.split('.').pop()!];
            if (compare(lv, rv) !== 0) { ok = false; break; }
          }
          if (ok && extras.length > 0 && !matchesWhere(candidate, extras.join(' AND '), params, { i: 0 })) ok = false;
          if (ok) {
            matched = true;
            out.push(candidate);
          }
        }
        if (!matched && j.type === 'left') {
          out.push({ ...left });
        }
      }
      joined = out;
    }

    // Strip the ON clauses so WHERE/GROUP/ORDER parsing sees only the tail.
    const tailRest = rest.replace(/(?:INNER\s+|LEFT\s+(?:OUTER\s+)?|CROSS\s+)?JOIN\s+[\s\S]*?(?=\s+WHERE\b|\s+GROUP\s+BY\b|\s+ORDER\s+BY\b|\s+LIMIT\b|\s*$)/gi, ' ');
    const whereM = tailRest.match(/\bWHERE\b(.+?)(?=\bGROUP\s+BY\b|\bORDER\b|\bLIMIT\b|$)/i);
    const groupM = tailRest.match(/\bGROUP\s+BY\s+(.+?)(?=\bORDER\b|\bLIMIT\b|$)/i);
    const orderM = tailRest.match(/\bORDER\s+BY\s+(.+?)(?=\bLIMIT\b|$)/i);
    const limitM = tailRest.match(/\bLIMIT\s+(-?\d+|\?)(?:\s+OFFSET\s+(-?\d+|\?))?/i);
    // The WHERE's placeholders re-bind for every row, so each evaluation starts
    // from the same offset; LIMIT/OFFSET then continue from where the WHERE left
    // the cursor, which is exactly the order they appear in the statement.
    const state = { i: 0 };
    const whereBase = state.i;
    const rows = joined.filter(r => matchesWhere(r, whereM?.[1], params, { i: whereBase }));
    state.i += (whereM?.[1]?.match(/\?/g) || []).length;

    if (groupM) {
      const groupCols = splitTop(groupM[1], ',').map(c => c.trim().split('.').pop()!);
      const groups = new Map<string, any[]>();
      for (const r of rows) {
        const key = groupCols.map(c => {
          if (c === 'age_days') {
            const created = r.created_at ? new Date(r.created_at).getTime() : Date.now();
            return String(Math.floor(Math.max(0, Date.now() - created) / 86400000));
          }
          if (c.startsWith('date(')) {
            const field = c.replace(/^date\s*\(/i, '').replace(/\)$/, '').trim().split('.').pop()!;
            return String(r[field] ?? '').slice(0, 10);
          }
          return String(r[c] ?? '');
        }).join('\0');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }
      let out: any[] = [];
      for (const grp of groups.values()) {
        out.push(...project(grp, selectList, params));
      }
      out = sortRows(out, orderM?.[1]);
      if (limitM) {
        const limitVal = resolveValue(limitM[1], params, state);
        const limit = limitVal !== undefined && limitVal !== null ? Number(limitVal) : -1;
        const offsetVal = limitM[2] ? resolveValue(limitM[2], params, state) : 0;
        const offset = offsetVal !== undefined && offsetVal !== null ? Number(offsetVal) : 0;
        out = limit >= 0 ? out.slice(offset, offset + limit) : out.slice(offset);
      }
      return { rows: out, changes: 0, lastInsertRowid: 0 };
    }

    let out = sortRows(rows, orderM?.[1]);
    if (limitM) {
      const limitVal = resolveValue(limitM[1], params, state);
      const limit = limitVal !== undefined && limitVal !== null ? Number(limitVal) : -1;
      const offsetVal = limitM[2] ? resolveValue(limitM[2], params, state) : 0;
      const offset = offsetVal !== undefined && offsetVal !== null ? Number(offsetVal) : 0;
      out = limit >= 0 ? out.slice(offset, offset + limit) : out.slice(offset);
    }
    let projected = project(out, selectList, params);
    if (/^SELECT\s+DISTINCT\b/i.test(s)) {
      const seen = new Set<string>();
      projected = projected.filter(r => {
        const k = JSON.stringify(r);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return { rows: projected, changes: 0, lastInsertRowid: 0 };
  }

  // ── INSERT (incl. ON CONFLICT upsert) ─────────────────────────────────────
  const insHead = s.match(/^INSERT\s+(?:OR\s+(\w+)\s+)?INTO\s+([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?\s*VALUES\s*\(/i);
  if (insHead) {
    const [, orAction, table, colList] = insHead;
    const valStart = insHead[0].length;
    let depth = 1;
    let quote: string | null = null;
    let valEnd = -1;
    for (let i = valStart; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        if (ch === quote && s[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          valEnd = i;
          break;
        }
      }
    }
    const valList = valEnd !== -1 ? s.slice(valStart, valEnd) : '';
    const tail = valEnd !== -1 ? s.slice(valEnd + 1).trim() : '';
    const rows = tableRows(tables, table.toLowerCase());
    const state = { i: 0 };
    const cols = colList ? splitTop(colList, ',').map(c => c.trim()) : Object.keys(rows[0] || {});
    const values = splitTop(valList, ',').map(v => resolveValue(v, params, state));

    const record: any = { id: nextId(), created_at: nowIso(), updated_at: nowIso() };
    cols.forEach((c, i) => { record[c] = values[i]; });
    if (record.enabled === undefined) record.enabled = 1;
    if (table.toLowerCase() === 'models') {
      if (record.endpoint_scope === undefined) record.endpoint_scope = '';
      if (record.source === undefined) record.source = 'user';
    }
    if (table.toLowerCase() === 'requests') {
      if (record.input_tokens === undefined) record.input_tokens = 0;
      if (record.output_tokens === undefined) record.output_tokens = 0;
      if (record.latency_ms === undefined) record.latency_ms = 0;
      if (record.status === undefined) record.status = 'success';
      if (record.request_type === undefined) record.request_type = 'chat';
    }

    if (orAction && /IGNORE/i.test(orAction)) {
      const t = table.toLowerCase();
      const keys = t === 'media_models' ? ['platform', 'model_id'] :
                   t === 'models' ? ['provider_id', 'model_id'] :
                   t === 'providers' ? ['provider_key'] :
                   t === 'settings' ? ['key'] :
                   t === 'search_requests' ? [] :
                   ['id'];
      if (keys.length > 0) {
        const existing = rows.find(r => keys.every(k => record[k] !== undefined && compare(r[k], record[k]) === 0));
        if (existing) {
          return { changes: 0, lastInsertRowid: existing.id ?? 0 };
        }
      }
    }

    const conflictCols = tail.match(/ON\s+CONFLICT\s*\(([^)]*)\)(?:\s+WHERE\s+(.+?))?(?:\s+DO\s+(NOTHING|UPDATE))?/i);
    if (conflictCols) {
      const keys = splitTop(conflictCols[1], ',').map(c => c.trim().split('.').pop()!);
      const existing = rows.find(r => keys.every(k => compare(r[k], record[k]) === 0));
      if (existing) {
        // conflictCols[3] is the ACTION word on its own ('UPDATE' / 'NOTHING').
        if (!/UPDATE/i.test(conflictCols[3] || '')) {
          return { changes: 0, lastInsertRowid: existing.id ?? 0 };
        }
        const updateM = tail.match(/\bDO\s+UPDATE\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i);
        if (updateM) {
          const assignments = updateM[1].trim();
          const whereClause = updateM[2]?.trim();
          if (whereClause) {
            const evalRow: any = { ...existing };
            for (const [k, v] of Object.entries(record)) {
              evalRow[`excluded.${k}`] = v;
            }
            for (const [k, v] of Object.entries(existing)) {
              evalRow[`${table.toLowerCase()}.${k}`] = v;
            }
            if (!matchesWhere(evalRow, whereClause, params, state)) {
              return { changes: 0, lastInsertRowid: existing.id ?? 0 };
            }
          }
          applyResolved(existing, resolveAssignments(assignments, params, state, record, existing));
        }
        return { changes: 1, lastInsertRowid: existing.id ?? 0 };
      }
    }

    rows.push(record);

    if (table.toLowerCase() === 'requests' && record.key_id != null && record.status === 'success') {
      const month = typeof record.created_at === 'string' && record.created_at.length >= 7
        ? record.created_at.slice(0, 7)
        : new Date().toISOString().slice(0, 7);
      const addedTokens = Math.max(0, Number(record.input_tokens) || 0) + Math.max(0, Number(record.output_tokens) || 0);
      const kmRows = tableRows(tables, 'key_monthly_usage');
      const existing = kmRows.find((r: any) => Number(r.key_id) === Number(record.key_id) && r.month === month);
      if (existing) {
        existing.requests = (Number(existing.requests) || 0) + 1;
        existing.tokens = (Number(existing.tokens) || 0) + addedTokens;
      } else {
        kmRows.push({
          id: nextId(),
          key_id: Number(record.key_id),
          month,
          requests: 1,
          tokens: addedTokens,
          created_at: nowIso(),
          updated_at: nowIso(),
        });
      }
    }

    return { changes: 1, lastInsertRowid: record.id, rows: [record] };
  }

  // ── UPDATE ────────────────────────────────────────────────────────────────
  const upd = s.match(/^UPDATE\s+([A-Za-z_][\w]*)\s+SET\s+([\s\S]+?)(?=\bWHERE\b|$)/i);
  if (upd) {
    const [, table, assignments] = upd;
    const whereM = s.match(/\bWHERE\b([\s\S]+)$/i);
    const rows = tableRows(tables, table.toLowerCase());
    // The SET placeholders are bound before the WHERE ones (that is the order
    // they appear in the statement), so resolve them up front; the WHERE's own
    // placeholders then re-bind from that offset for every candidate row.
    const state = { i: 0 };
    const resolved = resolveAssignments(assignments, params, state);
    const whereBase = state.i;
    let changes = 0;
    const updatedRows: any[] = [];
    for (const row of rows) {
      if (!matchesWhere(row, whereM?.[1], params, { i: whereBase })) continue;
      // Increment assignment (`col = col + n`): resolve per row so each
      // candidate adds onto its own value; a shared snapshot would stamp the
      // same sum onto every row. ponytail: no placeholder increments yet —
      // keep the delta as an inline integer literal; add support if a ported
      // call site actually needs one.
      if (/[A-Za-z_][\w.]*\s*\+\s*(?:EXCLUDED\.[A-Za-z_]\w*|-?\d+)$/i.test(assignments)) {
        applyResolved(row, resolveAssignments(assignments, params, { i: 0 }, undefined, row));
      } else {
        applyResolved(row, resolved);
      }
      changes++;
      updatedRows.push(row);
    }
    return { rows: updatedRows, changes, lastInsertRowid: 0 };
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  const del = s.match(/^DELETE\s+FROM\s+([A-Za-z_][\w]*)(?:\s+WHERE\b([\s\S]+))?$/i);
  if (del) {
    const [, table, where] = del;
    const rows = tableRows(tables, table.toLowerCase());
    const inSubqueryM = where?.match(/^\s*(?:([A-Za-z_][\w.]*)\s+IN\s*\(\s*(SELECT\b[\s\S]+?)\s*\))\s*$/i);
    let keep: any[];
    if (inSubqueryM) {
      const col = inSubqueryM[1];
      const subSql = inSubqueryM[2];
      const subRes = execStatement(tables, subSql, params);
      const targetSet = new Set((subRes?.rows || []).map(r => Object.values(r)[0]));
      keep = rows.filter(r => {
        const val = col.toLowerCase() === 'rowid' ? (r.rowid ?? r.id) : (r[col] ?? r[col.split('.').pop()!]);
        return !targetSet.has(val);
      });
    } else {
      keep = rows.filter(r => !matchesWhere(r, where, params));
    }
    const changes = rows.length - keep.length;
    tables.set(table.toLowerCase(), keep);
    totalChangesCount += changes;
    return { changes, lastInsertRowid: 0 };
  }

  return null;
}

/**
 * Turn a `col = expr, ...` list into resolved values. `excluded.<col>` refers to
 * the row the INSERT was trying to write (Postgres' upsert syntax), which the
 * caller passes as `incoming`. `self` is the row being mutated so ledger-style
 * increment assignments (`tokens = key_monthly_usage.tokens + EXCLUDED.tokens`)
 * read the current value instead of treating the expression as a literal.
 */
function resolveAssignments(
  assignments: string,
  params: any[],
  state: { i: number },
  incoming?: Record<string, any>,
  self?: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const assign of splitTop(assignments, ',')) {
    const m = assign.match(/^([A-Za-z_][\w.]*)\s*=\s*(.+)$/);
    if (!m) continue;
    const col = m[1].split('.').pop()!;
    const expr = m[2].trim();
    const excluded = expr.match(/^excluded\.([A-Za-z_]\w*)$/i);
    if (excluded && incoming) {
      out[col] = incoming[excluded[1]];
      continue;
    }
    // Increment arithmetic: `target.col + excluded.col` or `target.col + n`.
    const arith = expr.match(/^(?:[A-Za-z_][\w]*\.)?([A-Za-z_]\w*)\s*\+\s*(?:excluded\.([A-Za-z_]\w*)|(-?\d+))$/i);
    if (arith) {
      const base = Number(self?.[arith[1]] ?? 0);
      const delta = arith[2] != null ? Number(incoming?.[arith[2]] ?? 0) : Number(arith[3] ?? 0);
      out[col] = base + delta;
      continue;
    }
    out[col] = resolveValue(expr, params, state);
  }
  return out;
}

function applyResolved(row: any, resolved: Record<string, any>): void {
  for (const [col, value] of Object.entries(resolved)) row[col] = value;
  row.updated_at = nowIso();
}
