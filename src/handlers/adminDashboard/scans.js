// src/handlers/adminDashboard/scans.js
//
// Public cookie-checker activity, surfaced in the Admin Dashboard.
//
// This module reads a DIFFERENT database from the rest of this folder. The
// scanner writes to cookie-scanner-db (env.COOKIE_SCANNER_DB); users, accounts
// and the audit log live in consent-webapp (env.CONSENT_WEBAPP). They are
// separate D1 instances, so a scan can never be SQL-joined to a User row — the
// only thread between them is the email captured in scan_claims.
//
//   scan_events   written by the scanner  one row per submitted URL, append-only,
//                                         kept even when the scan itself fails
//   scan_reports  written by the scanner  one row per DOMAIN. A re-scan upserts
//                                         it (ON CONFLICT(site_url)), so the
//                                         per-scan history exists ONLY in
//                                         scan_events — scan_reports is "latest".
//   scan_claims   written here            scan -> person, appended when someone
//                                         signs up or logs in carrying a scanId
//
// Claims are a separate append-only table rather than columns on scan_reports
// precisely because that upsert would wipe them on the next re-scan.

let claimsTableReady = false;

export async function ensureScanClaimsTable(db) {
  if (claimsTableReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS scan_claims (
        id           TEXT PRIMARY KEY,
        scan_id      TEXT,
        site_url     TEXT,
        scanned_url  TEXT,
        email        TEXT NOT NULL,
        user_id      TEXT,
        purpose      TEXT,
        claimed_at   TEXT NOT NULL
      )`
    )
    .run();
  await db
    .prepare(`CREATE INDEX IF NOT EXISTS idx_scan_claims_site ON scan_claims (site_url, claimed_at)`)
    .run();
  await db
    .prepare(`CREATE INDEX IF NOT EXISTS idx_scan_claims_email ON scan_claims (email, claimed_at)`)
    .run();
  claimsTableReady = true;
}

/**
 * Tie a scan to the person who just proved ownership of an email address.
 *
 * Called from the OTP verify path, where the scanner landing page hands off the
 * scanId it got back from the scan. Best-effort by design: an account must never
 * fail to be created because this bookkeeping write failed.
 */
export async function recordScanClaim(db, { scanId, email, userId, purpose } = {}) {
  if (!db || !scanId || !email) return;
  try {
    await ensureScanClaimsTable(db);

    // The event log records what was typed; scan_reports records what was
    // actually scanned. Take the URLs from the report the scanId points at so a
    // claim still reads sensibly once that domain has been re-scanned.
    const report = await db
      .prepare(`SELECT site_url, scanned_url FROM scan_reports WHERE id = ?1`)
      .bind(scanId)
      .first();

    await db
      .prepare(
        `INSERT INTO scan_claims
           (id, scan_id, site_url, scanned_url, email, user_id, purpose, claimed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(
        crypto.randomUUID(),
        scanId,
        report?.site_url ?? null,
        report?.scanned_url ?? null,
        String(email).trim().toLowerCase(),
        userId || null,
        purpose || null,
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    console.error('[scanClaims] write failed:', err?.message || err);
  }
}

// ── Live vs staging ──────────────────────────────────────────────────────────
// The checker only ever stores a hostname, so this is a heuristic on that name,
// not a fact we were told. Two things count as "staging": a platform-issued
// preview subdomain (the site has no custom domain on it yet) and a conventional
// non-production hostname on the customer's own domain. Everything else — plus
// anything we don't recognise — is treated as live, so a real customer domain is
// never hidden behind the staging filter by a pattern we forgot.
//
// The patterns are SQL LIKE strings and are used TWICE: once to build the WHERE
// clause, once (converted to a RegExp) to label each row. Sharing one list is the
// point — a filter that disagreed with its own badges would be worse than neither.
// Grouped by WHO issued the hostname, so "Webflow staging" and "Framer staging"
// are answerable separately — a Webflow customer still on *.webflow.io is a
// different sales conversation from someone scanning a local build.
const STAGING_GROUPS = [
  { key: 'webflow', label: 'Webflow staging', patterns: ['%.webflow.io'] },
  {
    key: 'framer',
    label: 'Framer staging',
    // Framer publishes to framer.website; framer.app/framer.media are the older
    // and asset-host forms, kept because old scans still carry them.
    patterns: ['%.framer.website', '%.framer.app', '%.framer.media'],
  },
  {
    key: 'host',
    label: 'Other host preview',
    patterns: [
      '%.vercel.app',
      '%.netlify.app',
      '%.pages.dev',
      '%.workers.dev',
      '%.github.io',
      '%.wixsite.com',
      '%.myshopify.com',
      '%.squarespace.com',
      '%.weebly.com',
      '%.herokuapp.com',
      '%.ngrok.io',
      '%.ngrok-free.app',
      '%.ngrok.app',
    ],
  },
  {
    key: 'subdomain',
    label: 'Non-production subdomain',
    // Conventional non-production hostnames on a domain the customer owns.
    patterns: ['staging.%', 'stage.%', 'dev.%', 'test.%', 'preview.%', 'sandbox.%', 'uat.%', 'qa.%', 'demo.%'],
  },
  {
    key: 'local',
    label: 'Local / IP',
    patterns: ['localhost', 'localhost:%', '%.local', '%.test'],
    // Bare IPv4 — GLOB, because LIKE has no character classes.
    glob: '[0-9]*.[0-9]*.[0-9]*.[0-9]*',
  },
];

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/;

/** Which filter values map to which groups. 'staging' means any of them. */
const STAGING_FILTERS = {
  staging: STAGING_GROUPS.map((g) => g.key),
  'staging-webflow': ['webflow'],
  'staging-framer': ['framer'],
  'staging-other': ['host', 'subdomain', 'local'],
};

function likeToRegExp(pattern) {
  const body = pattern
    .split('%')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

const GROUP_RES = STAGING_GROUPS.map((g) => ({ key: g.key, res: g.patterns.map(likeToRegExp) }));

/**
 * Which staging group a hostname belongs to, or null if it looks like a real
 * production domain. Mirrors the SQL below off the same pattern list.
 */
export function stagingKindOf(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return null;
  if (IPV4_RE.test(h)) return 'local';
  return GROUP_RES.find((g) => g.res.some((re) => re.test(h)))?.key ?? null;
}

/** 'staging' | 'live' | 'unknown' (hostname the scanner could not parse). */
export function classifyHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return 'unknown';
  return stagingKindOf(h) ? 'staging' : 'live';
}

/**
 * SQL predicate matching the requested staging groups, plus the binds it needs.
 * Applied in SQL rather than to the mapped rows for the same reason year/month
 * are: the query is capped by LIMIT, so post-filtering would search only the most
 * recent N rows instead of the whole table.
 *
 * @param {string[]} [keys] group keys to match; defaults to all of them.
 */
function stagingPredicate(col, keys) {
  const groups = keys ? STAGING_GROUPS.filter((g) => keys.includes(g.key)) : STAGING_GROUPS;
  const patterns = groups.flatMap((g) => g.patterns);
  const terms = patterns.map(() => `${col} LIKE ?`);
  for (const g of groups) if (g.glob) terms.push(`${col} GLOB '${g.glob}'`);
  return { sql: `(${terms.join(' OR ')})`, binds: patterns };
}

/** ISO cutoff for a "last N days" filter, or null for no bound. */
function cutoffIso(days) {
  const n = Number(days);
  if (!n || n <= 0) return null;
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Every URL put through the public checker, newest first.
 *
 * The joined report is the LATEST report for that domain, not necessarily the
 * one this event produced — scan_reports keeps one row per domain. So grade and
 * cookie count describe the domain's current state; submitted_at is the event's.
 */
export async function listScanEvents(db, { search, days, year, month, claimed, env, limit } = {}) {
  await ensureScanClaimsTable(db);

  const where = [];
  const binds = [];

  // Search covers the claimed email too, so an operator can find "every scan this
  // person ran" by typing their address — the same box that finds a domain.
  if (search) {
    where.push(
      `(e.submitted_url LIKE ? OR e.site_url LIKE ?
        OR EXISTS (SELECT 1 FROM scan_claims c WHERE c.site_url = e.site_url AND c.email LIKE ?))`
    );
    binds.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const cutoff = cutoffIso(days);
  if (cutoff) {
    where.push('e.submitted_at >= ?');
    binds.push(cutoff);
  }
  // Year/month are matched by slicing the stored ISO timestamp rather than with
  // SQLite's date functions, so a malformed value can never silently become NULL
  // and drop the row. This mirrors yearOf()/monthOf() in queries.js.
  //
  // It also has to happen HERE, in SQL, and not on the mapped results: the query
  // is capped by LIMIT, so post-filtering would only ever search within the most
  // recent N rows instead of the whole table.
  if (year) {
    where.push('substr(e.submitted_at, 1, 4) = ?');
    binds.push(String(year));
  }
  if (month) {
    where.push('substr(e.submitted_at, 6, 2) = ?');
    binds.push(String(month).padStart(2, '0'));
  }
  if (claimed === 'claimed') {
    where.push('EXISTS (SELECT 1 FROM scan_claims c WHERE c.site_url = e.site_url)');
  } else if (claimed === 'anonymous') {
    where.push('NOT EXISTS (SELECT 1 FROM scan_claims c WHERE c.site_url = e.site_url)');
  }

  // An unparseable hostname is neither live nor staging, so it is excluded from
  // both sides rather than silently counted as live. "live" means "not in ANY
  // staging group", never just "not in the one group being asked about".
  if (env === 'live') {
    const p = stagingPredicate('e.site_url');
    where.push(`(e.site_url IS NOT NULL AND NOT ${p.sql})`);
    binds.push(...p.binds);
  } else if (STAGING_FILTERS[env]) {
    const p = stagingPredicate('e.site_url', STAGING_FILTERS[env]);
    where.push(`(e.site_url IS NOT NULL AND ${p.sql})`);
    binds.push(...p.binds);
  }

  // 200 by default for the table; the export asks for a much larger page so a
  // downloaded CSV isn't quietly truncated at the screen's limit.
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 10000);
  const sql =
    `SELECT e.id, e.submitted_url, e.site_url, e.submitted_at, e.country, e.referer,
            r.id AS report_id, r.scan_date, r.timing_ms, r.emailed_at,
            json_extract(r.report_data, '$.grade')        AS grade,
            json_extract(r.report_data, '$.totalCookies') AS total_cookies,
            (SELECT COUNT(DISTINCT c.email) FROM scan_claims c WHERE c.site_url = e.site_url) AS claim_count,
            (SELECT c2.email FROM scan_claims c2 WHERE c2.site_url = e.site_url
              ORDER BY c2.claimed_at DESC LIMIT 1)                             AS claimed_by,
            (SELECT group_concat(DISTINCT c3.email) FROM scan_claims c3
              WHERE c3.site_url = e.site_url)                                  AS claim_emails
       FROM scan_events e
       LEFT JOIN scan_reports r ON r.site_url = e.site_url` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY e.submitted_at DESC, e.rowid DESC LIMIT ${cap}`;

  const { results = [] } = await db.prepare(sql).bind(...binds).all();
  return results.map((r) => ({
    id: r.id,
    submittedUrl: r.submitted_url,
    siteUrl: r.site_url,
    submittedAt: r.submitted_at,
    country: r.country,
    referer: r.referer,
    reportId: r.report_id ?? null,
    scanDate: r.scan_date ?? null,
    timingMs: r.timing_ms ?? null,
    emailedAt: r.emailed_at ?? null,
    grade: r.grade ?? null,
    totalCookies: r.total_cookies ?? null,
    claimCount: Number(r.claim_count) || 0,
    claimedBy: r.claimed_by ?? null,
    // Every address that ever claimed this domain, not just the most recent one.
    claimEmails: String(r.claim_emails || '').split(',').map((s) => s.trim()).filter(Boolean),
    envType: classifyHost(r.site_url),
    // 'webflow' | 'framer' | 'host' | 'subdomain' | 'local' | null — lets the row
    // say WHICH kind of staging it is, not just that it is one.
    stagingKind: stagingKindOf(r.site_url),
  }));
}

/**
 * Headline counters for the top of the page, plus the years that actually have
 * scans so the year dropdown only offers ranges that can return something.
 *
 * These are whole-table totals — they deliberately ignore the list filters, the
 * same way the Users page counters do.
 */
export async function getScanStats(db) {
  await ensureScanClaimsTable(db);
  const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // One pass that buckets every parseable hostname into its staging group, or
  // 'live'. A CASE ladder rather than one query per group: the groups are
  // mutually exclusive by first match, exactly like stagingKindOf().
  const kindParts = STAGING_GROUPS.map((g) => {
    const p = stagingPredicate('site_url', [g.key]);
    return { sql: `WHEN ${p.sql} THEN '${g.key}'`, binds: p.binds };
  });
  const kindCase = `CASE ${kindParts.map((k) => k.sql).join(' ')} ELSE 'live' END`;
  const kindBinds = kindParts.flatMap((k) => k.binds);

  const [total, domains, recent, claims, claimants, byKind, years] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS c FROM scan_events`).first(),
    db.prepare(`SELECT COUNT(DISTINCT site_url) AS c FROM scan_events WHERE site_url IS NOT NULL`).first(),
    db.prepare(`SELECT COUNT(*) AS c FROM scan_events WHERE submitted_at >= ?1`).bind(week).first(),
    db.prepare(`SELECT COUNT(*) AS c FROM scan_claims`).first(),
    db.prepare(`SELECT COUNT(DISTINCT email) AS c FROM scan_claims`).first(),
    db
      .prepare(
        `SELECT ${kindCase} AS kind, COUNT(*) AS c
           FROM scan_events WHERE site_url IS NOT NULL GROUP BY kind`
      )
      .bind(...kindBinds)
      .all(),
    db
      .prepare(
        `SELECT DISTINCT substr(submitted_at, 1, 4) AS y
           FROM scan_events
          WHERE submitted_at IS NOT NULL AND length(submitted_at) >= 4
          ORDER BY y DESC`
      )
      .all(),
  ]);

  const counts = Object.fromEntries(
    (byKind?.results ?? []).map((r) => [String(r.kind), Number(r.c) || 0])
  );
  const stagingByKind = Object.fromEntries(STAGING_GROUPS.map((g) => [g.key, counts[g.key] || 0]));

  return {
    totalScans: Number(total?.c) || 0,
    uniqueDomains: Number(domains?.c) || 0,
    scansLast7Days: Number(recent?.c) || 0,
    totalClaims: Number(claims?.c) || 0,
    uniqueClaimants: Number(claimants?.c) || 0,
    // Summed from the buckets, so an unparseable hostname lands in neither —
    // liveScans + stagingScans can be less than totalScans, deliberately.
    liveScans: counts.live || 0,
    stagingScans: Object.values(stagingByKind).reduce((a, b) => a + b, 0),
    stagingByKind,
    years: (years?.results ?? []).map((r) => String(r.y)).filter((y) => /^\d{4}$/.test(y)),
  };
}

/**
 * Scans a given person claimed, for the user detail page. Matched on email —
 * the two databases cannot be joined, and the claim is what carries identity.
 */
export async function listScansForEmail(db, email) {
  const address = String(email || '').trim().toLowerCase();
  if (!db || !address) return [];
  try {
    await ensureScanClaimsTable(db);
    const { results = [] } = await db
      .prepare(
        `SELECT c.id, c.scan_id, c.site_url, c.scanned_url, c.purpose, c.claimed_at,
                r.scan_date, r.emailed_at,
                json_extract(r.report_data, '$.grade')        AS grade,
                json_extract(r.report_data, '$.totalCookies') AS total_cookies
           FROM scan_claims c
           LEFT JOIN scan_reports r ON r.id = c.scan_id
          WHERE c.email = ?1
          ORDER BY c.claimed_at DESC
          LIMIT 100`
      )
      .bind(address)
      .all();

    return results.map((r) => ({
      id: r.id,
      scanId: r.scan_id,
      siteUrl: r.site_url,
      scannedUrl: r.scanned_url,
      purpose: r.purpose,
      claimedAt: r.claimed_at,
      // Null once that domain has been re-scanned: the upsert mints a fresh
      // scan_reports id, so this claim's scan_id no longer resolves.
      scanDate: r.scan_date ?? null,
      emailedAt: r.emailed_at ?? null,
      grade: r.grade ?? null,
      totalCookies: r.total_cookies ?? null,
    }));
  } catch (err) {
    console.error('[scanClaims] lookup failed:', err?.message || err);
    return [];
  }
}
