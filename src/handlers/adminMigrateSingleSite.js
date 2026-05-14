// src/handlers/adminMigrateSingleSite.js
// Migrates one legacy Webflow site into CONSENT_WEBAPP D1.
// Reads from WEBFLOW_AUTHENTICATION KV (by wfSiteId) and ACTIVE_SITES_CONSENTBIT KV (by domain).
// After migration, writes cdnScriptId + webapp IDs back to both KVs.
function checkAuth(request, env) {
  const provided = request.headers.get('X-Admin-Key') || request.headers.get('X-Internal-Secret');
  const valid = [env.ADMIN_SECRET, env.LEGACY_API_SECRET].filter(Boolean);
  if (!valid.length || !provided || !valid.includes(provided)) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

function normalizeDomain(raw) {
  return (raw || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().trim();
}

function nowIso() {
  return new Date().toISOString();
}

async function upsertUser(db, email, now) {
  const existing = await db.prepare('SELECT id FROM User WHERE email = ?1').bind(email).first();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO User (id, email, password_hash, isLegacy, createdAt, updatedAt)
     VALUES (?1, ?2, 'legacy:no-password', 1, ?3, ?3)`
  ).bind(id, email, now).run();
  return id;
}

async function upsertOrganization(db, userId, name, now) {
  const existing = await db.prepare('SELECT id FROM Organization WHERE ownerUserId = ?1').bind(userId).first();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO Organization (id, ownerUserId, name, createdAt, updatedAt)
     VALUES (?1, ?2, ?3, ?4, ?4)`
  ).bind(id, userId, name, now).run();
  return id;
}

async function upsertSite(db, { organizationId, domain, name, stagingUrl, customDomain, platformSiteId, platform, now }) {
  const existing = await db.prepare('SELECT id, cdnScriptId FROM Site WHERE domain = ?1').bind(domain).first();
  if (existing) {
    await db.prepare(
      `UPDATE Site SET platformSiteId=?1, platform=?2, stagingUrl=?3, customDomain=?4,
       isLegacy=1, legacySource=?5, updatedAt=?6 WHERE id=?7`
    ).bind(platformSiteId || null, platform || null, stagingUrl || null, customDomain || null, platform || null, now, existing.id).run();
    return { siteId: existing.id, cdnScriptId: existing.cdnScriptId };
  }
  const id = crypto.randomUUID();
  const cdnScriptId = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO Site (id, organizationId, name, domain, cdnScriptId, apiKey,
      platformSiteId, platform, stagingUrl, customDomain, isLegacy, legacySource, createdAt, updatedAt)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11,?12,?12)`
  ).bind(id, organizationId, name, domain, cdnScriptId, apiKey,
    platformSiteId || null, platform || null, stagingUrl || null, customDomain || null, platform || null, now).run();
  return { siteId: id, cdnScriptId };
}

async function upsertSubscription(db, { organizationId, siteId, subscriptionId, customerId, status, cancelAtPeriodEnd, interval, currentPeriodEnd, planId, now }) {
  const resolvedPlanId = ['basic', 'essential', 'growth'].includes(planId) ? planId : 'basic';
  if (subscriptionId) {
    const existing = await db.prepare('SELECT id FROM Subscription WHERE stripeSubscriptionId = ?1').bind(subscriptionId).first();
    if (existing) {
      await db.prepare(
        `UPDATE Subscription SET status=?1, cancelAtPeriodEnd=?2, planId=?3, updatedAt=?4 WHERE id=?5`
      ).bind(status || 'active', cancelAtPeriodEnd ? 1 : 0, resolvedPlanId, now, existing.id).run();
      return;
    }
  } else {
    const existing = await db.prepare('SELECT id FROM Subscription WHERE siteId = ?1 LIMIT 1').bind(siteId).first();
    if (existing) {
      await db.prepare(
        `UPDATE Subscription SET status=?1, cancelAtPeriodEnd=?2, planId=?3, updatedAt=?4 WHERE id=?5`
      ).bind(status || 'active', cancelAtPeriodEnd ? 1 : 0, resolvedPlanId, now, existing.id).run();
      return;
    }
  }
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO Subscription (id, organizationId, siteId, stripeSubscriptionId, stripeCustomerId,
      planType, planId, interval, status, cancelAtPeriodEnd, currentPeriodEnd, createdAt, updatedAt)
     VALUES (?1,?2,?3,?4,?5,'single',?6,?7,?8,?9,?10,?11,?11)`
  ).bind(id, organizationId, siteId, subscriptionId || null, customerId || null,
    resolvedPlanId, interval || 'monthly', status || 'active', cancelAtPeriodEnd ? 1 : 0,
    currentPeriodEnd || null, now).run();
}

// ── helpers mirroring buildCustomizationPayload.ts ──────────────────────────
const WEIGHT_LABEL_TO_NUM = {
  Thin: '100', Light: '300', Regular: '400', Medium: '500',
  'Semi Bold': '600', Bold: '700', 'Extra Bold': '800', Black: '900',
};
function weightToNumeric(label) {
  if (!label) return '700';
  if (/^\d+$/.test(String(label).trim())) return String(label).trim();
  return WEIGHT_LABEL_TO_NUM[label] ?? '700';
}
function positionToDb(selected) {
  if (selected === 'right') return 'bottom-right';
  if (selected === 'center') return 'bottom-center';
  return 'bottom-left';
}
function styleToLayoutVisual(style) {
  return style === 'fullwidth' ? 'banner' : 'box';
}
function pxToRem(px) {
  const n = Number(px ?? 0);
  return `${(n / 16).toFixed(3)}rem`;
}

// Mirrors translation-utils.ts — full translations table + languageMapping
const LANGUAGE_MAPPING = {
  English: 'en', Spanish: 'es', French: 'fr', German: 'de',
  Italian: 'it', Polish: 'pl', Portuguese: 'pt', Swedish: 'sv', Dutch: 'nl',
};
const TRANSLATIONS_TABLE = {
  en: {
    bannerTitle: 'We value your privacy',
    heading: 'Cookie Preferences',
    preferenceDescription: 'Manage your cookie preferences. You can enable or disable different types of cookies below.',
    description: 'By clicking, you agree to store cookies on your device to enhance navigation, analyze usage, and support marketing. ',
    acceptAll: 'Accept', savePreference: 'Save Preference', reject: 'Reject',
    changePreference: 'Preference', moreInfo: 'Privacy Policy',
    alwaysActive: 'Always Active', cancel: 'Cancel',
    sections: {
      essential:   { label: 'Essential',   description: 'Essential cookies enable core site functions like security and accessibility. They don\'t store personal data and cant be disabled.' },
      analytics:   { label: 'Analytics',   description: 'These cookies collect anonymous data to help us improve website functionality and enhance user experience.' },
      marketing:   { label: 'Marketing',   description: 'These cookies track users across websites to deliver relevant ads and may process personal data, requiring explicit consent.' },
      preferences: { label: 'Preferences', description: 'These cookies remember settings like language or region and store display preferences to offer a more personalized, seamless experience.' },
    },
  },
  es: {
    bannerTitle: 'Valoramos su privacidad', heading: 'Preferencias de Cookies',
    preferenceDescription: 'Gestione sus preferencias de cookies. Puede activar o desactivar diferentes tipos de cookies a continuación.',
    description: 'Al hacer clic, acepta el almacenamiento de cookies en su dispositivo para mejorar la navegación del sitio, analizar el uso del sitio y ayudar en nuestros esfuerzos de marketing como se describe en nuestro.',
    acceptAll: 'Aceptar', savePreference: 'Guardar preferencias', reject: 'Rechazar',
    changePreference: 'Preferencias', moreInfo: 'Más Información',
    alwaysActive: 'Siempre Activo', cancel: 'Cancelar',
    sections: {
      essential:   { label: 'Esenciales',  description: 'Las cookies esenciales permiten funciones básicas del sitio como la seguridad y la accesibilidad. No almacenan datos personales y no se pueden desactivar.' },
      analytics:   { label: 'Analíticas',  description: 'Estas cookies recopilan datos anónimos para ayudarnos a mejorar la funcionalidad del sitio web y optimizar la experiencia del usuario.' },
      marketing:   { label: 'Marketing',   description: 'Estas cookies rastrean a los usuarios en diferentes sitios web para ofrecer anuncios relevantes y pueden procesar datos personales, por lo que requieren el consentimiento explícito.' },
      preferences: { label: 'Preferencias',description: 'Estas cookies recuerdan configuraciones como el idioma o la región y almacenan preferencias de visualización para ofrecer una experiencia más personalizada y fluida.' },
    },
  },
  fr: {
    bannerTitle: 'Nous respectons votre vie privée', heading: 'Préférences des Cookies',
    preferenceDescription: 'Gérez vos préférences en matière de cookies. Vous pouvez activer ou désactiver différents types de cookies ci-dessous.',
    description: 'Ces cookies sont nécessaires au bon fonctionnement du site web. Ils ne stockent aucune information personnelle.',
    acceptAll: 'Accepter', savePreference: 'Enregistrer les préférences', reject: 'Refuser',
    changePreference: 'Préférences', moreInfo: 'Plus d\'Informations',
    alwaysActive: 'Toujours Actif', cancel: 'Annuler',
    sections: {
      essential:   { label: 'Essentiels',  description: 'Les cookies essentiels permettent les fonctions de base du site, comme la sécurité et l\'accessibilité. Ils ne stockent pas de données personnelles et ne peuvent pas être désactivés.' },
      analytics:   { label: 'Analytiques', description: 'Ces cookies collectent des données anonymes pour nous aider à améliorer les fonctionnalités du site web et à enrichir l\'expérience utilisateur.' },
      marketing:   { label: 'Marketing',   description: 'Ces cookies suivent les utilisateurs sur différents sites web pour diffuser des publicités pertinentes et peuvent traiter des données personnelles, nécessitant ainsi un consentement explicite.' },
      preferences: { label: 'Préférences', description: 'Ces cookies mémorisent des paramètres tels que la langue ou la région et enregistrent les préférences d\'affichage afin d\'offrir une expérience plus personnalisée et fluide.' },
    },
  },
  de: {
    bannerTitle: 'Wir schätzen Ihre Privatsphäre', heading: 'Cookie-Einstellungen',
    preferenceDescription: 'Verwalten Sie Ihre Cookie-Einstellungen. Sie können verschiedene Arten von Cookies unten aktivieren oder deaktivieren.',
    description: 'Durch Klicken stimmen Sie zu, Cookies auf Ihrem Gerät zu speichern, um die Navigation zu verbessern, die Nutzung zu analysieren und Marketing zu unterstützen',
    acceptAll: 'Akzeptieren', savePreference: 'Einstellungen speichern', reject: 'Ablehnen',
    changePreference: 'Einstellungen', moreInfo: 'Weitere Informationen',
    alwaysActive: 'Immer Aktiv', cancel: 'Abbrechen',
    sections: {
      essential:   { label: 'Notwendig',  description: 'Notwendige Cookies ermöglichen grundlegende Website-Funktionen wie Sicherheit und Barrierefreiheit. Sie speichern keine persönlichen Daten und können nicht deaktiviert werden.' },
      analytics:   { label: 'Analytik',   description: 'Diese Cookies sammeln anonyme Daten, um uns zu helfen, die Website-Funktionalität zu verbessern und die Benutzererfahrung zu optimieren.' },
      marketing:   { label: 'Marketing',  description: 'Diese Cookies verfolgen Benutzer über Websites hinweg, um relevante Anzeigen zu liefern und können persönliche Daten verarbeiten, was eine ausdrückliche Zustimmung erfordert.' },
      preferences: { label: 'Einstellungen', description: 'Diese Cookies merken sich Einstellungen wie Sprache oder Region und speichern Anzeigepräferenzen, um eine personalisiertere, nahtlosere Erfahrung zu bieten.' },
    },
  },
  it: {
    bannerTitle: 'Rispettiamo la tua privacy', heading: 'Preferenze sui Cookie',
    preferenceDescription: 'Gestisci le tue preferenze sui cookie. Puoi abilitare o disabilitare diversi tipi di cookie di seguito.',
    description: 'Cliccando, accetti di memorizzare i cookie sul tuo dispositivo per migliorare la navigazione, analizzare l\'utilizzo e supportare il marketing',
    acceptAll: 'Accetta', savePreference: 'Salva Preferenze', reject: 'Rifiuta',
    changePreference: 'Preferenze', moreInfo: 'Maggiori Informazioni',
    alwaysActive: 'Sempre Attivo', cancel: 'Annulla',
    sections: {
      essential:   { label: 'Essenziali', description: 'I cookie essenziali abilitano le funzioni principali del sito come sicurezza e accessibilità. Non memorizzano dati personali e non possono essere disabilitati.' },
      analytics:   { label: 'Analitica',  description: 'Questi cookie raccolgono dati anonimi per aiutarci a migliorare la funzionalità del sito web e ottimizzare l\'esperienza utente.' },
      marketing:   { label: 'Marketing',  description: 'Questi cookie tracciano gli utenti su diversi siti web per fornire annunci rilevanti e possono elaborare dati personali, richiedendo un consenso esplicito.' },
      preferences: { label: 'Preferenze', description: 'Questi cookie ricordano le impostazioni come lingua o regione e memorizzano le preferenze di visualizzazione per offrire un\'esperienza più personalizzata e fluida.' },
    },
  },
  pt: {
    bannerTitle: 'Valorizamos a sua privacidade', heading: 'Preferências de Cookies',
    preferenceDescription: 'Gerencie suas preferências de cookies. Você pode ativar ou desativar diferentes tipos de cookies abaixo.',
    description: 'Ao clicar, você concorda em armazenar cookies no seu dispositivo para melhorar a navegação, analisar o uso e apoiar o marketing',
    acceptAll: 'Aceitar', savePreference: 'Salvar Preferências', reject: 'Rejeitar',
    changePreference: 'Preferências', moreInfo: 'Mais Informações',
    alwaysActive: 'Sempre Ativo', cancel: 'Cancelar',
    sections: {
      essential:   { label: 'Essenciais',  description: 'Os cookies essenciais permitem funções básicas do site como segurança e acessibilidade. Eles não armazenam dados pessoais e não podem ser desabilitados.' },
      analytics:   { label: 'Analíticos',  description: 'Esses cookies coletam dados anônimos para nos ajudar a melhorar a funcionalidade do site e otimizar a experiência do usuário.' },
      marketing:   { label: 'Marketing',   description: 'Esses cookies rastreiam usuários em diferentes sites para fornecer anúncios relevantes e podem processar dados pessoais, exigindo consentimento explícito.' },
      preferences: { label: 'Preferências',description: 'Esses cookies lembram configurações como idioma ou região e armazenam preferências de exibição para oferecer uma experiência mais personalizada e fluida.' },
    },
  },
  sv: {
    bannerTitle: 'Vi värnar om din integritet', heading: 'Cookie-inställningar',
    preferenceDescription: 'Hantera dina cookie-inställningar. Du kan aktivera eller inaktivera olika typer av cookies nedan.',
    description: 'Genom att klicka godkänner du att lagra cookies på din enhet för att förbättra navigering, analysera användning och stödja marknadsföring',
    acceptAll: 'Acceptera', savePreference: 'Spara Inställningar', reject: 'Avvisa',
    changePreference: 'Inställningar', moreInfo: 'Mer Information',
    alwaysActive: 'Alltid Aktiv', cancel: 'Avbryt',
    sections: {
      essential:   { label: 'Nödvändiga',      description: 'Nödvändiga cookies aktiverar grundläggande webbplatsfunktioner som säkerhet och tillgänglighet. De lagrar inte personuppgifter och kan inte inaktiveras.' },
      analytics:   { label: 'Analytik',         description: 'Dessa cookies samlar in anonyma data för att hjälpa oss att förbättra webbplatsens funktionalitet och optimera användarupplevelsen.' },
      marketing:   { label: 'Marknadsföring',   description: 'Dessa cookies spårar användare över webbplatser för att leverera relevanta annonser och kan behandla personuppgifter, vilket kräver uttryckligt samtycke.' },
      preferences: { label: 'Inställningar',    description: 'Dessa cookies kommer ihåg inställningar som språk eller region och lagrar visningspreferenser för att erbjuda en mer personlig och smidig upplevelse.' },
    },
  },
  nl: {
    bannerTitle: 'Wij waarderen uw privacy', heading: 'Cookie-instellingen',
    preferenceDescription: 'Beheer uw cookievoorkeuren. U kunt hieronder verschillende soorten cookies in- of uitschakelen.',
    description: 'Door te klikken stemt u in met het opslaan van cookies op uw apparaat om navigatie te verbeteren, gebruik te analyseren en marketing te ondersteunen',
    acceptAll: 'Accepteren', savePreference: 'Instellingen Opslaan', reject: 'Weigeren',
    changePreference: 'Voorkeuren', moreInfo: 'Meer Informatie',
    alwaysActive: 'Altijd Actief', cancel: 'Annuleren',
    sections: {
      essential:   { label: 'Essentieel',  description: 'Essentiële cookies maken kernwebsite-functies mogelijk zoals beveiliging en toegankelijkheid. Ze slaan geen persoonlijke gegevens op en kunnen niet worden uitgeschakeld.' },
      analytics:   { label: 'Analytics',   description: 'Deze cookies verzamelen anonieme gegevens om ons te helpen de website-functionaliteit te verbeteren en de gebruikerservaring te optimaliseren.' },
      marketing:   { label: 'Marketing',   description: 'Deze cookies volgen gebruikers op verschillende websites om relevante advertenties te leveren en kunnen persoonlijke gegevens verwerken, wat expliciete toestemming vereist.' },
      preferences: { label: 'Voorkeuren',  description: 'Deze cookies onthouden instellingen zoals taal of regio en slaan weergavevoorkeuren op om een meer gepersonaliseerde, naadloze ervaring te bieden.' },
    },
  },
  pl: {
    bannerTitle: 'Cenimy Twoją prywatność', heading: 'Ustawienia plików cookie',
    preferenceDescription: 'Zarządzaj swoimi preferencjami dotyczącymi plików cookie. Możesz włączyć lub wyłączyć różne rodzaje plików cookie poniżej.',
    description: 'Klikając, wyrażasz zgodę na przechowywanie plików cookie na Twoim urządzeniu w celu poprawy nawigacji, analizy użytkowania i wsparcia marketingu',
    acceptAll: 'Akceptuj', savePreference: 'Zapisz ustawienia', reject: 'Odrzuć',
    changePreference: 'Preferencje', moreInfo: 'Więcej informacji',
    alwaysActive: 'Zawsze Aktywne', cancel: 'Anuluj',
    sections: {
      essential:   { label: 'Niezbędne',    description: 'Niezbędne pliki cookie umożliwiają podstawowe funkcje strony internetowej, takie jak bezpieczeństwo i dostępność. Nie przechowują danych osobowych i nie można ich wyłączyć.' },
      analytics:   { label: 'Analityczne',  description: 'Te pliki cookie zbierają anonimowe dane, aby pomóc nam ulepszyć funkcjonalność strony internetowej i zoptymalizować doświadczenie użytkownika.' },
      marketing:   { label: 'Marketingowe', description: 'Te pliki cookie śledzą użytkowników na różnych stronach internetowych, aby dostarczać odpowiednie reklamy i mogą przetwarzać dane osobowe, co wymaga wyraźnej zgody.' },
      preferences: { label: 'Preferencje',  description: 'Te pliki cookie zapamiętują ustawienia takie jak język lub region oraz przechowują preferencje wyświetlania, aby zapewnić bardziej spersonalizowane, płynne doświadczenie.' },
    },
  },
};
function getTranslationForMigration(language) {
  const isoCode = LANGUAGE_MAPPING[language] || (language || '').toLowerCase();
  return TRANSLATIONS_TABLE[isoCode] || TRANSLATIONS_TABLE.en;
}

// Writes BannerCustomization from appData (Banner-Settings KV format).
// Mirrors buildCustomizationPayload.ts exactly so the CDN reads the same flat fields.
async function upsertBannerCustomizationFromAppData(db, siteId, appData, now) {
  const id = `banner-custom-${siteId}`;
  const lang = appData.language || 'English';
  const isoCode = LANGUAGE_MAPPING[lang] || lang.toLowerCase();
  const t = getTranslationForMigration(lang);
  const translations = {
    config: {
      bannerLayoutVisual:      styleToLayoutVisual(appData.style ?? ''),
      bannerFontFamily:        appData.Font ?? 'Inter',
      bannerFontWeight:        weightToNumeric(appData.weight ?? 'Bold'),
      bannerFontSize:          Number(appData.size ?? 16),
      bannerTextAlign:         appData.selectedtext ?? 'left',
      bannerBg2:               '#798EFF',
      bannerEntranceAnimation: appData.animation ?? 'fade',
      closeButtonEnabled:      (appData.toggleStates?.closebutton ?? true) ? '1' : '0',
      rejectButtonEnabled:     '1',
      customizeButtonEnabled:  '1',
      cookiePolicyLinkEnabled: '0',
      floatingButtonEnabled:   appData.hideLogo ? '0' : '1',
      floatingButtonPosition:  appData.logoPosition ?? 'left',
    },
    en: {
      languageSelected:        isoCode,
      title:                   t.bannerTitle,
      acceptAll:               t.acceptAll,
      description:             t.description,
      ccpaDescription:         t.description,
      rejectAll:               t.reject,
      customise:               t.changePreference,
      doNotSell:               'Do Not Share My Personal Information',
      cookiePreferences:       t.heading,
      managePreferences:       t.preferenceDescription,
      essential:               t.sections.essential.label,
      strictlyNecessary:       t.sections.essential.label,
      analytics:               t.sections.analytics.label,
      marketing:               t.sections.marketing.label,
      preferences:             t.sections.preferences.label,
      essentialDescription:    t.sections.essential.description,
      analyticsDescription:    t.sections.analytics.description,
      marketingDescription:    t.sections.marketing.description,
      preferencesDescription:  t.sections.preferences.description,
      optOutPreference:        'Opt-out Preference',
      ccpaOptOutPreferenceIntro: 'We use third-party cookies that help us analyze how you use this website, store your preferences, and provide the content and advertisements that are relevant to you. We do not sell your information. However, you can opt out of these cookies by checking Do Not Share My Personal Information and clicking the Save My Preferences button. Once you opt out, you can opt in again at any time by unchecking Do Not Share My Personal Information and clicking the Save My Preferences button.',
      saveMyPreferences:       t.savePreference,
      privacyPolicy:           t.moreInfo,
      alwaysActive:            t.alwaysActive,
      cancel:                  t.cancel,
    },
  };
  await db.prepare(`
    INSERT INTO BannerCustomization (
      id, siteId, position, backgroundColor, textColor, headingColor,
      acceptButtonBg, acceptButtonText, rejectButtonBg, rejectButtonText,
      customiseButtonBg, customiseButtonText, saveButtonBg, saveButtonText,
      backButtonBg, backButtonText, doNotSellButtonBg, doNotSellButtonText,
      privacyPolicyUrl, bannerBorderRadius, buttonBorderRadius,
      stopScroll, footerLink, animationEnabled, preferencePosition, centerAnimationDirection,
      language, autoDetectLanguage, translations, cookieExpirationDays,
      showBannerLogo, bannerLogoPosition, configJson, createdAt, updatedAt
    ) VALUES (
      ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,
      ?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35
    )
    ON CONFLICT(siteId) DO UPDATE SET
      backgroundColor = ?4, textColor = ?5, headingColor = ?6,
      acceptButtonBg = ?7, acceptButtonText = ?8,
      rejectButtonBg = ?9, rejectButtonText = ?10,
      customiseButtonBg = ?11, customiseButtonText = ?12,
      saveButtonBg = ?13, saveButtonText = ?14,
      privacyPolicyUrl = ?19,
      bannerBorderRadius = ?20, buttonBorderRadius = ?21,
      position = ?3,
      centerAnimationDirection = ?26,
      language = ?27, cookieExpirationDays = ?30,
      showBannerLogo = ?31, bannerLogoPosition = ?32,
      translations = ?29,
      configJson = ?33,
      updatedAt = ?35
  `)
  .bind(
    id, siteId,
    positionToDb(appData.selected ?? 'right'),
    appData.bgColor || appData.color || '#ffffff',
    appData.paraColor || '#334155',
    appData.headColor || '#0f172a',
    appData.btnColor || '#0284c7',
    appData.primaryButtonText || '#ffffff',
    appData.btnColor || '#0284c7',          // rejectButtonBg = btnColor (matches buildCustomizationPayload)
    appData.secondbuttontext || '#334155',
    appData.customiseButtonBg || '#ffffff',
    appData.customiseButtonText || '#334155',
    appData.saveButtonBg || '#ffffff',
    appData.saveButtonText || '#334155',
    '#ffffff', '#334155',
    '#ffffff', '#334155',
    appData.privacyUrl || '',
    pxToRem(appData.borderRadius ?? 0),
    pxToRem(appData.buttonRadius ?? 0),
    0, 0, 1,
    'center',
    appData.animation || 'fade',
    appData.language || 'English',
    0,
    JSON.stringify(translations),
    Number(appData.cookieExpiration ?? 120),
    appData.hideLogo ? 0 : 1,
    appData.logoPosition || 'left',
    null,                                   // configJson = null; CDN reads from flat fields
    now, now
  )
  .run();
}

async function upsertBannerCustomization(db, siteId, configJson, now) {
  const c = configJson.customization || {};
  const s = configJson.settings || {};
  const id = `banner-custom-${siteId}`;
  await db.prepare(`
    INSERT INTO BannerCustomization (
      id, siteId, position, backgroundColor, textColor, headingColor,
      acceptButtonBg, acceptButtonText, rejectButtonBg, rejectButtonText,
      customiseButtonBg, customiseButtonText, saveButtonBg, saveButtonText,
      backButtonBg, backButtonText, doNotSellButtonBg, doNotSellButtonText,
      privacyPolicyUrl, bannerBorderRadius, buttonBorderRadius,
      stopScroll, footerLink, animationEnabled, preferencePosition, centerAnimationDirection,
      language, autoDetectLanguage, translations, cookieExpirationDays,
      showBannerLogo, bannerLogoPosition, configJson, createdAt, updatedAt
    ) VALUES (
      ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,
      ?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35
    )
    ON CONFLICT(siteId) DO UPDATE SET
      configJson = ?33,
      backgroundColor = ?4, textColor = ?5, headingColor = ?6,
      acceptButtonBg = ?7, acceptButtonText = ?8,
      rejectButtonBg = ?9, rejectButtonText = ?10,
      privacyPolicyUrl = ?19,
      bannerBorderRadius = ?20, buttonBorderRadius = ?21,
      language = ?27, cookieExpirationDays = ?30,
      updatedAt = ?35
  `)
  .bind(
    id, siteId,
    c.bannerAlignment || 'bottom-left',
    c.colors?.bannerBg || '#ffffff',
    c.colors?.body || '#334155',
    c.colors?.title || '#0f172a',
    c.colors?.btnPrimaryBg || '#0284c7',
    c.colors?.btnPrimaryText || '#ffffff',
    c.colors?.btnSecondaryBg || '#ffffff',
    c.colors?.btnSecondaryText || '#334155',
    '#ffffff', '#334155', '#ffffff', '#334155',
    '#ffffff', '#334155', '#ffffff', '#334155',
    s.privacyUrl || null,
    String(c.radius?.container ?? '0.375rem'),
    String(c.radius?.button ?? '0.375rem'),
    0, 0, 1,
    'center', 'fade',
    s.language || 'en', 0, null,
    s.expires || 30,
    1, 'left',
    JSON.stringify(configJson),
    now, now
  )
  .run();
}

export async function handleAdminMigrateSingleSite(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAuth(request, env);
  if (authError) return authError;

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  // --- action: updatePlan — update plan in KV + D1 without full migration ---
  if (body.action === 'updatePlan') {
    const domain = body.domain ? normalizeDomain(body.domain) : null;
    const plan = body.plan;
    if (!domain) return Response.json({ success: false, error: 'Provide domain' }, { status: 400 });
    if (!['basic', 'essential', 'growth'].includes(plan)) {
      return Response.json({ success: false, error: 'plan must be basic, essential, or growth' }, { status: 400 });
    }

    const activeKv = env.ACTIVE_SITES_CONSENTBIT;
    if (!activeKv) return Response.json({ success: false, error: 'ACTIVE_SITES_CONSENTBIT not configured' }, { status: 503 });

    const existing = await activeKv.get(domain, { type: 'json' });
    if (!existing) return Response.json({ success: false, error: `No KV entry found for domain="${domain}"` }, { status: 404 });

    const updated = { ...existing, plan };
    await activeKv.put(domain, JSON.stringify(updated));

    // Also update D1 Subscription if siteId is known
    let d1Updated = false;
    const siteRow = await db.prepare('SELECT id FROM Site WHERE domain = ?1').bind(domain).first();
    if (siteRow) {
      await db.prepare(`UPDATE Subscription SET planId=?1, updatedAt=?2 WHERE siteId=?3`)
        .bind(plan, new Date().toISOString(), siteRow.id).run();
      d1Updated = true;
    }

    return Response.json({ success: true, domain, plan, kvUpdated: true, d1Updated });
  }

  // Accept either domain or wfSiteId as lookup key, or rawEntry to skip KV lookup
  const inputDomain = body.domain ? normalizeDomain(body.domain) : null;
  const inputWfSiteId = body.wfSiteId || null;
  const dryRun = body.dryRun === true;

  if (!inputDomain && !inputWfSiteId && !body.rawEntry) {
    return Response.json({ success: false, error: 'Provide domain, wfSiteId, or rawEntry' }, { status: 400 });
  }

  const activeKv = env.ACTIVE_SITES_CONSENTBIT;
  const authKv = env.WEBFLOW_AUTHENTICATION;

  if (!activeKv) return Response.json({ success: false, error: 'ACTIVE_SITES_CONSENTBIT KV not configured' }, { status: 503 });

  const logs = [];
  const log = (msg) => { logs.push(msg); };

  // --- 1. Resolve KV entry ---
  let domain = inputDomain;
  let activeEntry = null;

  // Option A: caller passes raw KV data directly (bypass KV lookup)
  if (body.rawEntry) {
    activeEntry = body.rawEntry;
    if (!domain) domain = normalizeDomain(activeEntry.domain || activeEntry.siteDomain || '');
    log(`Using rawEntry — domain resolved to "${domain}"`);
  }

  // Option B: lookup by domain in ACTIVE_SITES_CONSENTBIT
  if (!activeEntry && domain) {
    log(`Looking up ACTIVE_SITES_CONSENTBIT key "${domain}"...`);
    activeEntry = await activeKv.get(domain, { type: 'json' });
    log(activeEntry ? `Found KV entry for "${domain}"` : `No KV entry for "${domain}"`);
  }

  // Option C: look up by wfSiteId via WEBFLOW_AUTHENTICATION to find domain
  if (!activeEntry && inputWfSiteId && authKv) {
    log(`Looking up WEBFLOW_AUTHENTICATION key "${inputWfSiteId}" to resolve domain...`);
    try {
      const raw = await authKv.get(inputWfSiteId);
      if (raw) {
        const wfData = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const candidateDomain = normalizeDomain(wfData.customDomain || wfData.stagingUrl || '');
        log(`WEBFLOW_AUTHENTICATION resolved candidate domain "${candidateDomain}"`);
        if (candidateDomain) {
          activeEntry = await activeKv.get(candidateDomain, { type: 'json' });
          if (activeEntry) { domain = candidateDomain; log(`Found KV entry via wfSiteId → domain "${domain}"`); }
          else log(`No KV entry for candidate domain "${candidateDomain}"`);
        }
      } else {
        log(`No WEBFLOW_AUTHENTICATION entry for wfSiteId="${inputWfSiteId}"`);
      }
    } catch (e) { log(`WEBFLOW_AUTHENTICATION lookup error: ${e?.message}`); }
  }

  if (!activeEntry) {
    log(`FAILED: no active KV entry found`);
    return Response.json({ success: false, error: `No KV entry found for domain="${inputDomain}" or wfSiteId="${inputWfSiteId}". Try passing rawEntry directly.`, logs }, { status: 404 });
  }

  const email = activeEntry.email;
  if (!email) {
    log(`FAILED: KV entry has no email field`);
    return Response.json({ success: false, error: 'KV entry has no email field', logs }, { status: 422 });
  }
  log(`email="${email}"`);

  // --- 2. Resolve Webflow auth details ---
  const wfSiteId = inputWfSiteId || activeEntry.wfSiteId || null;
  let siteName = domain;
  let stagingUrl = null;
  let customDomain = null;
  let appData = null;   // primary: Banner-Settings:{wfSiteId} → appData
  let configJson = null; // fallback: {wfSiteId} → configJson

  if (authKv && wfSiteId) {
    // Primary: Banner-Settings:{wfSiteId} (what the user last customized in the Designer Extension)
    try {
      const bannerRaw = await authKv.get(`Banner-Settings:${wfSiteId}`);
      if (bannerRaw) {
        const bannerStored = typeof bannerRaw === 'string' ? JSON.parse(bannerRaw) : bannerRaw;
        appData = bannerStored.appData || null;
        log(appData ? `Banner-Settings found — appData will be used for BannerCustomization` : `Banner-Settings entry exists but has no appData`);
      } else {
        log(`No Banner-Settings:${wfSiteId} entry`);
      }
    } catch (e) { log(`Banner-Settings lookup error: ${e?.message}`); }

    // Always read main entry for siteName/stagingUrl/customDomain; also grab configJson as fallback
    try {
      const raw = await authKv.get(wfSiteId);
      if (raw) {
        const wfData = typeof raw === 'string' ? JSON.parse(raw) : raw;
        siteName = wfData.siteName || domain;
        stagingUrl = wfData.stagingUrl || null;
        customDomain = wfData.customDomain || null;
        if (!appData) {
          configJson = wfData.config || wfData.configJson || null;
          log(`Auth KV — siteName="${siteName}", no appData — configJson fallback: ${!!configJson}`);
        } else {
          log(`Auth KV — siteName="${siteName}", appData already loaded`);
        }
      } else {
        log(`No WEBFLOW_AUTHENTICATION entry for wfSiteId="${wfSiteId}" — using domain as siteName`);
      }
    } catch (e) { log(`Auth KV lookup error: ${e?.message}`); }
  }

  // --- 3. Dry run — return what would be migrated ---
  if (dryRun) {
    log('Dry run complete');
    return Response.json({
      success: true,
      dryRun: true,
      logs,
      preview: {
        email,
        domain,
        wfSiteId,
        siteName,
        stagingUrl,
        customDomain,
        subscriptionId: activeEntry.subscriptionId || null,
        plan: activeEntry.plan || null,
        hasAppData: !!appData,
        hasConfigJson: !!configJson,
        customizationSource: appData ? 'Banner-Settings appData' : configJson ? 'configJson fallback' : 'none',
      }
    });
  }

  // --- 4. Migrate ---
  const now = nowIso();

  log(`Upserting User email="${email}"...`);
  const userId = await upsertUser(db, email, now);
  log(`userId="${userId}"`);

  log(`Upserting Organization for userId="${userId}"...`);
  const orgId = await upsertOrganization(db, userId, siteName, now);
  log(`orgId="${orgId}"`);

  log(`Upserting Site domain="${domain}" platform="webflow"...`);
  const { siteId, cdnScriptId } = await upsertSite(db, {
    organizationId: orgId,
    domain,
    name: siteName,
    stagingUrl,
    customDomain,
    platformSiteId: wfSiteId,
    platform: 'webflow',
    now,
  });
  log(`siteId="${siteId}" cdnScriptId="${cdnScriptId}"`);

  const siteRow = await db.prepare('SELECT cdnScriptId, apiKey FROM Site WHERE id = ?1').bind(siteId).first();
  const licenseKey = siteRow?.apiKey || null;

  log(`Upserting Subscription subscriptionId="${activeEntry.subscriptionId || 'none'}" plan="${activeEntry.plan || 'basic'}"...`);
  await upsertSubscription(db, {
    organizationId: orgId,
    siteId,
    subscriptionId: activeEntry.subscriptionId || null,
    customerId: activeEntry.customerId || null,
    status: activeEntry.active ? 'active' : 'canceled',
    cancelAtPeriodEnd: activeEntry.cancelAtPeriodEnd || false,
    interval: activeEntry.interval || 'monthly',
    currentPeriodEnd: activeEntry.currentPeriodEnd || activeEntry.serviceExpiresAt || null,
    planId: activeEntry.plan || 'basic',
    now,
  });
  log('Subscription upserted');

  if (appData) {
    log('Upserting BannerCustomization from Banner-Settings appData (primary)...');
    await upsertBannerCustomizationFromAppData(db, siteId, appData, now);
    log('BannerCustomization upserted from appData');
  } else if (configJson) {
    log('Upserting BannerCustomization from configJson (fallback)...');
    await upsertBannerCustomization(db, siteId, configJson, now);
    log('BannerCustomization upserted from configJson');
  } else {
    log('No appData or configJson — BannerCustomization skipped');
  }

  // --- 5. Write new webapp IDs back to KVs ---
  const newIds = { cdnScriptId, webappSiteId: siteId, orgId, licenseKey };

  log(`Updating ACTIVE_SITES_CONSENTBIT key "${domain}" with new IDs...`);
  const updatedActive = { ...activeEntry, ...newIds, plan: 'basic' };
  await activeKv.put(domain, JSON.stringify(updatedActive));
  log('ACTIVE_SITES_CONSENTBIT updated');

  if (authKv && wfSiteId) {
    log(`Updating WEBFLOW_AUTHENTICATION key "${wfSiteId}" with new IDs...`);
    try {
      const raw = await authKv.get(wfSiteId);
      const existing = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      await authKv.put(wfSiteId, JSON.stringify({
        ...existing,
        ...newIds,
        plan: 'basic',
        ...(email ? { email } : {}),
      }));
      log('WEBFLOW_AUTHENTICATION updated');
    } catch (e) { log(`WEBFLOW_AUTHENTICATION update error: ${e?.message}`); }
  }

  log('Migration complete');
  return Response.json({
    success: true,
    logs,
    migrated: { email, domain, wfSiteId, siteId, orgId, cdnScriptId, licenseKey },
  });
}
