/**
 * obfuscate-loader.mjs
 *
 * Minifies + obfuscates the loader and loaderIab template literals inside cdn.js.
 *
 * loader     → full mangle + compress  (variable renaming, max obfuscation)
 *              TRANSLATIONS is reserved (injected at runtime via ${translationsVar})
 *
 * loaderIab  → full mangle + compress, with 3 function names RESERVED:
 *              installConsentScriptBlocker, blockNonEssentialScripts, releaseBlockedScripts
 *              must survive because loaderIabWebflow regex-patches them by exact name at runtime.
 *
 * loaderWebflow     = small snippet + loader  → automatically inherits obfuscated loader
 * loaderIabWebflow  = built by patching loaderIab → automatically inherits compressed loaderIab
 *
 * Usage:
 *   node scripts/obfuscate-loader.mjs
 *   node scripts/obfuscate-loader.mjs --dry-run   (print stats only, don't write)
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { minify } from 'terser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDN_PATH  = join(__dirname, '../src/handlers/cdn.js');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Placeholder tokens ────────────────────────────────────────────────────────
// These must survive terser's compression so we can swap them back.
// window property assignments have side effects → terser never removes them.
const IC_PH_TOKEN  = '__CB_IC_PH__';      // for ${inlineConfig}
const TR_PH_TOKEN  = '__CB_TR_PH__';      // for ${translationsVar}  (loader only)

const IC_STUB  = `window.${IC_PH_TOKEN}=1;`;
const TR_STUB  = `var TRANSLATIONS=window.${TR_PH_TOKEN};`;

// After terser the property access may be normalised; search broadly.
const IC_RESTORE_RE = new RegExp(`window\\.${IC_PH_TOKEN}=1;?`, 'g');
const TR_RESTORE_RE = new RegExp(`var TRANSLATIONS=window\\.${TR_PH_TOKEN};?`, 'g');

// ── Terser option sets ────────────────────────────────────────────────────────
const OPTS_FULL = {
  ecma: 2020,
  compress: {
    passes:    2,
    dead_code: false,   // never drop "unreachable" code — template refs look unreachable
    unused:    false,   // never drop vars that look unused (some are used via template exprs)
    join_vars: false,   // keep var TRANSLATIONS=... standalone so the restore regex can find it
    sequences: false,   // prevent ${inlineConfig} stub + IIFE being joined as comma expr (breaks when ; is inserted by server)
  },
  mangle: {
    reserved: ['TRANSLATIONS', 'gtag'],
  },
  format: { comments: false },
};

const OPTS_IAB = {
  ecma: 2020,
  compress: {
    passes:    2,
    dead_code: false,
    unused:    false,
    sequences: false,   // same reason: prevent IC stub being joined with IIFE via comma operator
  },
  mangle: {
    // These 3 names must survive — loaderIabWebflow patches them by exact text at runtime
    reserved: ['TRANSLATIONS', 'gtag', 'installConsentScriptBlocker', 'blockNonEssentialScripts', 'releaseBlockedScripts'],
  },
  format: { comments: false },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractLoaderContent(source, openMarker, endMarker, startSearchFrom = 0) {
  const openIdx = source.indexOf(openMarker, startSearchFrom);
  if (openIdx === -1) throw new Error(`Cannot find open marker: ${JSON.stringify(openMarker)}`);
  const contentStart = openIdx + openMarker.length;

  const endIdx = source.indexOf(endMarker, contentStart);
  if (endIdx === -1) throw new Error(`Cannot find end marker after position ${contentStart}`);

  // content = everything between the opening backtick and the closing backtick
  // endMarker is e.g. "})();\`" — the backtick is the last char, so content ends just before it
  const contentEnd = endIdx + endMarker.length - 1; // index of closing backtick
  return { contentStart, contentEnd, content: source.slice(contentStart, contentEnd) };
}

async function processLoader(raw, { fullMangle, hasTranslations }) {
  // 1. Swap server-side template injections for valid-JS stubs
  let code = raw.replace('${inlineConfig}', IC_STUB);
  if (hasTranslations) {
    code = code.replace('  ${translationsVar}', `  ${TR_STUB}`);
  }

  // 2. Unescape inner template-literal backticks so terser can parse them.
  //    In cdn.js the loader body lives inside an outer template literal, so any
  //    inner template literals use \` to avoid ending the outer one.  Terser
  //    needs plain ` characters to parse them as template literals.
  code = code.replace(/\\`/g, '`');

  // 3. Run terser
  const opts  = fullMangle ? OPTS_FULL : OPTS_IAB;
  const result = await minify(code, opts);
  if (result.error) throw result.error;
  let out = result.code;

  // 4. Re-escape every backtick so the output can be safely re-embedded inside
  //    the outer template literal in cdn.js.
  out = out.replace(/`/g, '\\`');

  // 4.5. Escape all ${ sequences so they are NOT evaluated by the outer CF Worker
  //      template literal. The IC/TR stubs are window.__CB_*__ tokens at this point
  //      (not ${ patterns), so this safely escapes only the inner-template expressions
  //      that should be served as literal ${...} to browsers.
  //      Step 5 below re-introduces ${inlineConfig} / ${translationsVar} as the only
  //      template expressions that the CF Worker is supposed to evaluate.
  out = out.replace(/\$\{/g, '\\${');

  // 5. Restore template injections
  out = out.replace(IC_RESTORE_RE, '${inlineConfig}\n');
  if (hasTranslations) {
    out = out.replace(TR_RESTORE_RE, '${translationsVar}');
  }

  return out;
}

function pct(a, b) { return `${Math.round((a / b) * 100)}%`; }

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const raw_source = readFileSync(CDN_PATH, 'utf8');
  // Normalize to LF so all markers/indices use consistent newlines.
  // We'll restore CRLF on write if the original file used it.
  const hasCRLF = raw_source.includes('\r\n');
  const source = hasCRLF ? raw_source.replace(/\r\n/g, '\n') : raw_source;

  const LOADER_OPEN     = "  const loader = `\n";
  const LOADER_IAB_OPEN = "  const loaderIab=`\n";
  const TMPL_END        = "})();`";          // closing sequence for both template literals

  // loader is first; loaderIab is second → search for TMPL_END from each content start
  const loader    = extractLoaderContent(source, LOADER_OPEN,     TMPL_END);
  const loaderIab = extractLoaderContent(source, LOADER_IAB_OPEN, TMPL_END, loader.contentEnd);

  console.log(`\nloader:    ${loader.content.length.toLocaleString()} chars`);
  console.log(`loaderIab: ${loaderIab.content.length.toLocaleString()} chars`);
  console.log('');

  // Validate that placeholders are found
  if (!loader.content.includes('${inlineConfig}'))    throw new Error('loader: ${inlineConfig} not found');
  if (!loader.content.includes('${translationsVar}')) throw new Error('loader: ${translationsVar} not found');
  if (!loaderIab.content.includes('${inlineConfig}')) throw new Error('loaderIab: ${inlineConfig} not found');

  const [minLoader, minLoaderIab] = await Promise.all([
    processLoader(loader.content,    { fullMangle: true,  hasTranslations: true  }),
    processLoader(loaderIab.content, { fullMangle: false, hasTranslations: false }),
  ]);

  console.log(`loader    minified: ${minLoader.length.toLocaleString()} chars  (${pct(minLoader.length, loader.content.length)} of original)`);
  console.log(`loaderIab minified: ${minLoaderIab.length.toLocaleString()} chars  (${pct(minLoaderIab.length, loaderIab.content.length)} of original)`);

  // Sanity: verify placeholders were restored
  if (!minLoader.includes('${inlineConfig}'))    throw new Error('RESTORE FAILED: loader ${inlineConfig}');
  if (!minLoader.includes('${translationsVar}')) throw new Error('RESTORE FAILED: loader ${translationsVar}');
  if (!minLoaderIab.includes('${inlineConfig}')) throw new Error('RESTORE FAILED: loaderIab ${inlineConfig}');

  // Sanity: loaderIabWebflow patch targets must still be present
  const patchTargets = [
    'function installConsentScriptBlocker()',
    'function blockNonEssentialScripts()',
    'function releaseBlockedScripts()',
  ];
  for (const t of patchTargets) {
    if (!minLoaderIab.includes(t)) throw new Error(`PATCH TARGET MISSING in minLoaderIab: ${t}`);
  }
  console.log('\n✅  All sanity checks passed');

  if (DRY_RUN) {
    console.log('\n(dry-run — cdn.js not modified)');
    return;
  }

  // Rebuild source: replace loaderIab first (it's later in the file) so that
  // the indices for loader (which comes earlier) remain unchanged.
  let out = source;

  out = out.slice(0, loaderIab.contentStart) + minLoaderIab + '\n' + out.slice(loaderIab.contentEnd);

  // loader indices are unchanged because we only touched content after it
  out = out.slice(0, loader.contentStart) + minLoader + '\n' + out.slice(loader.contentEnd);

  const final = hasCRLF ? out.replace(/\n/g, '\r\n') : out;
  writeFileSync(CDN_PATH, final, 'utf8');
  console.log(`\n✅  cdn.js updated (${final.length.toLocaleString()} chars)`);
})().catch(err => {
  console.error('\n❌  Build failed:', err.message || err);
  process.exit(1);
});
