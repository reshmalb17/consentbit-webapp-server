# Script blocking (CookieYes-style parity)

The ConsentBit embed (`cdn.js`) implements **pre-consent blocking** of third-party scripts:

1. **`document.createElement` hook** — intercepts `<script>`, patches `src` / `type` setters.
2. **`MutationObserver`** — catches scripts/iframes added after load (e.g. GTM).
3. **`type="javascript/blocked"`** — invalid MIME so the browser does not execute; original intent is stored and scripts are re-injected when consent allows (`releaseBlockedScripts`).

## Provider list (`scriptBlockProviders.js`)

- **Location:** `consent-manager/src/data/scriptBlockProviders.js`
- **Shape:** `{ pattern: 'regex-source', categories: ['analytics'|'marketing'|'preferences'|'behavioral'] }`
- **Logic:** If the script URL matches `pattern` (case-insensitive), the script is blocked unless the user has consented to **every** category in `categories`.

### How to build a “complete” list

There is no single global list that covers every tracker. Recommended process:

1. **Start with high-traffic domains** — analytics (GA, Adobe, Mixpanel), ads (Google/Meta/TikTok), tag managers, chat widgets, A/B tools.
2. **Use your own scanner / RUM** — list third-party hosts seen on customer sites; add regexes per host.
3. **Avoid over-broad regexes** — e.g. blocking all of `google.com` breaks Maps, fonts, reCAPTCHA; prefer path-specific patterns (`/gtag/js`, `/gtm.js`, etc.).
4. **Split categories** when one vendor does both ads and analytics (e.g. list both `marketing` and `analytics` if both are required before load).
5. **Customer overrides** — for unknown or first-party proxy URLs, use attributes (below).

## Manual tagging (no URL match needed)

| Attribute | Purpose |
|-----------|---------|
| **`data-consentbit="analytics"`** | **Preferred** — short category: `analytics`, `marketing`, `preferences`, `behavioral`, `essential` |
| `data-consentbit="cookieyes-analytics"` | Same CookieYes-style labels (`cookieyes-marketing`, `cookieyes-functional`, …) |
| `data-consentbit-category="analytics"` | **Legacy** — short names only |
| `data-cookieyes="..."` | **Migration** — same values as `data-consentbit` for existing CookieYes markup |

The loader resolves **`data-consentbit` first**, then `data-consentbit-category`, then **`data-cookieyes`**, then the provider list, then heuristic `categorize(url)`.

## Iframes / embeds

YouTube/Maps iframe blocking may be disabled or simplified in the bundle to avoid edge cases; **rely on provider regex + manual tags** for script-based embeds, or extend the embed for iframe placeholders if product requires it.

## Operational checklist

- [ ] ConsentBit script loads **early** in `<head>` (before trackers).
- [ ] Unknown trackers use **`data-consentbit`** (or legacy `data-consentbit-category` / `data-cookieyes`).
- [ ] After changing `scriptBlockProviders.js`, redeploy the consent manager / CDN that serves `cdn.js`.
