// Brazilian Portuguese banner text.
//
// WHY THIS FILE EXISTS
// The worker holds no per-language text. `defaultTranslations.js` has only `en`,
// and a site's published copy is written into its `translations.en` slot in
// whichever language the customer selected (`languageSelected` records which).
// So when a Brazilian visitor lands on a site published in English, there is no
// Portuguese anywhere in the worker to fall back to.
//
// LGPD art. 5, IX requires consent to be *informada*, and CDC (Lei 8.078/1990)
// art. 31 requires consumer-facing information "em língua portuguesa". A banner
// the visitor cannot read does not produce valid consent. This set is what the
// Brazil path serves when the site itself is not published in Portuguese.
//
// 🔴 DRAFT — NOT NATIVE-REVIEWED. Every string below is a proposal, drafted
// against docs/pt-br-translation-review.md. A native Brazilian speaker must read
// these in situ before this reaches production. Currently used by cdnTest.js only.
//
// Deliberately Brazilian, not European: "compartilhar" not "partilhar",
// "configurações" not "definições", "usuários" not "utilizadores",
// "anônimos" not "anónimos", "Salvar" not "Guardar", "você" not "si".

export const PT_BR_TRANSLATIONS = {
  languageSelected: 'pt-BR',
  title: 'Valorizamos a sua privacidade',
  description:
    'Usamos cookies para oferecer a melhor experiência possível. Eles também nos permitem analisar o comportamento dos usuários para melhorar continuamente o site para você.',
  privacyPolicy: 'Política de Privacidade',
  acceptAll: 'Aceitar',
  rejectAll: 'Rejeitar',
  customise: 'Preferências',
  save: 'Salvar preferências',
  back: 'Voltar',
  doNotSell: 'Não compartilhar minhas informações pessoais',
  cookiePreferences: 'Preferências de cookies',
  managePreferences:
    'Ao clicar, você concorda em armazenar cookies no seu dispositivo para melhorar a navegação, analisar o uso e apoiar nossas ações de marketing.',
  essential: 'Estritamente necessários',
  strictlyNecessary: '',
  analytics: 'Analíticos',
  marketing: 'Marketing',
  functional: 'Funcional',
  performance: 'Desempenho',
  advertisement: 'Publicidade',
  preferences: 'Preferências',
  essentialDescription:
    'Os cookies essenciais permitem funções básicas do site, como segurança e acessibilidade. Não armazenam dados pessoais e não podem ser desativados.',
  analyticsDescription:
    'Esses cookies coletam dados anônimos para nos ajudar a melhorar o funcionamento do site e aprimorar a experiência do usuário.',
  marketingDescription:
    'Esses cookies rastreiam usuários em diferentes sites para exibir anúncios relevantes e podem tratar dados pessoais, exigindo consentimento explícito.',
  preferencesDescription:
    'Esses cookies memorizam configurações como idioma ou região e armazenam preferências de exibição para oferecer uma experiência mais personalizada.',
  saveMyPreferences: 'Salvar preferências',
  optOutPreference: 'Preferência de exclusão',
  ccpaDescription:
    'Usamos cookies para oferecer a melhor experiência possível. Eles também nos permitem analisar o comportamento dos usuários para melhorar continuamente o site para você.',
  ccpaOptOut:
    'Usamos cookies e tecnologias semelhantes para personalizar e aprimorar sua experiência. Algumas dessas tecnologias podem envolver a "venda" ou o "compartilhamento" das suas informações pessoais sob as leis estaduais de privacidade.',
  ccpaOptOutPreferenceIntro:
    'Usamos cookies de terceiros que nos ajudam a analisar como você usa este site, a armazenar suas preferências e a fornecer os conteúdos e anúncios relevantes para você. Não vendemos suas informações. No entanto, você pode recusar esses cookies marcando "Não compartilhar minhas informações pessoais" e clicando no botão "Salvar preferências".',
  limitUse: 'Limitar o uso das minhas informações pessoais sensíveis',
  confirmChoice: 'Confirmar minha escolha',
  cancel: 'Cancelar',
  alwaysOn: 'sempre ativo',
  alwaysActive: 'Sempre ativo',

  // LGPD art. 18, VIII — the data subject must be told that consent may be
  // refused and what follows from refusing. No GDPR analogue, so no existing
  // key carries this in any language. Whether it must appear on the banner or
  // only in the policy is an open question for Brazilian counsel.
  refusalConsequences:
    'Você pode recusar. O site continuará funcionando normalmente; apenas os cookies não essenciais não serão utilizados.',
};

/** Category labels for SECTION_LABELS, keyed 'pt-BR'. */
export const PT_BR_SECTION_LABELS = {
  essential: 'Estritamente necessários',
  analytics: 'Analíticos',
  marketing: 'Marketing',
  preferences: 'Preferências',
};
