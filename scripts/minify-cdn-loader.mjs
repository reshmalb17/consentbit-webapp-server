/**
 * minify-cdn-loader.mjs
 *
 * Builds  src/handlers/cdnM.js  (minified)  FROM  src/handlers/cdnNm.js  (source of truth).
 *
 *   cdnNm.js  — human-readable live loader. NEVER modified by this script.
 *   cdnM.js   — generated. Byte-identical to cdnNm.js except that the body of the
 *               `const loader = \`...\`` template literal is replaced by its
 *               terser-minified + name-mangled equivalent.
 *
 * Why the eval step (see step 2 below)
 * -----------------------------------
 * The loader lives inside a template literal, so the text in the file is NOT the
 * text the browser receives — JS unescapes it when the template is evaluated
 * (`\.` -> `.`, `\\n` -> `\n`, ...). To guarantee cdnM.js serves a behaviourally
 * identical script we minify the *evaluated* text, then re-escape it for
 * re-embedding. Minifying the raw file text instead would silently shift escapes.
 *
 * Not touched: `loaderIab` — in cdnNm.js it is only `${inlineConfig}` +
 * `${getLoaderIabScript(...)}`, i.e. it has no inline body of its own (that code
 * lives in src/utils/IabCode.js).
 *
 * Usage:
 *   node scripts/minify-cdn-loader.mjs
 *   node scripts/minify-cdn-loader.mjs --dry-run   (stats + sanity checks, no write)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { minify } from 'terser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(__dirname, '../src/handlers/cdnNm.js');
const OUT_PATH = join(__dirname, '../src/handlers/cdnM.js');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Placeholder stubs ─────────────────────────────────────────────────────────
// The two server-side `${...}` injections inside the loader are swapped for
// valid-JS stubs so terser can parse the body, then swapped back afterwards.
// Both are side-effecting statements, so terser never drops them.
const IC_TOKEN = '__CB_IC_PH__'; // ${inlineConfig}
const TR_TOKEN = '__CB_TR_PH__'; // ${translationsVar}

const IC_STUB = `window.${IC_TOKEN}=1;`;
const TR_STUB = `var TRANSLATIONS=window.${TR_TOKEN};`;

const IC_RESTORE_RE = new RegExp(`window\\.${IC_TOKEN}\\s*=\\s*1\\s*;?`, 'g');
const TR_RESTORE_RE = new RegExp(`var\\s+TRANSLATIONS\\s*=\\s*window\\.${TR_TOKEN}\\s*;?`, 'g');

// ── Terser options ────────────────────────────────────────────────────────────
// Deliberately conservative: the goal is smaller/obfuscated, NOT cleverer.
// Anything that could change observable behaviour stays off.
const TERSER_OPTS = {
  ecma: 2020,
  compress: {
    passes: 2,
    dead_code: false, // never drop "unreachable" code
    unused: false,    // never drop declarations that only look unused
    join_vars: false, // keep `var TRANSLATIONS=...` standalone so the restore regex finds it
    sequences: false, // keep the inlineConfig stub a separate statement (comma-joining it breaks re-injection)
  },
  mangle: {
    // TRANSLATIONS is declared by the runtime-injected ${translationsVar};
    // gtag is re-exported as window.gtag and read back by GA/GTM.
    reserved: ['TRANSLATIONS', 'gtag'],
  },
  format: { comments: false },
};

// ── Markers ───────────────────────────────────────────────────────────────────
const LOADER_OPEN = '  const loader = `\n';
const LOADER_CLOSE = '\n`;\n';

function pct(a, b) {
  return `${Math.round((a / b) * 100)}%`;
}

/** Evaluate the template-literal escapes exactly the way the CF Worker will. */
function evaluateTemplateBody(raw) {
  // Safe: `raw` has already had its only two `${...}` expressions replaced by
  // stubs, and the loader body contains no backticks of its own (asserted below).
  // eslint-disable-next-line no-new-func
  return new Function('return `' + raw + '`;')();
}

/** Escape a JS string so it can be pasted back inside a template literal. */
function escapeForTemplate(code) {
  return code
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

(async () => {
  const rawSource = readFileSync(SRC_PATH, 'utf8');
  const hasCRLF = rawSource.includes('\r\n');
  const source = hasCRLF ? rawSource.replace(/\r\n/g, '\n') : rawSource;

  // ── 1. Extract the loader body ──────────────────────────────────────────────
  const openIdx = source.indexOf(LOADER_OPEN);
  if (openIdx === -1) throw new Error(`Cannot find open marker: ${JSON.stringify(LOADER_OPEN)}`);
  const contentStart = openIdx + LOADER_OPEN.length;

  const closeIdx = source.indexOf(LOADER_CLOSE, contentStart);
  if (closeIdx === -1) throw new Error('Cannot find the closing backtick of the loader template literal');
  const contentEnd = closeIdx + 1; // keep the leading \n of LOADER_CLOSE out of the body

  const body = source.slice(contentStart, contentEnd);

  console.log(`\nloader body: ${body.length.toLocaleString()} chars`);

  if (body.includes('`')) {
    throw new Error('Loader body contains a backtick — the eval-based unescape step needs updating');
  }
  if (!body.includes('${inlineConfig}')) throw new Error('loader: ${inlineConfig} not found');
  if (!body.includes('${translationsVar}')) throw new Error('loader: ${translationsVar} not found');

  const exprCount = (body.match(/\$\{/g) || []).length;
  if (exprCount !== 2) {
    throw new Error(`loader body has ${exprCount} template expressions; expected exactly 2 (inlineConfig, translationsVar)`);
  }

  // ── 2. Stub the injections, then unescape to the exact text the browser gets ─
  const stubbed = body
    .replace('${inlineConfig}', IC_STUB)
    .replace('${translationsVar}', TR_STUB);

  const evaluated = evaluateTemplateBody(stubbed);
  console.log(`after unescape: ${evaluated.length.toLocaleString()} chars`);

  // ── 3. Minify ───────────────────────────────────────────────────────────────
  const result = await minify(evaluated, TERSER_OPTS);
  if (result.error) throw result.error;
  let out = result.code;

  console.log(`minified:    ${out.length.toLocaleString()} chars  (${pct(out.length, evaluated.length)} of original)`);

  if (!out.includes(IC_TOKEN)) throw new Error(`${IC_TOKEN} did not survive minification`);
  if (!out.includes(TR_TOKEN)) throw new Error(`${TR_TOKEN} did not survive minification`);

  // ── 4. Re-escape for embedding, then restore the ${...} injections ──────────
  out = escapeForTemplate(out);

  const icHits = (out.match(IC_RESTORE_RE) || []).length;
  const trHits = (out.match(TR_RESTORE_RE) || []).length;
  if (icHits !== 1) throw new Error(`expected 1 inlineConfig stub after minify, found ${icHits}`);
  if (trHits !== 1) throw new Error(`expected 1 translationsVar stub after minify, found ${trHits}`);

  out = out.replace(IC_RESTORE_RE, '${inlineConfig}\n');
  out = out.replace(TR_RESTORE_RE, '${translationsVar}');

  // ── 5. Sanity checks ────────────────────────────────────────────────────────
  if (out.includes(IC_TOKEN) || out.includes(TR_TOKEN)) {
    throw new Error('placeholder token leaked into the output');
  }
  // loaderCore = loader.replace(inlineConfig, '') — the injected config must still
  // appear verbatim and on its own, or the webflow variant keeps a duplicate copy.
  if (!out.startsWith('${inlineConfig}\n')) {
    throw new Error('${inlineConfig} is no longer the first thing in the loader');
  }
  console.log('\n✅  All sanity checks passed');

  // ── 6. Emit cdnM.js ─────────────────────────────────────────────────────────
  const banner =
    '// AUTO-GENERATED — DO NOT EDIT BY HAND.\n' +
    '// Minified build of src/handlers/cdnNm.js (loader template only).\n' +
    '// Regenerate with:  npm run minify:cdn\n';

  // `contentEnd` is the index of the closing backtick, so the body owns the
  // newline in front of it — re-add it after the minified payload.
  let final = banner + source.slice(0, contentStart) + out + '\n' + source.slice(contentEnd);
  if (hasCRLF) final = final.replace(/\n/g, '\r\n');

  if (DRY_RUN) {
    console.log('\n(dry-run — cdnM.js not written)');
    return;
  }

  writeFileSync(OUT_PATH, final, 'utf8');
  console.log(`\n✅  cdnM.js written (${final.length.toLocaleString()} chars)`);
})().catch((err) => {
  console.error('\n❌  Build failed:', err.message || err);
  process.exit(1);
});
