// Test-only ESM loader for test/freeFallback.test.mjs.
// The worker has no "type":"module" in package.json, so plain Node would parse the
// files under test as CommonJS. Force ESM for the service and its one util import.
export async function load(url, context, next) {
  if (url.endsWith('/src/services/freeFallback.js') || url.endsWith('/src/utils/flowLog.js')) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    return { format: 'module', shortCircuit: true, source: readFileSync(fileURLToPath(url), 'utf8') };
  }
  return next(url, context);
}
