// src/data/vendorPrivacyLinks.js
//
// Privacy-policy links for common cookie vendors, shown next to the vendor name in
// the banner's cookie list (utils/bannerCookieList.js). The Cookie table stores a
// free-text `provider` only, so we match on it here. First match wins: put the more
// specific names before the general ones (e.g. "Google Ads" before "Google").

export const VENDOR_PRIVACY_LINKS = [
  { match: /youtube/i, name: 'YouTube', url: 'https://policies.google.com/privacy' },
  { match: /google|doubleclick|gtag|gtm/i, name: 'Google', url: 'https://policies.google.com/privacy' },
  { match: /cloudflare/i, name: 'Cloudflare', url: 'https://www.cloudflare.com/privacypolicy/' },
  { match: /posthog/i, name: 'PostHog', url: 'https://posthog.com/privacy' },
  { match: /facebook|meta|instagram/i, name: 'Meta', url: 'https://www.facebook.com/privacy/policy/' },
  { match: /hotjar/i, name: 'Hotjar', url: 'https://www.hotjar.com/legal/policies/privacy/' },
  { match: /hubspot/i, name: 'HubSpot', url: 'https://legal.hubspot.com/privacy-policy' },
  { match: /tiktok/i, name: 'TikTok', url: 'https://www.tiktok.com/legal/page/global/privacy-policy/en' },
  { match: /twitter|\bx\.com/i, name: 'X (Twitter)', url: 'https://x.com/en/privacy' },
  { match: /pinterest/i, name: 'Pinterest', url: 'https://policy.pinterest.com/en/privacy-policy' },
  { match: /stripe/i, name: 'Stripe', url: 'https://stripe.com/privacy' },
  { match: /intercom/i, name: 'Intercom', url: 'https://www.intercom.com/legal/privacy' },
  { match: /mixpanel/i, name: 'Mixpanel', url: 'https://mixpanel.com/legal/privacy-policy/' },
  { match: /amplitude/i, name: 'Amplitude', url: 'https://amplitude.com/privacy' },
  { match: /segment/i, name: 'Segment', url: 'https://segment.com/legal/privacy/' },
  { match: /shopify/i, name: 'Shopify', url: 'https://www.shopify.com/legal/privacy' },
  { match: /webflow/i, name: 'Webflow', url: 'https://webflow.com/legal/privacy' },
  { match: /framer/i, name: 'Framer', url: 'https://www.framer.com/legal/privacy-policy/' },
  { match: /wix/i, name: 'Wix', url: 'https://www.wix.com/about/privacy' },
  { match: /vimeo/i, name: 'Vimeo', url: 'https://vimeo.com/privacy' },
  { match: /calendly/i, name: 'Calendly', url: 'https://calendly.com/legal/privacy-notice' },
  { match: /zendesk/i, name: 'Zendesk', url: 'https://www.zendesk.com/company/agreements-and-terms/privacy-notice/' },
  { match: /mailchimp/i, name: 'Mailchimp', url: 'https://www.intuit.com/privacy/statement/' },
  { match: /klaviyo/i, name: 'Klaviyo', url: 'https://www.klaviyo.com/legal/privacy' },
  { match: /reddit/i, name: 'Reddit', url: 'https://www.reddit.com/policies/privacy-policy' },
  { match: /snap/i, name: 'Snap', url: 'https://values.snap.com/privacy/privacy-policy' },
  { match: /consentbit/i, name: 'ConsentBit', url: 'https://www.consentbit.com/privacy-policy' },
];

// The Microsoft family shares one policy, LinkedIn has its own.
const MICROSOFT = { name: 'Microsoft', url: 'https://privacy.microsoft.com/privacystatement' };
const LINKEDIN = { name: 'LinkedIn', url: 'https://www.linkedin.com/legal/privacy-policy' };

/** { name, url } for a provider string, or null when we don't know the vendor. */
export function vendorPrivacyLink(provider) {
  const p = String(provider || '');
  if (!p) return null;
  if (/linkedin/i.test(p)) return LINKEDIN;
  if (/clarity|bing|microsoft/i.test(p)) return MICROSOFT;
  for (const v of VENDOR_PRIVACY_LINKS) {
    if (v.match.test(p)) return { name: v.name, url: v.url };
  }
  return null;
}
