# Banner Close → Floating Logo / 24h Re-show Behavior

**Scope:** GDPR + CCPA banners only. IAB/TCF is intentionally **excluded**.
**Date:** 2026-07-01
**Status:** IMPLEMENTED for the served GDPR/CCPA loaders. Deferred items at the bottom.

---

## Goal

When a visitor closes the GDPR/CCPA banner with the close (X) button:

- Closing records **no consent** -> non-essential scripts/cookies stay **blocked**.
- **Floating logo ENABLED:** banner stays hidden on every page; only the **logo reopens it**.
- **Floating logo DISABLED:** banner stays hidden, then **re-shows after 24 hours** (so a
  visitor with no logo to reopen with can still consent — no dead-end).
- Behavior must respect the webapp "show floating logo" setting.

> **Close is NOT consent.** The stored consent stays `accepted:false` after a close; the logic
> below only controls *display*, never consent state. Scripts remain blocked.

---

## Where it's implemented

Production serves GDPR/CCPA banners from **two** code paths (both edited):

| Loader | serveKind | Source | Status |
|---|---|---|---|
| `loader` (standard core) | `standard` | [`src/handlers/cdn.js`](../src/handlers/cdn.js) | edited |
| `loaderWebflow` | `webflow` | `cdn.js` — built from `loader` core (`loaderCore`) | inherited + Webflow boot branch (Edit F) |
| `public/consent.js` | served at `/consent.js` (legacy embed) | [`public/consent.js`](../public/consent.js) | edited |
| `loaderIab` / `loaderIabWebflow` | `iab` / `iabwebflow` | `src/utils/IabCode.js` | **NOT touched** (see below) |

**Why IAB is excluded:** the IAB/TCF first-layer banner (`#consentBitBanner`) has only
**Customise / Reject All / Accept All** — there is **no close (X) button** (TCF requires an
explicit choice). `cbCloseBtn` belongs to the preference *modal*, not the banner. So there is
no "close without consent" path to handle, and adding one would break TCF compliance.

---

## cdn.js standard loader — the 6 edits

Uses the existing `consentbit_<id>` consent key (`I`). A sibling key `I + "_closed"` stores the
close timestamp.

1. **`Cc()` helper** (after `De()`): returns whether to keep the banner suppressed on load.
   ```js
   function Cc() {
     try {
       var t = parseInt(localStorage.getItem(I + "_closed") || "0", 10);
       if (!t) return !1;
       if (De()) return !0;                       // logo ON  -> stay closed indefinitely
       if (Date.now() - t < 864e5) return !0;     // logo OFF -> stay closed 24h
       localStorage.removeItem(I + "_closed");    // 24h passed -> reset
       return !1
     } catch (e) { return !1 }
   }
   ```
   `De()` is the existing gate that returns false when `showBannerLogo`/`floatingButtonEnabled`
   is off -> it's the source of truth for "is the logo enabled".
2. **Close buttons** (`v` = initial, `y` = prefs): `localStorage.setItem(I+"_closed", String(Date.now()))` before `p()`.
3. **`te()`** (save consent): `localStorage.removeItem(I+"_closed")` after saving — consent clears the flag.
4. **Reset handler** (`data-consentbit-trigger`): also `removeItem(I+"_closed")`.
5. **`He()` non-Webflow branch:** `if (A.accepted || Cc())` -> hide banner, show logo (if any).
6. **`He()` Webflow branch:** `if (A.accepted || Cc())` -> same.

`p()` (the hide function) already reveals the floating trigger, so the logo appears immediately
on close when enabled. Script blocking stays gated on the real `A.accepted` (still false).

## public/consent.js (`/consent.js`) — equivalent edits

- Close handler: `localStorage.setItem('_cb_closed_', String(Date.now()))` + reveal logo if present.
- `bannerClosed` computed with the same rule (logo element present -> indefinite; else 24h).
- `clearConsentState()` removes `_cb_closed_`.
- Logo-enabled proxy here = **presence of the `cb-floating-trigger` element** (this script does
  not create it / read the setting itself). See deferred item 1.

---

## Behavior matrix (GDPR + CCPA)

| Logo setting | Close -> | Next page (within 24h) | After 24h |
|---|---|---|---|
| **ON** | banner hides, logo shows, scripts blocked | banner hidden, logo shows | unchanged (logo is reopen path) |
| **OFF** | banner hides, scripts blocked | banner hidden | **banner re-shows** |

CCPA uses the same close button + same `cb-initial-banner` + same handler -> covered for free.
GPC is handled upstream in the loader and is unaffected (a GPC opt-out sets `accepted`, so the
banner never shows and the close flag is never consulted).

---

## Deploy

- `wrangler.toml`: `main = src/index.js`, `[assets] directory = "./public"`.
- Served loaders come from `cdn.js` (`/consentbit/`, `/client_data/`) and `public/consent.js`
  (`/consent.js`). All edited files are now on the served paths -> **deploying takes effect.**
- **Obfuscation:** `npm run obfuscate` (`scripts/obfuscate-loader.mjs`) minifies the `loader`
  / `loaderIab` template literals inside `cdn.js`. It is **not** wired into `wrangler deploy`
  (no `[build]` command). Confirm the team's release order — typically: edit readable source ->
  `npm run obfuscate:dry` to sanity-check -> `npm run obfuscate` -> `wrangler deploy`.
- Cache: visitors must get the new asset past any CDN cache.

---

## Implement later (deferred)

1. **public/consent.js logo detection.** It infers "logo enabled" from the presence of the
   `cb-floating-trigger` DOM element. If that element is always present in the embed HTML (or
   created async), the OFF->24h branch may not trigger reliably. Confirm how `/consent.js` sites
   render the logo and, if needed, read the actual setting instead of probing the element.
2. **Stale flag after a setting change.** If a visitor closed while the logo was ON
   (`_closed` set), then the owner turns the logo OFF, the cdn.js `Cc()` 24h fallback covers it;
   verify the `/consent.js` path matches intent.
3. **Immediate logo after Accept/Reject/Save (same page).** Not required by this task; the logo
   already appears on the next load via the `A.accepted` path.
4. **Verify against live reference** (team rule): diff vs `Currently live - Copy/ConsentBit/`
   before deploy.
