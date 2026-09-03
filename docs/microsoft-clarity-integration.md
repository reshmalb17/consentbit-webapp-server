# Microsoft Clarity Consent Mode with ConsentBit

> **Note for whoever publishes this page**
>
> - Publish at a permanent URL — this link is submitted to Microsoft and will appear on
>   their [supported CMPs page](https://learn.microsoft.com/en-us/clarity/setup-and-installation/cookie-cmps)
>   indefinitely. A later reorganisation that breaks it looks worse than not being listed.
>   Suggested path: `https://consentbit.com/docs/microsoft-clarity`
> - The wording below says ConsentBit *supports* Clarity Consent Mode. Once Microsoft
>   completes validation and adds us to their partner list, this can be upgraded to
>   "certified Microsoft Clarity CMP".
> - Delete this note block before publishing.

---

ConsentBit supports Microsoft Clarity Consent Mode (CMP ID 165). It automatically passes each visitor's consent decision to Clarity using Clarity's Consent API v2, so Clarity only stores cookies when your visitor has allowed it.

No configuration is required in ConsentBit. Once Clarity is installed on your site and Consent Mode is enabled in your Clarity project, ConsentBit handles the rest.

## How it works

Clarity has two consent permissions, and ConsentBit sets them independently based on what your visitor chooses:

| Clarity permission | ConsentBit category | Controls |
| --- | --- | --- |
| `analytics_Storage` | Analytics | `_clck`, `_clsk` — Clarity's own first-party cookies |
| `ad_Storage` | Marketing | `MUID` — Microsoft's cross-site advertising identifier |

Granular choices are respected. If a visitor allows Analytics but not Marketing, ConsentBit grants `analytics_Storage` and denies `ad_Storage`. The two are never granted together unless the visitor allowed both.

Under CCPA and similar US state regulations, ConsentBit follows the opt-out model: both permissions are granted until the visitor selects **Do Not Sell or Share My Personal Information**, at which point both are denied.

## What happens with and without consent

The Clarity tag always loads, as Microsoft requires. What changes is what Clarity is allowed to store:

- **Consent granted** — Clarity sets its cookies and recognises returning visitors across sessions.
- **Consent denied** — Clarity runs in cookieless mode. No `_clck`, `_clsk` or `MUID` cookies are written, and each page view is treated independently.
- **Consent withdrawn** — Clarity deletes any cookies it previously set and returns to cookieless mode.

ConsentBit does not block the Clarity script. Blocking it would prevent Clarity from receiving any consent signal at all, which is why Microsoft's integration guide asks for the tag to load regardless of consent status.

## Before you begin

You need a Clarity project with **Consent Mode enabled**. This is the step most commonly missed — without it, Clarity sets cookies by default and will appear to ignore your banner.

1. Sign in to [clarity.microsoft.com](https://clarity.microsoft.com) and open your project.
2. Go to **Settings → Setup**.
3. Turn the cookie setting **OFF**, so Clarity does not set cookies until consent is received.

Consent Mode is enabled by default for visitors from the European Economic Area, the United Kingdom and Switzerland.

## Setting up the integration

### 1. Install ConsentBit

Install ConsentBit on your site and publish your cookie banner.

### 2. Add your Clarity tracking code

Add the Clarity tracking code to your site, exactly as Clarity provides it:

```html
<script type="text/javascript">
    (function(c,l,a,r,i,t,y){
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", "YOUR_PROJECT_ID");
</script>
```

Replace `YOUR_PROJECT_ID` with the project ID from your Clarity dashboard.

**Do not** add a blocking attribute such as `data-category` to this script, and do not add Clarity to any manual blocking rules. Clarity is controlled by the consent signal, not by blocking.

### 3. That's it

ConsentBit detects Clarity and begins sending consent signals automatically — on first visit, when a returning visitor's stored choice is applied, and whenever the visitor updates their preferences.

## Verifying the integration

Open your site and press **F12** to open your browser console.

### Check the consent signal

Run:

```js
window.__cbClaritySignal
```

This shows the most recent values ConsentBit sent to Clarity, in the form `ad_Storage|analytics_Storage`:

| Visitor action | Expected value |
| --- | --- |
| Banner shown, no choice made | `denied\|denied` |
| Accept All | `granted\|granted` |
| Reject All | `denied\|denied` |
| Analytics only | `denied\|granted` |
| Marketing only | `granted\|denied` |

### Check the cookies

Open **Application → Cookies** in your browser's developer tools.

- With Analytics denied, `_clck` and `_clsk` must not be present.
- With Analytics granted, `_clck` appears after you accept and reload the page.
- With Marketing denied, `MUID` must not be present.

Granting consent takes effect on the next page load, because Clarity starts a new session. Withdrawing consent takes effect immediately and removes existing cookies.

## Troubleshooting

**Clarity cookies appear even when consent is denied.**
Consent Mode is not enabled in your Clarity project. Go to **Settings → Setup** and turn the cookie setting off.

**`_clck` does not appear after accepting.**
Reload the page and interact with it for a few seconds. Clarity writes its cookies when it next uploads data, not the instant consent is granted.

**`window.__cbClaritySignal` is undefined.**
ConsentBit has not loaded on that page. Check that your ConsentBit script is installed and that you are testing on your registered domain.

**No Clarity data is recorded at all.**
Confirm the Clarity tag is present and not blocked by a browser extension or content security policy. In the Network tab, filter for `clarity` — you should see requests to `clarity.ms` even when consent is denied.

## Related links

- [Clarity Consent Mode](https://learn.microsoft.com/en-us/clarity/setup-and-installation/consent-mode)
- [Clarity Consent API v2](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2)
- [CMPs supported by Clarity](https://learn.microsoft.com/en-us/clarity/setup-and-installation/cookie-cmps)
