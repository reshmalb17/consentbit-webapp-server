/**
 * URL patterns (RegExp source, case-insensitive) → GDPR-style categories.
 * Used by the embed to decide which third-party scripts to block before consent.
 *
 * - `categories`: script is blocked unless the user has consented to **every** listed category
 *   (same idea as CookieYes: any non-consented category → block).
 * - Extend this list over time; customers tag scripts with
 *   data-consentbit="analytics|marketing|preferences|behavioral|essential"
 *   or labels like cookieyes-analytics on data-consentbit (see docs/SCRIPT_BLOCKING.md).
 *   Legacy: data-consentbit-category, data-cookieyes.
 *
 * Keep patterns reasonably broad (host + path hints) to reduce false negatives;
 * tune if you see false positives.
 */
export const SCRIPT_BLOCK_PROVIDERS = [
  // Google Analytics / Tag Manager — analytics only (matches cookieless GA exception in embed)
  {
    pattern:
      'google-analytics\\.com|googletagmanager\\.com/gtag/js|googletagmanager\\.com/gtm\\.js|region1\\.google-analytics\\.com',
    categories: ['analytics'],
  },
  // Google Ads / Display
  {
    pattern:
      'googleadservices\\.com|googlesyndication\\.com|pagead/|google\\.com/pagead/|doubleclick\\.net|googleads\\.g\\.doubleclick\\.net',
    categories: ['marketing'],
  },
  // Facebook / Meta
  {
    pattern: 'connect\\.facebook\\.net|facebook\\.com/tr|pixel\\.facebook\\.com|fbevents\\.js',
    categories: ['marketing'],
  },
  // Microsoft / LinkedIn ads
  {
    pattern: 'bing\\.com|bat\\.bing\\.com|linkedin\\.com/px|snap\\.licdn\\.com',
    categories: ['marketing'],
  },
  // TikTok
  { pattern: 'analytics\\.tiktok\\.com|tiktok\\.com/i18n/pixel', categories: ['marketing'] },
  // Twitter / X
  { pattern: 'platform\\.twitter\\.com|twimg\\.com|t\\.co/1/i/adsct', categories: ['marketing'] },
  // Pinterest
  { pattern: 'pintrk\\.js|ct\\.pinterest\\.com', categories: ['marketing'] },
  // Snapchat
  { pattern: 'sc-static\\.net/scevent|tr\\.snapchat\\.com', categories: ['marketing'] },
  // Reddit
  { pattern: 'redditstatic\\.com/ads|reddit\\.com/api/v1/pixel', categories: ['marketing'] },
  // Amazon / Criteo / Taboola / Outbrain
  {
    pattern:
      'amazon-adsystem\\.com|media\\.amazon\\.com|dsp\\.amazon|criteo\\.com|taboola\\.com|outbrain\\.com|widgets\\.outbrain\\.com',
    categories: ['marketing'],
  },
  // Hotjar / Clarity / FullStory / Heap / Mixpanel / Amplitude / Segment / PostHog
  {
    pattern:
      'hotjar\\.com|clarity\\.ms|fullstory\\.com|heap-analytics\\.com|cdn\\.heap|mixpanel\\.com|amplitude\\.com|segment\\.com|segment\\.io|cdn\\.segment|posthog\\.com|app\\.posthog',
    categories: ['analytics', 'behavioral'],
  },
  // Intercom / Drift / Zendesk chat widgets (often marketing + preferences)
  {
    pattern: 'intercom\\.io|intercomcdn\\.com|drift\\.com|js\\.driftt\\.com|zendesk\\.com/embeddable|zdassets\\.com',
    categories: ['marketing', 'preferences'],
  },
  // HubSpot / Marketo / Pardot / Mailchimp / Klaviyo
  {
    pattern:
      'hubspot\\.com|hs-scripts\\.com|hsforms\\.com|marketo\\.com|mktoresp\\.com|pardot\\.com|go\\.pardot|list-manage\\.com|klaviyo\\.com|static\\.klaviyo',
    categories: ['marketing'],
  },
  // Vimeo / Wistia player analytics (often marketing)
  { pattern: 'player\\.vimeo\\.com|vimeo\\.com/api/player|wistia\\.com|fast\\.wistia', categories: ['marketing'] },
  // Spotify / SoundCloud embeds (often marketing)
  { pattern: 'spotify\\.com/embed|soundcloud\\.com/player', categories: ['marketing'] },
  // Yahoo / Verizon Media
  { pattern: 'yahoo\\.com|yimg\\.com|advertising\\.com|gemini\\.yahoo\\.com', categories: ['marketing'] },
  // Yandex / VK
  { pattern: 'yandex\\.ru/metrika|mc\\.yandex|vk\\.com/js|top-fwz1\\.mail\\.ru', categories: ['analytics', 'marketing'] },
  // Adobe Analytics / Target
  { pattern: 'omniture\\.com|adobedtm\\.com|demdex\\.net|tt.omtrdc\\.net|mbox\\.js', categories: ['analytics', 'marketing'] },
  // Quantcast / LiveRamp / Trade Desk
  {
    pattern: 'quantcast\\.com|quantserve\\.com|liveramp\\.com|rlcdn\\.com|thetradedesk\\.com|adsrvr\\.org',
    categories: ['marketing'],
  },
  // Braze / Iterable / Braze-like engagement
  { pattern: 'braze\\.com|sdk\\.braze|iterable\\.com|api\\.iterable', categories: ['marketing'] },
  // New Relic / Datadog RUM (often analytics/ops)
  { pattern: 'newrelic\\.com|nr-data\\.net|datadoghq-browser-agent|datadoghq\\.com', categories: ['analytics'] },
  // Sentry (error tracking — often treated as analytics)
  { pattern: 'sentry\\.io|browser.sentry-cdn', categories: ['analytics'] },
  // Matomo / Plausible / Fathom (privacy-friendly but still analytics scripts)
  { pattern: 'matomo\\.php|plausible\\.io|usefathom\\.com|cdn\\.usefathom', categories: ['analytics'] },
  // Cloudflare Web Analytics / Beacon
  { pattern: 'static\\.cloudflareinsights\\.com|cloudflareinsights\\.com', categories: ['analytics'] },
  // Mouseflow / Lucky Orange / Crazy Egg / Inspectlet
  {
    pattern:
      'mouseflow\\.com|cdn\\.mouseflow|luckyorange\\.com|cdn\\.luckyorange|crazyegg\\.com|cdn\\.crazyegg|inspectlet\\.com|cdn\\.inspectlet',
    categories: ['analytics', 'behavioral'],
  },
  // Chartbeat / Parse.ly / Piano / Tealium / Ensighten
  {
    pattern:
      'chartbeat\\.com|static\\.chartbeat|parsely\\.com|cdn\\.parsely|piano\\.io|tealiumiq\\.com|tags\\.tiqcdn|ensighten\\.com',
    categories: ['analytics', 'marketing'],
  },
  // Shopify analytics / customer events (third-party marketing)
  { pattern: 'shopify\\.com/s/javascripts|monorail-edge\\.shopifysvc\\.com', categories: ['marketing', 'analytics'] },
  // Calendly / Typeform / Tally (often preferences + marketing)
  { pattern: 'calendly\\.com/assets|assets\\.calendly|typeform\\.com|tally\\.so', categories: ['preferences', 'marketing'] },
  // Google Maps JS API (heavy tracking surface — block until preferences if embedded as script)
  { pattern: 'maps\\.googleapis\\.com/maps/api/js', categories: ['preferences'] },
  // reCAPTCHA / hCaptcha (often essential for forms; tag manually if you need always-on)
  // { pattern: 'google\\.com/recaptcha|hcaptcha\\.com', categories: ['preferences'] },
];
