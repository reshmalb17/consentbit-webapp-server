// Banner text in Quebec French, served to visitors in Quebec (gap K,
// docs/minimum-legal-requirements.md). TEST-ONLY: used by cdnM.js when LAW_FIXES="1".
//
// Charter of the French Language (as amended by Bill 96): a business that targets Quebec
// must make its site available in French, at least as available as any other language.
// Law 25 s. 14: consent is asked in clear and simple terms, separately per purpose; s. 8.1 /
// 9.1: optional technologies are off until the person turns them on — the text says so.
//
// Terms follow Quebec usage: "témoins" (cookies), "renseignements personnels".
// DRAFT 2026-10-10 — to be checked by a fluent Quebec French reviewer before production.
//
// Length caps the runtime applies (cdnM.js runtime J()/q()): title and cookiePreferences
// 30, privacyPolicy 30, category names and alwaysActive 20, category descriptions 300.

export const QUEBEC_FRENCH = {
  languageSelected: 'fr',
  title: 'Respect de votre vie privée',
  description:
    "Nous utilisons des témoins (cookies) nécessaires au fonctionnement du site et, avec votre accord, des témoins de mesure d'audience, de préférences et de publicité. Vous pouvez tout accepter, tout refuser ou choisir par catégorie, et changer d'avis à tout moment.",
  privacyPolicy: 'Politique de confidentialité',
  acceptAll: 'Accepter',
  rejectAll: 'Refuser',
  customise: 'Personnaliser',
  save: 'Enregistrer mes choix',
  back: 'Retour',
  doNotSell: 'Ne pas vendre ni partager mes renseignements personnels',
  cookiePreferences: 'Préférences de témoins',
  managePreferences:
    "Choisissez les catégories de témoins que vous acceptez. Les témoins optionnels restent désactivés tant que vous ne les activez pas. Vous pouvez modifier vos choix à tout moment.",
  essential: 'Nécessaires',
  strictlyNecessary: '',
  analytics: 'Analytiques',
  marketing: 'Publicité',
  functional: 'Fonctionnels',
  performance: 'Performance',
  advertisement: 'Publicité',
  preferences: 'Préférences',
  essentialDescription:
    'Ces témoins sont indispensables au fonctionnement du site, par exemple pour la sécurité, l’accessibilité et la mémorisation de vos choix. Ils ne peuvent pas être désactivés.',
  analyticsDescription:
    'Ces témoins nous aident à comprendre comment le site est utilisé afin de l’améliorer. Ils ne sont activés qu’avec votre accord.',
  marketingDescription:
    'Ces témoins peuvent suivre votre navigation d’un site à l’autre pour afficher des publicités pertinentes et peuvent traiter des renseignements personnels. Ils ne sont activés qu’avec votre accord.',
  preferencesDescription:
    'Ces témoins mémorisent vos réglages, comme la langue ou la région, pour personnaliser votre expérience. Ils ne sont activés qu’avec votre accord.',
  saveMyPreferences: 'Enregistrer mes choix',
  optOutPreference: 'Préférences de retrait',
  ccpaDescription:
    "Nous utilisons des témoins pour vous offrir la meilleure expérience possible et pour analyser l'utilisation du site afin de l'améliorer.",
  ccpaOptOut:
    'Nous utilisons des témoins et des technologies semblables pour personnaliser et améliorer votre expérience. Certaines peuvent constituer une « vente » ou un « partage » de vos renseignements personnels au sens des lois de certains États américains.',
  ccpaOptOutPreferenceIntro:
    'Nous utilisons des témoins tiers qui nous aident à analyser votre utilisation du site, à mémoriser vos préférences et à afficher du contenu et des publicités pertinents. Pour les refuser, cochez « Ne pas vendre ni partager mes renseignements personnels », puis cliquez sur « Enregistrer mes choix ». Vous pouvez revenir sur ce choix à tout moment en décochant la case.',
  limitUse: 'Limiter l’utilisation de mes renseignements personnels sensibles',
  confirmChoice: 'Confirmer mon choix',
  cancel: 'Annuler',
  alwaysOn: 'toujours actifs',
  alwaysActive: 'Toujours actifs',
  consentIdLabel: 'Identifiant de consentement',
  visitorIdLabel: 'Identifiant du visiteur',
};

// Show/hide switches that older sites keep inside the text set rather than in `config`.
// The runtime reads them from the active language's set, so a French set without them
// would show buttons the customer turned off. Copied from the site's own set.
export const TEXT_SET_SWITCHES = [
  'closeButtonEnabled',
  'rejectButtonEnabled',
  'customizeButtonEnabled',
  'cookiePolicyLinkEnabled',
  'floatingButtonEnabled',
  'floatingButtonPosition',
];

// Shipped generic-French defaults that are wrong, fixed at serve time for sites that
// already saved them (exact match only, so customer-written text is never touched):
//   title             32 chars — cut to 30 by the runtime ("…vie priv")
//   managePreferences "En cliquant, vous acceptez…" — clicking is not consent
export const FRENCH_DEFAULT_FIXES = {
  title: {
    'Nous respectons votre vie privée': 'Respect de votre vie privée',
  },
  managePreferences: {
    "En cliquant, vous acceptez de stocker des cookies sur votre appareil pour améliorer la navigation, analyser l'utilisation et soutenir le marketing.":
      'Choisissez les catégories de cookies que vous acceptez. Les cookies optionnels restent désactivés tant que vous ne les activez pas. Vous pouvez modifier vos choix à tout moment.',
  },
};
