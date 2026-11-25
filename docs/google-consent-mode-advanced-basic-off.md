# Google Consent Mode: Advanced, Basic or Off

<!-- Draft for https://www.consentbit.com/articles/google-consent-mode-advanced-basic-off
     (linked from the dashboard's Google Consent Mode card). Google CMP Partner audit iii.5. -->

ConsentBit sends your visitors' consent choices to Google through Google Consent Mode v2. You can choose how it does this: Advanced (the default), Basic, or Off.

## Where to change it

1. In the ConsentBit dashboard, open your site and go to **Cookie Banner → General**.
2. In the **Google Consent Mode (GCM)** card, set the two switches:
   - **Support Google Consent Mode**
   - **Allow Google tags to fire before consent** (shown when the first switch is on)
3. Click **Publish**. The change is live on your site straight away.

| Support Google Consent Mode | Allow Google tags to fire before consent | Mode |
|---|---|---|
| On | On | **Advanced** (default) |
| On | Off | **Basic** |
| Off | (hidden) | **Off** |

## Advanced (default)

- Your Google tags (Google Analytics, Google Ads, Google Tag Manager) load as soon as the page opens.
- Before the visitor chooses, ConsentBit tells Google that consent is denied. Google tags then send cookieless pings and set no cookies.
- When the visitor chooses, ConsentBit sends their choice to Google, and the tags adjust.

Advanced gives Google the most data for conversion modelling. Google recommends it.

## Basic

- Your Google tags are blocked, and nothing is sent to Google, until the visitor accepts **Analytics** or **Marketing**.
- When they do, ConsentBit starts Consent Mode with their choices (for example, analytics granted and advertising denied), and then your Google tags load.
- If the visitor rejects, your Google tags never load and nothing is sent to Google.
- If a visitor accepts and later withdraws consent, ConsentBit tells Google straight away.
- Returning visitors who accepted before get their Google tags on page load, with their saved choices.
- Visitors who see the opt-out banner (CCPA / US state laws) have nothing to accept first, so their Google tags load and Consent Mode works as in Advanced mode.

## Off

- ConsentBit sends no Consent Mode commands to Google at all.
- Your Google tags are blocked like any other tracker until the visitor accepts their category:
  - Google Analytics: **Analytics**
  - Google Ads and Floodlight: **Marketing**
  - Google Tag Manager: **Analytics and Marketing** (the tags inside the container can't see a consent signal, so the container only loads when both are accepted)
- If a visitor withdraws consent, Google tags that already loaded stay until the next page; on the next page they're blocked again.
- With Consent Mode off, Google gets no consent information for your visitors. For visitors in the EEA and UK this can limit Google Ads features such as conversion modelling and remarketing. Check Google's requirements for your account before choosing Off.

## Things to check

- **Script order (Basic and Off).** The ConsentBit script must be in your page's `<head>` above your Google tag. A Google tag placed above ConsentBit runs before ConsentBit can block it.
- **Google Tag Manager template.** Our Google Tag Manager template always sets Consent Mode defaults inside GTM, so these switches don't apply to a template install. To use Basic or Off, add the ConsentBit script to your site's `<head>` directly instead of loading it through the template.
- **IAB TCF.** With IAB TCF enabled, Google reads consent from the TCF string, so these switches don't apply.
- **Check now and debug mode** look for a Consent Mode default before your Google tags. In Basic and Off mode they report it as missing. That's expected.

## How to check it's working

Open your site in a private window with [Google Tag Assistant](https://tagassistant.google.com/) connected, or type `dataLayer` in the browser console:

- **Advanced:** a `consent default` with everything denied appears first. Your Google tag loads immediately.
- **Basic:** before you choose, there's no `consent` entry and the Google tag hasn't loaded. After you accept, a `consent default` with your choices appears first, then the tag loads.
- **Off:** there's never a `consent` entry. The Google tag loads only after you accept its category.
