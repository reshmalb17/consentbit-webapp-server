import { readFileSync } from 'fs';
import { minify } from 'terser';

const raw = readFileSync('src/handlers/cdn.js', 'utf8');
const s = raw.replace(/\r\n/g, '\n');
const lines = s.split('\n');
console.log('Total lines:', lines.length, '| Total chars:', raw.length);

// ── 1. Parse entire cdn.js as a module (worker code) ─────────────────────────
try {
  await minify(s, { ecma: 2020, compress: false, mangle: false, module: true });
  console.log('✅  Whole cdn.js parses OK');
} catch (e) {
  console.log('❌  cdn.js parse error:', e.message, '| line:', e.line, 'col:', e.col);
  if (e.line) {
    for (let i = Math.max(0, e.line - 3); i < Math.min(lines.length, e.line + 3); i++)
      console.log(i + 1 === e.line ? '>>>' : '   ', 'L' + (i+1) + ':', lines[i].slice(0, 120));
  }
}

// ── 2. Parse each loader body as browser JS ───────────────────────────────────
function extractBody(source, openStr, from = 0) {
  const oi = source.indexOf(openStr, from);
  if (oi === -1) return null;
  let i = oi + openStr.length;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '`') return source.slice(oi + openStr.length, i);
    i++;
  }
  return null;
}

function simulate(body) {
  let code = body
    .replace('${inlineConfig}',    'window.__CONSENT_SITE__={};')
    .replace('${translationsVar}', 'var TRANSLATIONS={en:{title:"T"}};');
  return code.replace(/\\`/g, '`');
}

const iabStart   = s.indexOf('const loaderIab=`\n');
const loaderBody = extractBody(s, 'const loader = `\n');
const iabBody    = extractBody(s, 'const loaderIab=`\n', iabStart);

for (const [name, body] of [['loader', loaderBody], ['loaderIab', iabBody]]) {
  if (!body) { console.log('❌ ', name, 'body NOT FOUND'); continue; }
  try {
    await minify(simulate(body), { ecma: 2020, compress: false, mangle: false });
    console.log('✅ ', name, 'browser JS parses OK  (length:', body.length, ')');
  } catch (e) {
    console.log('❌ ', name, 'parse error:', e.message, '| line:', e.line);
    const bl = simulate(body).split('\n');
    if (e.line)
      for (let i = Math.max(0, e.line - 3); i < Math.min(bl.length, e.line + 3); i++)
        console.log(i+1 === e.line ? '>>>' : '   ', 'L'+(i+1)+':', bl[i].slice(0,120));
  }
}

// ── 3. Structural marker checks ───────────────────────────────────────────────
console.log('\n--- Key markers ---');
const markers = [
  '${inlineConfig}', '${translationsVar}',
  'function installConsentScriptBlocker()',
  'function blockNonEssentialScripts()',
  'function releaseBlockedScripts()',
  'test-cmp.pages.dev',
  'const loaderWebflow',
  'const loaderIabWebflow',
  '// @ts-nocheck',
];
for (const m of markers)
  console.log(s.includes(m) ? '✅' : '❌', m);

// ── 4. Comma-merge check ──────────────────────────────────────────────────────
const afterIC = loaderBody ? loaderBody.replace('${inlineConfig}', '').trimStart().slice(0, 1) : '?';
console.log('\nloader starts with (after inlineConfig):', JSON.stringify(afterIC),
  afterIC === ',' ? '❌ COMMA-MERGE BUG' : '✅ OK');
