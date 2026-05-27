// handlers/adminBackfillConsentR2.js
//
// One-time admin endpoint: reads D1 Consent records and writes them to R2
// in consent-v2/{domain}/{id}.json format so that the cb-server (Webflow app)
// can find them via its R2-based CSV export.
//
// POST /api/admin/backfill-consent-r2
// Headers: Authorization: Bearer {ADMIN_SECRET}
// Body (optional): { siteId: "...", limit: 500 }
//   - siteId: restrict to a single site (default: all sites)
//   - limit:  max records to process per call (default: 200, max: 1000)

export async function handleAdminBackfillConsentR2(request, env) {
  // Admin-only
  const auth = request.headers.get('Authorization') || '';
  const secret = env.ADMIN_SECRET || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  if (!env.R2) {
    return Response.json({ success: false, error: 'R2 binding missing' }, { status: 500 });
  }

  const db = env.CONSENT_WEBAPP;
  let body = {};
  try { body = await request.json(); } catch { /* no body is fine */ }

  const filterSiteId = body.siteId || null;
  const limit = Math.min(parseInt(body.limit || '200', 10), 1000);
  const offset = parseInt(body.offset || '0', 10);

  console.log('[BackfillConsentR2] start —', { filterSiteId, limit, offset });

  // Fetch D1 Consent rows (with their site domain)
  const { results: rows } = filterSiteId
    ? await db.prepare(
        `SELECT c.id, c.siteId, c.ipAddress, c.userAgent, c.country, c.region,
                c.createdAt, c.regulation, c.bannerType, c.status, c.consent_categories,
                s.domain
         FROM Consent c
         LEFT JOIN Site s ON s.id = c.siteId
         WHERE c.siteId = ?1
         ORDER BY c.createdAt ASC
         LIMIT ?2 OFFSET ?3`
      ).bind(filterSiteId, limit, offset).all()
    : await db.prepare(
        `SELECT c.id, c.siteId, c.ipAddress, c.userAgent, c.country, c.region,
                c.createdAt, c.regulation, c.bannerType, c.status, c.consent_categories,
                s.domain
         FROM Consent c
         LEFT JOIN Site s ON s.id = c.siteId
         ORDER BY c.createdAt ASC
         LIMIT ?1 OFFSET ?2`
      ).bind(limit, offset).all()
    .catch(() => ({ results: [] }));

  const records = rows || [];
  console.log('[BackfillConsentR2] D1 rows fetched:', records.length);

  let written = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of records) {
    const domain = row.domain;
    if (!domain) { skipped++; continue; }

    try {
      // Parse categories
      let cats = null;
      if (row.consent_categories) {
        try {
          const p = typeof row.consent_categories === 'string'
            ? JSON.parse(row.consent_categories)
            : row.consent_categories;
          cats = p && typeof p.categories === 'object' ? p.categories : p;
        } catch { /* ignore */ }
      }
      cats = cats || {};

      const isCcpa = (row.regulation || '').toLowerCase() === 'ccpa' ||
                     (row.bannerType || '').toLowerCase() === 'ccpa';
      const isAccepted = (row.status || '').toLowerCase() === 'accepted' ||
                         (row.status || '').toLowerCase() === 'given';

      // Build legacy R2 record (same format as consent.js dual-write)
      const legacyRecord = [{
        timestamp: row.createdAt,
        action: isAccepted ? 'acceptance' : 'rejection',
        bannerType: isCcpa ? 'CCPA' : 'GDPR',
        country: row.country || '',
        state: row.region || '',
        preferences: {
          necessary: Boolean(cats.essential ?? cats.necessary ?? true),
          analytics: Boolean(cats.analytics),
          marketing: Boolean(cats.marketing),
          personalization: Boolean(cats.preferences || cats.personalization),
          ...(isCcpa ? {
            doNotSell: Boolean(cats.ccpa?.doNotSell),
            doNotShare: Boolean(cats.ccpa?.doNotShare),
          } : {}),
        },
        metadata: {
          ip: row.ipAddress || '',
          userAgent: row.userAgent || '',
          country: row.country || '',
          state: row.region || '',
        },
      }];

      const r2Key = `consent-v2/${domain}/${row.id}.json`;
      await env.R2.put(r2Key, JSON.stringify(legacyRecord), {
        httpMetadata: { contentType: 'application/json' },
      });
      written++;
    } catch (err) {
      console.error('[BackfillConsentR2] error writing', row.id, err?.message);
      errors++;
    }
  }

  const hasMore = records.length === limit;
  const nextOffset = offset + records.length;

  console.log('[BackfillConsentR2] done —', { written, skipped, errors, hasMore, nextOffset });

  return Response.json({
    success: true,
    written,
    skipped,
    errors,
    processed: records.length,
    hasMore,
    nextOffset,
    message: hasMore
      ? `Processed ${records.length} records. Call again with offset=${nextOffset} for next batch.`
      : `Done. All ${records.length} records processed.`,
  });
}
