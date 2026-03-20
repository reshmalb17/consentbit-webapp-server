# Verifying DB tables and pageviews

## 1. List all tables (D1 / Wrangler)

From the project root (e.g. `consent-manager/`):

```bash
# List tables in the D1 database
wrangler d1 execute consent-webapp --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

For local dev (miniflare):

```bash
wrangler d1 execute consent-webapp --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected tables include: `Site`, `Script`, `ScanHistory`, `ScheduledScan`, `Cookie`, `BannerCustomization`, `Consent`, `PromoCode`, `Subscription`, `Plan`, `PageviewUsage`, `LicenseActivation`, `PaymentEvent`, `ProcessedPaymentIntent`, `SubscriptionQueue`, `User`, `Session`, `Organization`, `OrganizationMember`, and any migrations.

## 2. Check pageview counts

After the pageview endpoint is called (e.g. from your consent script with `siteId`), usage is stored in `PageviewUsage`:

```bash
wrangler d1 execute consent-webapp --remote --command "SELECT id, siteId, yearMonth, pageviewCount, updatedAt FROM PageviewUsage ORDER BY updatedAt DESC LIMIT 20;"
```

## 3. Debug endpoint (optional)

You can expose a small debug endpoint that returns tables and a pageview sample:

1. In `wrangler.toml` (or as a secret), set:
   - `DEBUG_SCHEMA_KEY` to a secret string (e.g. `DEBUG_SCHEMA_KEY = "your-secret"` in `[vars]`).

2. Call (replace `YOUR_WORKER_URL` and `your-secret`):
   ```
   GET https://YOUR_WORKER_URL/api/debug/schema?key=your-secret
   ```

Response: `{ "tables": ["..."], "pageviewSample": [...], "message": "..." }`.

## 4. How pageviews are recorded

- The consent manager exposes `POST /api/pageview` with body `{ "siteId": "<your-site-id>", "pageUrl": "optional" }`.
- Your site’s script should send a request to this endpoint when a page view is counted (e.g. on load or via your analytics).
- Each call increments the monthly count for that `siteId` in `PageviewUsage` (per `yearMonth`).

To verify end-to-end: use a test site with the script installed, trigger a page load that hits `/api/pageview`, then run the `PageviewUsage` query above or the debug endpoint.
