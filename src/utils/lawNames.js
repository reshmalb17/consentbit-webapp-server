// src/utils/lawNames.js
//
// Official names for the law codes cdnM.js resolves per visitor (COUNTRY_LAWS,
// REGION_LAWS, US_STATE_LAWS). The codes stay as the internal key — cdnM.js
// branches on them (e.g. countryLaw.law === 'LAW25') — but the consent record
// stores the statute's real name, because that row is the customer's evidence
// and a regulator asks "which law", not "which internal tag".
//
// Mapped server-side at save time, so the name cannot be forged by a visitor and
// is not bound by the 64-char limit on the posted `law` field.

export const LAW_NAMES = {
  GDPR:        'EU GDPR',
  UK_GDPR:     'UK GDPR',
  LGPD:        'Brazil LGPD',
  PIPEDA:      'Canada PIPEDA',
  LAW25:       'Quebec Law 25',
  PRIVACY_ACT: 'Australia Privacy Act 1988',
  PDPA_SG:     'Singapore PDPA',
  PDPA_TH:     'Thailand PDPA',
  POPIA:       'South Africa POPIA',
  PDPL:        'Saudi Arabia PDPL',
  CCPA:        'California CCPA/CPRA',
  VCDPA:       'Virginia VCDPA',
  CPA:         'Colorado CPA',
  CTDPA:       'Connecticut CTDPA',
  UCPA:        'Utah UCPA',
};

/** Official name for a law code; anything unknown (or already a name) passes through. */
export function lawName(law) {
  if (law == null || law === '') return law;
  return LAW_NAMES[String(law).toUpperCase()] || law;
}
