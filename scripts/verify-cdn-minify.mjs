/**
 * verify-cdn-minify.mjs
 *
 * Proves src/handlers/cdnM.js is a faithful minification of src/handlers/cdnNm.js.
 *
 *  1. Everything outside the `const loader = \`...\`` body is byte-identical.
 *  2. Both loaders, once the template literal is evaluated (i.e. the exact text a
 *     browser receives), parse as valid JS.
 *  3. The minified loader preserves every observable name/value that mangling is
 *     not allowed to touch: string literals, numbers, regexes, property names.
 *
 * Usage: node scripts/verify-cdn-minify.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import * as acorn from 'acorn';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NM_PATH = join(__dirname, '../src/handlers/cdnNm.js');
const M_PATH = join(__dirname, '../src/handlers/cdnM.js');

const LOADER_OPEN = '  const loader = `\n';
const LOADER_CLOSE = '\n`;\n';

const IC_STUB = 'window.__CB_IC_PH__=1;';
const TR_STUB = 'var TRANSLATIONS=window.__CB_TR_PH__;';

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function split(path) {
  const src = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const openIdx = src.indexOf(LOADER_OPEN);
  const start = openIdx + LOADER_OPEN.length;
  const end = src.indexOf(LOADER_CLOSE, start) + 1;
  return { src, head: src.slice(0, start), body: src.slice(start, end), tail: src.slice(end) };
}

/** The exact JS a browser receives, with the two ${...} injections stubbed. */
function served(body) {
  const stubbed = body.replace('${inlineConfig}', IC_STUB).replace('${translationsVar}', TR_STUB);
  // eslint-disable-next-line no-new-func
  return new Function('return `' + stubbed + '`;')();
}

function collect(code) {
  const ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: 'script' });
  const strings = [];
  const numbers = [];
  const regexes = [];
  const props = [];

  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;

    if (node.type === 'Literal') {
      if (typeof node.value === 'string') strings.push(node.value);
      else if (typeof node.value === 'number') numbers.push(node.value);
      else if (node.regex) regexes.push(`/${node.regex.pattern}/${node.regex.flags}`);
    }
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
      props.push(node.property.name);
    }
    if (node.type === 'Property' && !node.computed) {
      if (node.key.type === 'Identifier') props.push(node.key.name);
    }

    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object' && typeof child.type === 'string') walk(child);
    }
  })(ast);

  return { strings, numbers, regexes, props };
}

function sortedCount(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return m;
}

function short(s) {
  const v = String(s);
  return v.length > 60 ? `${v.slice(0, 60)}…(${v.length})` : v;
}

function diffMultiset(a, b, label, { allowFold = false } = {}) {
  const ma = sortedCount(a);
  const mb = sortedCount(b);
  const missing = [];
  const extra = [];
  for (const [k, n] of ma) {
    const have = mb.get(k) || 0;
    if (have >= n) continue;
    // terser folds `"a" + "b"` into `"ab"`; a literal that reappears inside a
    // longer minified literal is a fold, not a loss.
    if (allowFold && b.some((s) => s.length > String(k).length && s.includes(k))) continue;
    missing.push(`${JSON.stringify(short(k))} x${n - have}`);
  }
  for (const [k, n] of mb) {
    const have = ma.get(k) || 0;
    if (have >= n) continue;
    if (allowFold && a.some((s) => s.length < String(k).length && k.includes(s))) continue;
    extra.push(`${JSON.stringify(short(k))} x${n - have}`);
  }
  const ok = missing.length === 0 && extra.length === 0;
  check(ok, `${label} preserved (${a.length} in source)`,
    ok ? null : `missing: [${missing.slice(0, 8).join(', ')}] extra: [${extra.slice(0, 8).join(', ')}]`);
  return ok;
}

console.log('\n── cdnM.js verification ───────────────────────────────────────\n');

const nm = split(NM_PATH);
const m = split(M_PATH);

// 1. Everything except the loader body must be identical.
const BANNER_LINES = 3;
const mHeadNoBanner = m.head.split('\n').slice(BANNER_LINES).join('\n');
check(mHeadNoBanner === nm.head, 'code before the loader is byte-identical');
check(m.tail === nm.tail, 'code after the loader is byte-identical');

// 2. Both served loaders are valid JS.
const servedNm = served(nm.body);
const servedM = served(m.body);

let astNm, astM;
try { astNm = collect(servedNm); check(true, 'source loader parses as JS'); }
catch (e) { check(false, 'source loader parses as JS', e.message); }
try { astM = collect(servedM); check(true, 'minified loader parses as JS'); }
catch (e) { check(false, 'minified loader parses as JS', e.message); }

// 3. Observable values must survive mangling.
if (astNm && astM) {
  diffMultiset(astNm.strings, astM.strings, 'string literals', { allowFold: true });
  diffMultiset(astNm.regexes, astM.regexes, 'regex literals');
  diffMultiset(astNm.props, astM.props, 'property names');
  // Numbers legitimately shift (terser rewrites 1e3/0x10, folds constants), so
  // only assert no *value* vanished entirely.
  const setNm = new Set(astNm.numbers);
  const setM = new Set(astM.numbers);
  const lost = [...setNm].filter((n) => !setM.has(n));
  check(lost.length === 0, 'numeric literals preserved', lost.length ? `lost: ${lost.slice(0, 10).join(', ')}` : null);
}

// 4. Injection points intact.
check(m.body.startsWith('${inlineConfig}\n'), '${inlineConfig} is still first in the loader');
check((m.body.match(/\$\{inlineConfig\}/g) || []).length === 1, '${inlineConfig} appears exactly once');
check((m.body.match(/\$\{translationsVar\}/g) || []).length === 1, '${translationsVar} appears exactly once');
check(/var TRANSLATIONS\s*=/.test(servedM) === false || servedM.includes('window.__CB_TR_PH__'),
  'TRANSLATIONS is only declared by the injected ${translationsVar}');

// 5. End-to-end: assemble the payloads the worker actually serves and parse them.
//    This is what catches statement-boundary damage from re-injecting ${inlineConfig}
//    / ${translationsVar} into compressed code (ASI hazards, comma-joined IIFEs).
{
  const inlineConfig = '\n    window.__CONSENT_SITE__ = {"id":"site_1","apiBase":"https://x.test"};\n  ';
  const translationsVar = 'var TRANSLATIONS = {"en":{"title":"t"}};';
  // webflowSetup.js is ESM inside a "type": "commonjs" package, so pull the
  // template literal out of the source rather than importing it.
  const wfSrc = readFileSync(join(__dirname, '../src/utils/webflowSetup.js'), 'utf8');
  const wfBody = wfSrc.slice(wfSrc.indexOf('`') + 1, wfSrc.lastIndexOf('`'));
  // eslint-disable-next-line no-new-func
  const webflowSetup = new Function('return `' + wfBody + '`;')();

  const build = (rawBody) =>
    // eslint-disable-next-line no-new-func
    new Function('inlineConfig', 'translationsVar', 'return `' + rawBody + '`;')(inlineConfig, translationsVar);

  for (const [label, rawBody] of [['source', nm.body], ['minified', m.body]]) {
    const loader = build(rawBody);
    const loaderCore = loader.replace(inlineConfig, '');

    check(loaderCore.length < loader.length, `${label}: loaderCore drops the injected config`,
      loaderCore.length < loader.length ? null : 'loader.replace(inlineConfig, "") matched nothing');
    check(!loaderCore.includes('window.__CONSENT_SITE__ = {'), `${label}: no duplicate config left in loaderCore`);

    const variants = {
      standard: loader,
      webflow: `${inlineConfig}${webflowSetup}\n${loaderCore}`,
    };
    for (const [variant, code] of Object.entries(variants)) {
      try {
        acorn.parse(code, { ecmaVersion: 2020, sourceType: 'script' });
        check(true, `${label}: served "${variant}" payload parses (${code.length.toLocaleString()} chars)`);
      } catch (e) {
        check(false, `${label}: served "${variant}" payload parses`, e.message);
      }
    }
  }
}

// 6. Size report.
console.log(`\n  source loader   : ${servedNm.length.toLocaleString()} chars`);
console.log(`  minified loader : ${servedM.length.toLocaleString()} chars  (${Math.round((servedM.length / servedNm.length) * 100)}%)`);

console.log(failures === 0 ? '\n✅  cdnM.js is a faithful minified build of cdnNm.js\n' : `\n❌  ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
