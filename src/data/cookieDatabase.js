// src/data/cookieDatabase.js
// Comprehensive cookie database - maps services/scripts to their expected cookies

export const COOKIE_DATABASE = {
  'google-analytics': {
    cookies: [
      { name: '_ga', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - stores a unique client identifier. Used to distinguish users.' },
      { name: '_gid', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - stores a unique user identifier. Used to distinguish users.' },
      { name: '_gat', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - used to throttle request rate.' },
      { name: '_gac', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - contains campaign-related information for the user.' },
      { name: '_gcl_au', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - used by Google AdSense for experimenting with advertisement efficiency.' },
      { name: '_gcl_dc', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - used by Google AdSense for experimenting with advertisement efficiency.' },
      { name: '_gcl_gb', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - used by Google AdSense for experimenting with advertisement efficiency.' },
      { name: '_gcl_aw', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - used by Google AdSense for experimenting with advertisement efficiency.' },
      { name: '_gtag', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - used to store user preferences.' },
      { name: '_gtm', category: 'analytics', provider: 'Google Analytics', description: 'Google Tag Manager cookie - used to manage tags and scripts.' },
      { name: '_utm', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics UTM cookie - used to track campaign parameters.' },
      { name: '_utma', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - stores the number of times a user has been to the site.' },
      { name: '_utmb', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - stores information about the current session.' },
      { name: '_utmc', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - stores information about the current session.' },
      { name: '_utmt', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - used to throttle request rate.' },
      { name: '_utmz', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - stores the traffic source or campaign that explains how the user reached the site.' },
      { name: '_utmv', category: 'analytics', provider: 'Google Analytics', description: 'Google Analytics cookie - stores visitor-level custom variable data.' },
    ],
    // GA4 specific pattern: _ga_XXXXXXXXXX where X is measurement ID
    pattern: /^_ga_[A-Z0-9]+$/i,
  },
  'google-tag-manager': {
    cookies: [
      { name: '_gtm', category: 'analytics', provider: 'Google Tag Manager', description: 'Google Tag Manager cookie - used to manage tags and scripts.' },
      { name: '_gtag', category: 'analytics', provider: 'Google Tag Manager', description: 'Google Tag Manager cookie - used to store user preferences.' },
    ],
  },
  'facebook': {
    cookies: [
      { name: '_fbp', category: 'marketing', provider: 'Facebook', description: 'Facebook Pixel cookie - used to track visitors across websites. Stores a unique ID to identify the user.' },
      { name: '_fbc', category: 'marketing', provider: 'Facebook', description: 'Facebook Pixel cookie - stores browser and campaign information. Used to track conversions.' },
      { name: 'fr', category: 'marketing', provider: 'Facebook', description: 'Facebook cookie - used to deliver, measure and improve the relevancy of ads.' },
      { name: 'datr', category: 'marketing', provider: 'Facebook', description: 'Facebook cookie - used to identify the web browser being used to connect to Facebook.' },
      { name: 'sb', category: 'marketing', provider: 'Facebook', description: 'Facebook cookie - used to store browser and session information.' },
      { name: 'c_user', category: 'marketing', provider: 'Facebook', description: 'Facebook cookie - contains the user ID of the currently logged in user.' },
      { name: 'xs', category: 'marketing', provider: 'Facebook', description: 'Facebook cookie - contains multiple pieces of information, used for authentication.' },
    ],
  },
  'hotjar': {
    cookies: [
      { name: '_hjid', category: 'behavioral', provider: 'Hotjar', description: 'Hotjar cookie - stores a unique user identifier. Used to persist the Hotjar User ID.' },
      { name: '_hjIncludedInPageviewSample', category: 'behavioral', provider: 'Hotjar', description: 'Hotjar cookie - determines if the user is included in the pageview sample.' },
      { name: '_hjIncludedInSessionSample', category: 'behavioral', provider: 'Hotjar', description: 'Hotjar cookie - determines if the user is included in the session sample.' },
      { name: '_hjAbsoluteSessionInProgress', category: 'behavioral', provider: 'Hotjar', description: 'Hotjar cookie - used to detect the first pageview session of a user.' },
      { name: '_hjFirstSeen', category: 'behavioral', provider: 'Hotjar', description: 'Hotjar cookie - identifies a new user\'s first session.' },
      { name: '_hjViewportId', category: 'behavioral', provider: 'Hotjar', description: 'Hotjar cookie - stores information about the user\'s viewport.' },
      { name: '_hjRecordingLastActivity', category: 'behavioral', provider: 'Hotjar', description: 'Hotjar cookie - stores the last activity timestamp.' },
    ],
  },
  'linkedin': {
    cookies: [
      { name: 'li_fat_id', category: 'marketing', provider: 'LinkedIn', description: 'LinkedIn Insight Tag cookie - stores browser identifier for tracking.' },
      { name: 'li_oat', category: 'marketing', provider: 'LinkedIn', description: 'LinkedIn cookie - used for tracking and analytics.' },
      { name: 'li_sugr', category: 'marketing', provider: 'LinkedIn', description: 'LinkedIn cookie - used for tracking and analytics.' },
      { name: 'AnalyticsSyncHistory', category: 'marketing', provider: 'LinkedIn', description: 'LinkedIn cookie - used to store information about the time a sync took place.' },
      { name: 'UserMatchHistory', category: 'marketing', provider: 'LinkedIn', description: 'LinkedIn cookie - used to track visitors on multiple websites.' },
      { name: 'bcookie', category: 'marketing', provider: 'LinkedIn', description: 'LinkedIn cookie - browser identifier cookie to uniquely identify devices.' },
      { name: 'bscookie', category: 'marketing', provider: 'LinkedIn', description: 'LinkedIn cookie - secure browser identifier cookie.' },
    ],
  },
  'twitter': {
    cookies: [
      { name: '_twitter_sess', category: 'marketing', provider: 'Twitter', description: 'Twitter Pixel cookie - stores session information for tracking.' },
      { name: 'personalization_id', category: 'marketing', provider: 'Twitter', description: 'Twitter cookie - used for personalization and ad targeting.' },
      { name: 'guest_id', category: 'marketing', provider: 'Twitter', description: 'Twitter cookie - stores a unique ID to identify the user.' },
      { name: 'muc_ads', category: 'marketing', provider: 'Twitter', description: 'Twitter cookie - used for ad targeting and measurement.' },
    ],
  },
  'pinterest': {
    cookies: [
      { name: '_pin', category: 'marketing', provider: 'Pinterest', description: 'Pinterest cookie - used for tracking and analytics.' },
      { name: '_pinterest_sess', category: 'marketing', provider: 'Pinterest', description: 'Pinterest cookie - stores session information.' },
      { name: '_pinid', category: 'marketing', provider: 'Pinterest', description: 'Pinterest cookie - stores a unique user identifier.' },
    ],
  },
};

/**
 * Get cookie provider based on cookie name and domain
 */
export function getCookieProvider(cookieName, cookieDomain) {
  const name = cookieName.toLowerCase();
  const domain = (cookieDomain || '').toLowerCase();

  // Check against cookie database first
  for (const [service, data] of Object.entries(COOKIE_DATABASE)) {
    for (const cookie of data.cookies) {
      if (name === cookie.name.toLowerCase() || name.startsWith(cookie.name.toLowerCase() + '_')) {
        return cookie.provider;
      }
    }
    // Check GA4 pattern
    if (service === 'google-analytics' && data.pattern && data.pattern.test(cookieName)) {
      return 'Google Analytics';
    }
  }

  // Fallback pattern matching
  if (name.includes('_ga') || name.includes('_gid') || name.includes('_gat') || name.includes('_gac') || name.includes('_gtag') || name.includes('_gtm') || name.includes('_utm') || domain.includes('google')) {
    return 'Google Analytics';
  }
  if (name.includes('_fb') || name.includes('fr') || name.includes('datr') || name.includes('sb') || domain.includes('facebook')) {
    return 'Facebook';
  }
  if (name.includes('_pin') || name.includes('_pinterest') || domain.includes('pinterest')) {
    return 'Pinterest';
  }
  if (name.includes('_tw') || name.includes('_twitter') || name.includes('personalization_id') || name.includes('guest_id') || domain.includes('twitter')) {
    return 'Twitter';
  }
  if (name.includes('_li') || name.includes('li_') || name.includes('bcookie') || name.includes('bscookie') || domain.includes('linkedin')) {
    return 'LinkedIn';
  }
  if (name.includes('_hj') || name.includes('hotjar') || domain.includes('hotjar')) {
    return 'Hotjar';
  }
  if (name.includes('consentbit') || name.includes('cookieyes')) {
    return 'ConsentBit';
  }

  return null;
}

/**
 * Categorize cookie based on name, domain, and provider
 */
export function categorizeCookie(cookieName, cookieDomain, provider) {
  const name = cookieName.toLowerCase();
  const domain = (cookieDomain || '').toLowerCase();

  // Check against cookie database first for exact matches
  for (const [service, data] of Object.entries(COOKIE_DATABASE)) {
    for (const cookie of data.cookies) {
      if (name === cookie.name.toLowerCase() || name.startsWith(cookie.name.toLowerCase() + '_')) {
        return cookie.category;
      }
    }
    // Check GA4 pattern (_ga_XXXXXXXXXX)
    if (service === 'google-analytics' && data.pattern && data.pattern.test(cookieName)) {
      return 'analytics';
    }
  }

  // Necessary cookies
  if (
    name.includes('consentbit') ||
    name.includes('cookieyes') ||
    name.includes('cookie-consent') ||
    name.includes('gdpr-consent') ||
    name.includes('ccpa-consent')
  ) {
    return 'necessary';
  }

  // Analytics cookies (comprehensive patterns)
  if (
    name.includes('_ga') ||
    name.includes('_gid') ||
    name.includes('_gat') ||
    name.includes('_gac') ||
    name.includes('_gcl_') ||
    name.includes('_gtm') ||
    name.includes('_gtag') ||
    name.includes('_utm') ||
    name.includes('analytics') ||
    domain.includes('google-analytics') ||
    domain.includes('googletagmanager') ||
    provider?.toLowerCase().includes('google analytics') ||
    provider?.toLowerCase().includes('google tag manager')
  ) {
    return 'analytics';
  }

  // Marketing cookies (comprehensive patterns)
  if (
    name.includes('_fbp') ||
    name.includes('_fbc') ||
    name.includes('fr') ||
    name.includes('datr') ||
    name.includes('sb') ||
    name.includes('c_user') ||
    name.includes('xs') ||
    name.includes('_pin') ||
    name.includes('_pinterest') ||
    name.includes('_twitter') ||
    name.includes('personalization_id') ||
    name.includes('guest_id') ||
    name.includes('_linkedin') ||
    name.includes('li_') ||
    name.includes('bcookie') ||
    name.includes('bscookie') ||
    name.includes('ads') ||
    name.includes('advertising') ||
    domain.includes('facebook') ||
    domain.includes('doubleclick') ||
    domain.includes('googleadservices') ||
    provider?.toLowerCase().includes('facebook') ||
    provider?.toLowerCase().includes('marketing') ||
    provider?.toLowerCase().includes('linkedin') ||
    provider?.toLowerCase().includes('twitter') ||
    provider?.toLowerCase().includes('pinterest')
  ) {
    return 'marketing';
  }

  // Behavioral cookies
  if (
    name.includes('_hj') ||
    name.includes('hotjar') ||
    name.includes('intercom') ||
    name.includes('fullstory') ||
    name.includes('mixpanel') ||
    name.includes('amplitude') ||
    domain.includes('hotjar') ||
    domain.includes('intercom') ||
    domain.includes('fullstory')
  ) {
    return 'behavioral';
  }

  // Functional cookies
  if (
    name.includes('preferences') ||
    name.includes('settings') ||
    name.includes('language') ||
    name.includes('theme') ||
    name.includes('user')
  ) {
    return 'functional';
  }

  return 'uncategorized';
}

/**
 * Get cookies that would be set based on consent state
 */
export function getCookiesByConsentState(expectedCookies, consentState) {
  const { analytics = false, marketing = false, behavioral = false, functional = false } = consentState || {};
  
  const cookiesByState = {
    necessary: [],
    ifAccepted: [], // If user accepts all
    ifRejected: [], // If user rejects all
    ifPreferences: [], // If user sets preferences
  };

  for (const cookie of expectedCookies) {
    // Necessary cookies are always set
    if (cookie.category === 'necessary') {
      cookiesByState.necessary.push(cookie);
      continue;
    }

    // If user accepts all
    cookiesByState.ifAccepted.push(cookie);

    // If user rejects all - only necessary cookies
    // (already handled above)

    // If user sets preferences
    if (cookie.category === 'analytics' && analytics) {
      cookiesByState.ifPreferences.push(cookie);
    } else if (cookie.category === 'marketing' && marketing) {
      cookiesByState.ifPreferences.push(cookie);
    } else if (cookie.category === 'behavioral' && behavioral) {
      cookiesByState.ifPreferences.push(cookie);
    } else if (cookie.category === 'functional' && functional) {
      cookiesByState.ifPreferences.push(cookie);
    }
  }

  return cookiesByState;
}

/**
 * Generate expected cookies based on detected scripts and measurement IDs
 */
export function generateExpectedCookiesFromScripts(measurementIds, scriptUrls, siteDomain) {
  const expectedCookies = [];
  const hostname = siteDomain.replace(/^https?:\/\//, '').split('/')[0];
  const seenCookies = {}; // Avoid duplicates
  
  // Process Google Analytics measurement IDs
  for (const mid of measurementIds) {
    if (mid.type === 'ga4') {
      // GA4 cookies - add standard GA cookies plus GA4-specific measurement ID cookie
      const standardGACookies = ['_ga', '_gid', '_gat', '_gac', '_gcl_au', '_gcl_dc', '_gcl_gb', '_gcl_aw', '_gtag'];
      
          // Add standard GA cookies
          for (const cookieName of standardGACookies) {
            if (!seenCookies[cookieName]) {
              const cookieDef = COOKIE_DATABASE['google-analytics'].cookies.find(c => c.name === cookieName);
              if (cookieDef) {
                expectedCookies.push({
                  name: cookieName,
                  domain: hostname,
                  path: '/',
                  category: cookieDef.category,
                  provider: cookieDef.provider,
                  description: `[Expected] ${cookieDef.description} - Inferred from detected Google Analytics script.`,
                  expected: true,
                  isExpected: true,
                  source: 'script-inference'
                });
                seenCookies[cookieName] = true;
              }
            }
          }
          
          // Add GA4-specific measurement ID cookie (_ga_XXXXXXXXXX)
          // Extract measurement ID without 'G-' prefix and any non-alphanumeric characters
          if (mid.id) {
            const measurementIdClean = mid.id.replace(/^G-/, '').replace(/[^A-Z0-9]/g, '');
            const ga4CookieName = '_ga_' + measurementIdClean;
            if (!seenCookies[ga4CookieName]) {
              expectedCookies.push({
                name: ga4CookieName,
                domain: hostname,
                path: '/',
                category: 'analytics',
                provider: 'Google Analytics',
                description: `[Expected] Google Analytics 4 cookie - stores session and campaign data for measurement ID ${mid.id}. Inferred from detected GA4 script.`,
                expected: true,
                isExpected: true,
                source: 'script-inference'
              });
              seenCookies[ga4CookieName] = true;
            }
          }
    } else if (mid.type === 'ua') {
      // Universal Analytics cookies
      const uaCookies = ['_ga', '_gid', '_gat', '_utma', '_utmb', '_utmc', '_utmt', '_utmz', '_utmv'];
      for (const cookieName of uaCookies) {
        if (!seenCookies[cookieName]) {
              const cookieDef = COOKIE_DATABASE['google-analytics'].cookies.find(c => c.name === cookieName);
              if (cookieDef) {
                expectedCookies.push({
                  name: cookieName,
                  domain: hostname,
                  path: '/',
                  category: cookieDef.category,
                  provider: cookieDef.provider,
                  description: `[Expected] ${cookieDef.description} - Inferred from detected Universal Analytics script.`,
                  expected: true
                });
                seenCookies[cookieName] = true;
              }
        }
      }
    } else if (mid.type === 'gtm') {
      // Google Tag Manager cookies
          for (const cookieDef of COOKIE_DATABASE['google-tag-manager'].cookies) {
            if (!seenCookies[cookieDef.name]) {
              expectedCookies.push({
                name: cookieDef.name,
                domain: hostname,
                path: '/',
                category: cookieDef.category,
                provider: cookieDef.provider,
                description: `[Expected] ${cookieDef.description} - Inferred from detected Google Tag Manager script.`,
                expected: true,
                isExpected: true,
                source: 'script-inference'
              });
              seenCookies[cookieDef.name] = true;
            }
          }
      // GTM often uses GA cookies too
      const gaCookies = ['_ga', '_gid'];
      for (const cookieName of gaCookies) {
        if (!seenCookies[cookieName]) {
              const cookieDef = COOKIE_DATABASE['google-analytics'].cookies.find(c => c.name === cookieName);
              if (cookieDef) {
                expectedCookies.push({
                  name: cookieName,
                  domain: hostname,
                  path: '/',
                  category: cookieDef.category,
                  provider: cookieDef.provider,
                  description: `[Expected] ${cookieDef.description} - Inferred from detected Google Tag Manager script.`,
                  expected: true,
                  isExpected: true,
                  source: 'script-inference'
                });
                seenCookies[cookieName] = true;
              }
        }
      }
    }
  }
  
  // Check script URLs for other services
  for (const scriptUrl of scriptUrls) {
    const urlLower = scriptUrl.toLowerCase();
    
        // Facebook Pixel
        if (urlLower.includes('facebook.net') || urlLower.includes('fbevents.js') || urlLower.includes('facebook.com/tr')) {
          for (const cookieDef of COOKIE_DATABASE['facebook'].cookies) {
            if (!seenCookies[cookieDef.name]) {
              expectedCookies.push({
                name: cookieDef.name,
                domain: hostname,
                path: '/',
                category: cookieDef.category,
                provider: cookieDef.provider,
                description: `[Expected] ${cookieDef.description} - Inferred from detected Facebook Pixel script.`,
                expected: true,
                isExpected: true,
                source: 'script-inference'
              });
              seenCookies[cookieDef.name] = true;
            }
          }
        }
        
        // Hotjar
        if (urlLower.includes('hotjar.com') || urlLower.includes('hotjar.io')) {
          for (const cookieDef of COOKIE_DATABASE['hotjar'].cookies) {
            if (!seenCookies[cookieDef.name]) {
              expectedCookies.push({
                name: cookieDef.name,
                domain: hostname,
                path: '/',
                category: cookieDef.category,
                provider: cookieDef.provider,
                description: `[Expected] ${cookieDef.description} - Inferred from detected Hotjar script.`,
                expected: true,
                isExpected: true,
                source: 'script-inference'
              });
              seenCookies[cookieDef.name] = true;
            }
          }
        }
        
        // LinkedIn Insight Tag
        if (urlLower.includes('linkedin.com/px') || urlLower.includes('snap.licdn.com') || urlLower.includes('linkedin.com/analytics')) {
          for (const cookieDef of COOKIE_DATABASE['linkedin'].cookies) {
            if (!seenCookies[cookieDef.name]) {
              expectedCookies.push({
                name: cookieDef.name,
                domain: hostname,
                path: '/',
                category: cookieDef.category,
                provider: cookieDef.provider,
                description: `[Expected] ${cookieDef.description} - Inferred from detected LinkedIn Insight Tag script.`,
                expected: true,
                isExpected: true,
                source: 'script-inference'
              });
              seenCookies[cookieDef.name] = true;
            }
          }
        }
        
        // Twitter Pixel
        if (urlLower.includes('ads-twitter.com') || urlLower.includes('analytics.twitter.com') || urlLower.includes('twq')) {
          for (const cookieDef of COOKIE_DATABASE['twitter'].cookies) {
            if (!seenCookies[cookieDef.name]) {
              expectedCookies.push({
                name: cookieDef.name,
                domain: hostname,
                path: '/',
                category: cookieDef.category,
                provider: cookieDef.provider,
                description: `[Expected] ${cookieDef.description} - Inferred from detected Twitter Pixel script.`,
                expected: true,
                isExpected: true,
                source: 'script-inference'
              });
              seenCookies[cookieDef.name] = true;
            }
          }
        }
        
        // Pinterest
        if (urlLower.includes('pinterest.com') || urlLower.includes('pinimg.com')) {
          for (const cookieDef of COOKIE_DATABASE['pinterest'].cookies) {
            if (!seenCookies[cookieDef.name]) {
              expectedCookies.push({
                name: cookieDef.name,
                domain: hostname,
                path: '/',
                category: cookieDef.category,
                provider: cookieDef.provider,
                description: `[Expected] ${cookieDef.description} - Inferred from detected Pinterest script.`,
                expected: true,
                isExpected: true,
                source: 'script-inference'
              });
              seenCookies[cookieDef.name] = true;
            }
          }
        }
  }
  
  return expectedCookies;
}
