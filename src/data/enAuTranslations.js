// Australian English banner text.
//
// WHY THIS IS A *SPARSE* SET AND pt-BR IS NOT
//
// Brazil replaces the site's text wholesale, because a Brazilian cannot read an
// English banner and LGPD art. 5, IX requires consent to be *informada* — a
// banner in an unreadable language does not produce valid consent, so correct
// language has to beat the customer's own wording.
//
// Australia is not that case. An Australian reads "analyze" perfectly well; the
// difference is orthographic, not comprehension. Nothing in the Privacy Act is
// breached by American spelling. So the informed-consent argument does not apply
// and we have no business overwriting a customer's copy.
//
// Hence: these apply ONLY where the site is still running our English default,
// i.e. the customer has not written their own. Customised text is left alone.
// See the guard in cdnTest.js — it compares against DEFAULT_TRANSLATIONS.en
// before substituting.
//
// Keys absent here are identical in both variants and need no override.

export const EN_AU_OVERRIDES = {
  description:
    'We use cookies to provide you with the best possible experience. They also allow us to analyse user behaviour in order to constantly improve the website for you.',
  managePreferences:
    'By clicking, you agree to store cookies on your device to enhance navigation, analyse usage, and support marketing.',
  preferencesDescription:
    'These cookies remember settings like language or region and store display preferences to offer a more personalised, seamless experience.',
  ccpaDescription:
    'We use cookies to provide you with the best possible experience. They also allow us to analyse user behaviour in order to constantly improve the website for you.',
  ccpaOptOut:
    'We use cookies and similar technologies to personalise and enhance your experience. Some of these technologies may involve the "sale" or "sharing" of your personal information under state privacy laws.',
  ccpaOptOutPreferenceIntro:
    'We use third-party cookies that help us analyse how you use this website, store your preferences, and provide the content and advertisements that are relevant to you. We do not sell your information. However, you can opt out of these cookies by checking Do Not Share My Personal Information and clicking the Save My Preferences button. Once you opt out, you can opt in again at any time by unchecking Do Not Share My Personal Information and clicking the Save My Preferences button.',
};
