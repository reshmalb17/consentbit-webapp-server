// Shared helpers for legacy consent data retrieval (R2 + KV).
// Used by legacyConsentLogs.js and legacyConsentCsv.js.

function getDomainFromUrl(url) {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/**
 * Build search keys for a site from its WEBFLOW_AUTHENTICATION KV entry.
 * Returns [siteName, stagingShort, stagingDomain, customDomain, fallbackDomain].
 */
export async function buildSearchKeys(kv, platformSiteId, fallbackDomain, fallbackName) {
  if (!platformSiteId || !kv) {
    return [...new Set([fallbackDomain, fallbackName].filter(Boolean))];
  }
  try {
    const raw = await kv.get(platformSiteId);
    if (raw) {
      const siteData = JSON.parse(raw);
      const siteName = siteData.siteName || '';
      const stagingDomain = siteData.stagingUrl ? getDomainFromUrl(siteData.stagingUrl) : '';
      const stagingShort = stagingDomain.split('.')[0] || '';
      const customDomain = siteData.customDomain ? siteData.customDomain.replace(/^https?:\/\//, '') : '';
      return [...new Set([siteName, stagingShort, stagingDomain, customDomain, fallbackDomain || '', fallbackName || ''].filter(Boolean))];
    }
  } catch { /* ignore */ }
  return [...new Set([fallbackDomain, fallbackName].filter(Boolean))];
}

/**
 * Read R2 Cookie-Preferences.json + consent-v2/ per-visitor keys for all search keys.
 */
export async function getConsentRowsFromR2(r2, searchKeys) {
  const entries = [];
  const allKeys = [...new Set([...searchKeys, ...searchKeys.map(k => k.toLowerCase())])];

  try {
    const obj = await r2.get('Cookie-Preferences.json');
    if (obj) {
      const data = JSON.parse(await obj.text());
      for (const key of allKeys) {
        const siteData = data[key];
        if (!siteData || typeof siteData !== 'object') continue;
        for (const [visitorId, visits] of Object.entries(siteData)) {
          if (!Array.isArray(visits)) continue;
          for (const v of visits) entries.push({ ...v, _visitorId: visitorId });
        }
      }
    }
  } catch (err) {
    console.error('[legacyConsent] R2 Cookie-Preferences.json read failed', err?.message);
  }

  try {
    for (const key of allKeys) {
      const prefix = `consent-v2/${key}/`;
      let cursor;
      do {
        const listed = await r2.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        const objects = listed?.objects ?? [];
        cursor = listed?.truncated ? listed?.cursor : undefined;
        for (let i = 0; i < objects.length; i += 50) {
          const batch = objects.slice(i, i + 50);
          const values = await Promise.all(batch.map(o => r2.get(o.key)));
          for (let j = 0; j < batch.length; j++) {
            const r2Obj = values[j];
            if (!r2Obj) continue;
            try {
              const visits = JSON.parse(await r2Obj.text());
              const visitorId = batch[j].key.split('/').pop()?.replace('.json', '');
              if (!visitorId) continue;
              if (Array.isArray(visits)) {
                for (const v of visits) entries.push({ ...v, _visitorId: visitorId });
              }
            } catch { /* skip */ }
          }
        }
      } while (cursor);
    }
  } catch (err) {
    console.error('[legacyConsent] R2 consent-v2 read failed', err?.message);
  }

  return entries;
}

/**
 * Scan WEBFLOW_AUTHENTICATION KV for Cookie-Preferences:{domain}:{visitorId} keys.
 * Mirrors cb-server export-consent-csv filterKVBySiteId logic.
 */
export async function getConsentRowsFromKV(kv, platformSiteId) {
  const raw = await kv.get(platformSiteId);
  if (!raw) return [];

  let parsedSiteData;
  try { parsedSiteData = JSON.parse(raw); } catch { return []; }

  const domains = [];
  if (parsedSiteData.stagingUrl) {
    domains.push(getDomainFromUrl(parsedSiteData.stagingUrl));
    domains.push(parsedSiteData.stagingUrl);
  }
  if (parsedSiteData.customDomain) {
    const clean = parsedSiteData.customDomain.replace(/^https?:\/\//, '');
    domains.push(clean, parsedSiteData.customDomain, `https://${clean}`);
  }
  if (Array.isArray(parsedSiteData.domains)) {
    for (const d of parsedSiteData.domains) {
      if (d.url) { domains.push(getDomainFromUrl(d.url), d.url); }
    }
  }
  domains.push(platformSiteId);

  const uniqueDomains = [...new Set(domains.filter(Boolean))].sort((a, b) => {
    const aP = a.startsWith('http'), bP = b.startsWith('http');
    if (aP && !bP) return 1;
    if (!aP && bP) return -1;
    return 0;
  });

  const entries = [];
  for (const domain of uniqueDomains) {
    let cursor;
    do {
      const result = await kv.list({ prefix: `Cookie-Preferences:${domain}:`, limit: 1000, ...(cursor ? { cursor } : {}) });
      cursor = result.list_complete ? undefined : result.cursor;
      if (result.keys.length > 0) {
        const values = await Promise.all(result.keys.map(k => kv.get(k.name)));
        for (let i = 0; i < result.keys.length; i++) {
          if (!values[i]) continue;
          try {
            const parsed = JSON.parse(values[i]);
            const keyParts = result.keys[i].name.split(':');
            entries.push({ ...parsed, _visitorId: keyParts.slice(2).join(':') || result.keys[i].name });
          } catch { /* skip */ }
        }
      }
    } while (cursor);
  }

  // Broad fallback if nothing found
  if (entries.length === 0) {
    let cursor;
    do {
      const result = await kv.list({ prefix: 'Cookie-Preferences:', limit: 1000, ...(cursor ? { cursor } : {}) });
      cursor = result.list_complete ? undefined : result.cursor;
      if (result.keys.length > 0) {
        const values = await Promise.all(result.keys.map(k => kv.get(k.name)));
        for (let i = 0; i < result.keys.length; i++) {
          if (!values[i]) continue;
          try {
            const parsed = JSON.parse(values[i]);
            const clientId = parsed.clientId || '';
            const keyName = result.keys[i].name;
            const matches = uniqueDomains.some(d =>
              clientId.includes(d) || keyName.includes(d) ||
              clientId.replace(/^https?:\/\//, '').replace(/^www\./, '') === d.replace(/^https?:\/\//, '').replace(/^www\./, '')
            );
            if (matches) {
              const keyParts = keyName.split(':');
              entries.push({ ...parsed, _visitorId: keyParts.slice(2).join(':') || keyName });
            }
          } catch { /* skip */ }
        }
      }
    } while (cursor);
  }

  return entries;
}

/**
 * Transform a raw R2/KV entry into the ConsentLog shape expected by the dashboard.
 */
export function transformEntry(entry, siteId) {
  const prefs = entry.preferences || {};
  const meta = entry.metadata || {};
  const ts = entry.timestamp || prefs.lastUpdated || meta.timestamp || null;
  const hasMarketing = prefs.marketing || prefs.Marketing;
  const hasAnalytics = prefs.analytics || prefs.Analytics;
  const hasPersonalization = prefs.personalization || prefs.Personalization;
  const isAccepted = entry.action === 'acceptance' || !!(hasAnalytics || hasMarketing || hasPersonalization);
  let categories;
  if (prefs.doNotShare !== undefined || prefs.doNotSell !== undefined || prefs.donotshare !== undefined || prefs.donotselldata !== undefined) {
    categories = { ccpa: { doNotSell: Boolean(prefs.doNotSell || prefs.donotselldata) } };
  } else {
    categories = {
      essential: Boolean(prefs.necessary ?? true),
      analytics: Boolean(hasAnalytics),
      marketing: Boolean(hasMarketing),
      preferences: Boolean(hasPersonalization),
    };
  }
  return {
    id: entry._visitorId || entry.visitorId || String(Math.random()),
    siteId,
    deviceId: null,
    ipAddress: meta.ip || prefs.ip || null,
    userAgent: meta.userAgent || null,
    country: entry.country || meta.country || prefs.country || null,
    region: entry.state || meta.state || null,
    is_eu: 0,
    createdAt: ts,
    updatedAt: ts,
    regulation: entry.bannerType === 'CCPA' || entry.lawType === 'CCPA' ? 'ccpa' : 'gdpr',
    bannerType: entry.bannerType || null,
    consentMethod: 'legacy',
    status: isAccepted ? 'given' : 'rejected',
    expiresAt: null,
    categories,
  };
}
