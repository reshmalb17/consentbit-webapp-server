# ConsentBit — Google Tag Manager Custom Template

A GTM tag template that loads the ConsentBit consent banner and publishes Google
Consent Mode v2 defaults before any measurement tag in the container fires.

The only required input is the **Script ID** — the `cdnScriptId` UUID from the
site's install snippet. Everything else (regulation, geo resolution, styling,
translations, script-blocking rules) is resolved server-side from that ID by
[`src/handlers/cdnNm.js`](../src/handlers/cdnNm.js), exactly as it is for the
hand-pasted `<script>` install.

---

## What the template does

| Step | Why it has to happen in GTM rather than in the banner |
| --- | --- |
| `setDefaultConsentState(…)` | Runs on the **Consent Initialization** trigger, which GTM guarantees fires before every other tag. The banner's own default (`cdnNm.js:3130`) can only run once the script has downloaded, which is too late for tags already queued. |
| `gtagSet('ads_data_redaction' / 'url_passthrough')` | Same ordering requirement. |
| `setInWindow('__cbConsentDefaultSet', true)` | Suppresses the banner's duplicate default push. The banner already checks this flag. |
| `injectScript(…/consentbit/{id}/script.js)` | Loads the banner. |

Consent **updates** are *not* handled by the template. The banner pushes them
itself when the visitor chooses:

- `gtag('consent','update', …)` — [`cdnNm.js:2117`](../src/handlers/cdnNm.js#L2117)
- a named `consentbit_consent_update` dataLayer event — [`cdnNm.js:1469`](../src/handlers/cdnNm.js#L1469)

Both go through `window.dataLayer`, so GTM picks them up with no template
involvement.

## Container setup (what the customer does)

1. **Tag** → new tag → *ConsentBit CMP* → paste the Script ID.
2. **Trigger** → `Consent Initialization - All Pages`. Nothing else.
3. For tags that should fire on a *change* of consent, add a **Custom Event**
   trigger on `consentbit_consent_update` and Data Layer Variables for
   `consentbit_analytics`, `consentbit_marketing`, `consentbit_preferences`,
   `consentbit_regulation`, `consentbit_source`.

## Two things to verify before submitting

**1. The domain guard must not reject GTM-injected loads.**
`cdnNm.js` blocks the request when `Origin`/`Referer` does not match the site's
registered domain (`cdnNm.js:56–104`). A GTM `injectScript` produces a normal
`<script src>` from the page, so the browser sends `Referer: https://<the page>`
and the check passes. Confirm this on a real container before publishing —
notably that a site registered as `example.com` still loads when GTM is
previewed from `tagassistant.google.com` (the page origin is still the customer
site there, so it should be fine, but test it).

**2. A renamed dataLayer breaks consent updates.**
The banner pushes to `window.dataLayer` literally. A container installed with a
custom dataLayer name will receive the template's defaults (GTM handles those)
but **not** the banner's updates. Either document this as unsupported, or read
the container's dataLayer name in the template and pass it to the banner as a
query parameter that `cdnNm.js` bakes into the loader.

## Publishing to the Community Template Gallery

The gallery requires a **dedicated public GitHub repo** with these files at the
repository root — this subfolder will not work as-is:

```
template.tpl        ← from this folder
metadata.yaml       ← from this folder, with a real commit SHA
LICENSE             ← Apache 2.0
README.md
```

Steps:

1. Create a public repo, e.g. `consentbit/gtm-consentbit-cmp`.
2. Copy the four files to its root and push.
3. Fill `metadata.yaml` `sha:` with the full 40-char SHA of that commit.
4. In GTM: **Templates → New → ⋮ → Import** the `.tpl`, run the built-in tests,
   then **⋮ → Export** and commit any diff GTM introduces (it normalises
   formatting and rewrites the `id` field).
5. GTM → Templates → your template → **Submit to Gallery**, and authorise the
   GitHub account. Google requires the account to have a verified email and the
   repo to be public.
6. Review typically takes a few business days.

### Before step 5

- Replace `"id": "cvt_temp_public_id"` in `___INFO___` — GTM assigns the real
  public ID during the export in step 4.
- Add a brand thumbnail: `"brand": { "thumbnail": "data:image/png;base64,…" }`,
  square, ideally 128×128.
- Confirm `"categories"` against Google's current allowed enum. `UTILITY` and
  `PERSONALIZATION` are valid; an unrecognised value fails validation on import.
- If ConsentBit is (or becomes) a Google-certified CMP, that certification is a
  separate Google Ads programme and is applied for outside the gallery flow.

## Local testing

Import `template.tpl` in GTM's template editor and press **Run Tests** — the
`___TESTS___` block covers URL construction, the consent defaults, region
overrides, and the empty-Script-ID path.
