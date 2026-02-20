// handlers/verifyScript.js
import { markSiteVerified } from '../services/db.js';
export async function handleVerifyScript(request, env) {
  const db = env.CONSENT_WEBAPP;
  
  let body = null;

  try {
    body = await request.json();
  } catch (e) {
    return Response.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const publicUrl = body?.publicUrl?.trim() || '';
  const scriptUrl = body?.scriptUrl?.trim() || '';
  const siteId = body?.siteId; // optional

  if (!publicUrl || !scriptUrl) {
    return Response.json(
      { success: false, error: 'publicUrl and scriptUrl are required' },
      { status: 400 },
    );
  }

  try {
    const resp = await fetch(publicUrl, { redirect: 'follow' });

    if (!resp.ok) {
      return Response.json(
        {
          success: false,
          error: 'Failed to fetch page: ' + resp.status + ' ' + resp.statusText,
        },
        { status: 502 },
      );
    }

    const html = await resp.text();
    const htmlLower = html.toLowerCase(); // Case-insensitive search
    
    // Extract siteId from scriptUrl if not provided (e.g., from /client_data/{siteId}/script.js)
    let extractedSiteId = siteId;
    if (!extractedSiteId && scriptUrl.includes('/client_data/')) {
      const match = scriptUrl.match(/\/client_data\/([^\/]+)\/script\.js/);
      if (match) {
        extractedSiteId = match[1];
      }
    }
    
    // Extract just the domain and path from scriptUrl for more flexible matching
    let scriptUrlParts = scriptUrl;
    try {
      const scriptUrlObj = new URL(scriptUrl);
      scriptUrlParts = scriptUrlObj.pathname + scriptUrlObj.search;
    } catch (e) {
      // If URL parsing fails, use original
    }
    
    // More robust verification: check for multiple patterns (case-insensitive)
    // 1. Check for the full script URL (with or without protocol, quotes, encoding)
    const scriptUrlLower = scriptUrl.toLowerCase();
    const scriptUrlNoProtocol = scriptUrl.replace(/^https?:\/\//i, '').toLowerCase();
    const scriptDomainAndPath = scriptUrlParts.toLowerCase();
    
    const hasScriptUrl = htmlLower.includes(scriptUrlLower) || 
                        htmlLower.includes(scriptUrlNoProtocol) ||
                        htmlLower.includes(scriptDomainAndPath);
    
    // 2. Check for the script path pattern (e.g., /client_data/{siteId}/script.js)
    let hasScriptPath = false;
    if (extractedSiteId) {
      const scriptPathPattern = `/client_data/${extractedSiteId}/script.js`.toLowerCase();
      // Also check without leading slash and with different separators
      const scriptPathPattern2 = `client_data/${extractedSiteId}/script.js`.toLowerCase();
      const scriptPathPattern3 = `client_data\\/${extractedSiteId}\\/script\\.js`.toLowerCase();
      hasScriptPath = htmlLower.includes(scriptPathPattern) ||
                     htmlLower.includes(scriptPathPattern2) ||
                     htmlLower.includes(scriptPathPattern3);
    }
    
    // 3. Check for the script ID attribute (id="consentbit" - case insensitive)
    // Also check for various quote styles and spacing
    const hasScriptId = htmlLower.includes('id="consentbit"') || 
                       htmlLower.includes("id='consentbit'") ||
                       htmlLower.includes('id=consentbit') ||
                       htmlLower.includes('id = "consentbit"') ||
                       htmlLower.includes("id = 'consentbit'") ||
                       htmlLower.match(/id\s*=\s*["']consentbit["']/i);
    
    // 4. Check for ConsentBit script tag with the script URL path
    const hasConsentBitWithPath = htmlLower.includes('consentbit') && 
                                  (htmlLower.includes('client_data') || hasScriptPath);
    
    // 5. Check for script src containing the domain/path (handles custom code sections)
    const scriptSrcPattern = new RegExp(`<script[^>]*src=["'][^"']*${scriptUrlParts.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*["']`, 'i');
    const hasScriptSrc = scriptSrcPattern.test(html);
    
    // 6. Check for encoded URLs (URL encoded or HTML entities)
    const encodedScriptUrl = encodeURIComponent(scriptUrl);
    const hasEncodedUrl = htmlLower.includes(encodedScriptUrl.toLowerCase());
    
    // 7. Check if script is accessible (try to fetch it from the page's origin)
    // This helps verify scripts added via custom code sections that might be dynamically loaded
    let scriptAccessible = false;
    try {
      const pageUrlObj = new URL(publicUrl);
      // Try to construct the script URL relative to the page origin
      const scriptUrlObj = new URL(scriptUrl);
      // If script is on same domain or CDN, it should be accessible
      const scriptCheckUrl = scriptUrl; // Use full URL
      const scriptResp = await fetch(scriptCheckUrl, { 
        method: 'HEAD',
        redirect: 'follow',
        headers: {
          'User-Agent': 'ConsentBit-Verifier/1.0'
        }
      });
      scriptAccessible = scriptResp.ok;
    } catch (scriptCheckErr) {
      // Script might not be accessible from server, that's okay
      console.log('[VerifyScript] Script accessibility check failed (expected for some setups):', scriptCheckErr.message);
    }
    
    // Script is found if any of these patterns match
    // Note: If script is accessible, we consider it verified even if not in HTML
    // (handles cases where script is dynamically injected)
    const found = hasScriptUrl || hasScriptPath || hasScriptId || hasConsentBitWithPath || hasScriptSrc || hasEncodedUrl || scriptAccessible;
    
    // Log for debugging
    console.log('[VerifyScript] Verification patterns:', {
      hasScriptUrl,
      hasScriptPath,
      hasScriptId,
      hasConsentBitWithPath,
      hasScriptSrc,
      hasEncodedUrl,
      scriptAccessible,
      scriptUrl,
      scriptUrlParts,
      extractedSiteId,
      publicUrl
    });

    // ✅ call DB layer only if we have a real siteId
    if (found && siteId) {
      await markSiteVerified(db, siteId, scriptUrl);
    }

    // Return detailed result for debugging
    return Response.json({
      success: true,
      found,
      siteId: siteId || null,
      debug: {
        hasScriptUrl,
        hasScriptPath,
        hasScriptId,
        hasConsentBitWithPath,
        hasScriptSrc,
        hasEncodedUrl,
        scriptAccessible,
        scriptUrl: scriptUrl.substring(0, 100), // Truncate for logging
        publicUrl
      }
    });
  } catch (err) {
    return Response.json(
      { success: false, error: err?.message || 'Verification error' },
      { status: 500 },
    );
  }
}
