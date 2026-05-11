// Default banner translations — matches BannerCustomization.translations structure:
// { config: { layout/toggle settings }, en: { text content in selected language } }
// All language-specific keys (es, fr, de, nl, etc.) are removed — text is always
// stored in the 'en' key regardless of selected language, set at publish time.

export const DEFAULT_TRANSLATIONS = {
  // config: language-independent layout + toggle settings
  config: {
    bannerLayoutVisual: 'box',
    bannerFontFamily: '',
    bannerFontWeight: '600',
    bannerTextAlign: 'left',
    bannerEntranceAnimation: 'fade-in',
    bannerBg2: '#798EFF',
    bannerFontSize: 16,
    closeButtonEnabled: '1',
    rejectButtonEnabled: '1',
    customizeButtonEnabled: '1',
    cookiePolicyLinkEnabled: '0',
    floatingButtonEnabled: '1',
    floatingButtonPosition: 'left',
  },
  // en: default English text — overridden at publish time with the selected language's text
  en: {
    languageSelected: 'en',
    title: 'We value your privacy',
    description: 'We use cookies to provide you with the best possible experience. They also allow us to analyze user behavior in order to constantly improve the website for you.',
    privacyPolicy: 'Privacy Policy',
    acceptAll: 'Accept',
    rejectAll: 'Reject',
    customise: 'Preference',
    save: 'Save Preference',
    back: 'Back',
    doNotSell: 'Do Not Share My Personal Information',
    cookiePreferences: 'Cookie Preferences',
    managePreferences: 'By clicking, you agree to store cookies on your device to enhance navigation, analyze usage, and support marketing.',
    essential: 'Essential',
    strictlyNecessary: 'Necessary',
    analytics: 'Analytics',
    marketing: 'Marketing',
    functional: 'Functional',
    performance: 'Performance',
    advertisement: 'Advertisement',
    preferences: 'Preferences',
    essentialDescription: "Essential cookies enable core site functions like security and accessibility. They don't store personal data and can't be disabled.",
    analyticsDescription: 'These cookies collect anonymous data to help us improve website functionality and enhance user experience.',
    marketingDescription: 'These cookies track users across websites to deliver relevant ads and may process personal data, requiring explicit consent.',
    preferencesDescription: 'These cookies remember settings like language or region and store display preferences to offer a more personalized, seamless experience.',
    saveMyPreferences: 'Save Preference',
    optOutPreference: 'Opt-out Preference',
    ccpaDescription: 'We use cookies to provide you with the best possible experience. They also allow us to analyze user behavior in order to constantly improve the website for you.',
    ccpaOptOut: 'We use cookies and similar technologies to personalize and enhance your experience. Some of these technologies may involve the "sale" or "sharing" of your personal information under state privacy laws.',
    ccpaOptOutPreferenceIntro:
      'We use third-party cookies that help us analyze how you use this website, store your preferences, and provide the content and advertisements that are relevant to you. We do not sell your information. However, you can opt out of these cookies by checking Do Not Share My Personal Information and clicking the Save My Preferences button. Once you opt out, you can opt in again at any time by unchecking Do Not Share My Personal Information and clicking the Save My Preferences button.',
    limitUse: 'Limit the use of my sensitive personal information',
    confirmChoice: 'Confirm My Choice',
    cancel: 'Cancel',
    alwaysOn: 'always on',
    alwaysActive: 'Always Active',
  },
};

/**
 * Merge stored translations with defaults.
 * Structure: { config: {...}, en: {...} }
 */
export function mergeTranslations(stored) {
  if (!stored || typeof stored !== 'object') return DEFAULT_TRANSLATIONS;
  return {
    config: { ...DEFAULT_TRANSLATIONS.config, ...(stored.config || {}) },
    en:     { ...DEFAULT_TRANSLATIONS.en,     ...(stored.en     || {}) },
  };
}
