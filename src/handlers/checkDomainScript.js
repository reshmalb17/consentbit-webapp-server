// GET /api/licenses/check-domain-script?domain=xxx[&scriptId=yyy]
// Fetches the domain's public HTML and checks for:
//   - Existing ConsentBit scripts (conflict detection before activation)
//   - Webflow site ID (data-wf-site) for KV setup
//   - Framer detection
// If scriptId is provided, also checks whether that specific script is live (verify step).

export async function handleCheckDomainScript(request, _env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const url = new URL(request.url);
  const domain = (url.searchParams.get('domain') || '').trim();
  const scriptId = (url.searchParams.get('scriptId') || '').trim() || null;

  if (!domain) {
    return Response.json({ success: false, error: 'domain is required' }, { status: 400 });
  }

  const normalized = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  try {
    const res = await fetch(`https://${normalized}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ConsentBit/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return Response.json({ success: true, reachable: false, hasExistingScript: false, wfSiteId: null, isFramer: false, scriptFound: false });
    }

    const html = await res.text();

    // Webflow site ID
    const wfMatch = html.match(/data-wf-site=["']([^"']+)["']/);
    const wfSiteId = wfMatch ? wfMatch[1] : null;

    // Framer detection
    const isFramer = /events\.framer\.com\/script/i.test(html);

    // Any ConsentBit script already installed on the site
    const hasExistingScript =
      /consentbit=["']consentbit["']/i.test(html) ||
      /src=["'][^"']*(?:app|manager)\.consentbit\.com\/consentbit\/[^"']*\/script\.js["']/i.test(html) ||
      /src=["'][^"']*(?:cdn\.consentbit\.com|cookie\.consentbit\.com)[^"']*["']/i.test(html);

    // Verify: check if specific cdnScriptId is present in the page
    const scriptFound = scriptId ? html.includes(scriptId) : false;

    return Response.json({ success: true, reachable: true, hasExistingScript, wfSiteId, isFramer, scriptFound });
  } catch {
    return Response.json({ success: true, reachable: false, hasExistingScript: false, wfSiteId: null, isFramer: false, scriptFound: false });
  }
}
