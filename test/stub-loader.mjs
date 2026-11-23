// Test-only ESM loader: swaps the three worker modules newTrackerAlerts.js depends on
// (db.js, team.js, email.js) for the stubs the test puts on globalThis.__alertStubs.
// Needed because db.js imports the whole worker, which does not load under plain Node.
export async function resolve(specifier, context, next) {
  if (context.parentURL?.includes('/src/services/newTrackerAlerts.js')) {
    if (specifier === './db.js') return { url: 'stub:db', shortCircuit: true };
    if (specifier === './team.js') return { url: 'stub:team', shortCircuit: true };
    if (specifier === './email.js') return { url: 'stub:email', shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  // The worker has no "type":"module" in package.json; force ESM for the file under test.
  if (url.endsWith('/src/services/newTrackerAlerts.js')) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    return { format: 'module', shortCircuit: true, source: readFileSync(fileURLToPath(url), 'utf8') };
  }
  if (url === 'stub:db') return { format: 'module', shortCircuit: true, source: 'export const getOrgOwnerEmail = (...a) => globalThis.__alertStubs.dbStub.getOrgOwnerEmail(...a); export const getEffectivePlanForOrganization = (...a) => globalThis.__alertStubs.dbStub.getEffectivePlanForOrganization(...a);' };
  if (url === 'stub:team') return { format: 'module', shortCircuit: true, source: 'export const listSiteAdminRecipients = (...a) => globalThis.__alertStubs.teamStub.listSiteAdminRecipients(...a);' };
  if (url === 'stub:email') return { format: 'module', shortCircuit: true, source: 'export const sendNewTrackerEmail = (...a) => globalThis.__alertStubs.emailStub.sendNewTrackerEmail(...a);' };
  return next(url, context);
}
