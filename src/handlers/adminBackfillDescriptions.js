// src/handlers/adminBackfillDescriptions.js
// Fixes BannerCustomization.translations.en.description for legacy Webflow sites
// that were written with the wrong "By clicking, you agree..." preference-panel text.
//
// Detects the wrong text by exact match, replaces it with the correct initial-banner
// description for that language, and moves the old text into en.managePreferences.
//
// Supports ?dryRun=true — reports what would change without writing.
// POST /api/admin/backfill-descriptions
import { checkAdminAuth } from '../utils/adminAuth.js';

// Maps the wrong en.description value → { description, preferenceDescription }
// Keys are trimmed for comparison. Values use the corrected texts from translation-utils.ts.
const WRONG_TO_CORRECT = {
  // English
  'By clicking, you agree to store cookies on your device to enhance navigation, analyze usage, and support marketing.': {
    description: 'We use cookies to provide you with the best possible experience. They also allow us to analyze user behavior in order to constantly improve the website for you.',
    preferenceDescription: 'By clicking, you agree to store cookies on your device to enhance navigation, analyze usage, and support marketing.',
  },
  // Spanish
  'Al hacer clic, acepta el almacenamiento de cookies en su dispositivo para mejorar la navegación del sitio, analizar el uso del sitio y ayudar en nuestros esfuerzos de marketing como se describe en nuestro.': {
    description: 'Utilizamos cookies para brindarle la mejor experiencia posible. También nos permiten analizar el comportamiento del usuario para mejorar constantemente el sitio web para usted.',
    preferenceDescription: 'Al hacer clic, acepta el almacenamiento de cookies en su dispositivo para mejorar la navegación del sitio, analizar el uso del sitio y ayudar en nuestros esfuerzos de marketing.',
  },
  // French
  'Ces cookies sont nécessaires au bon fonctionnement du site web. Ils ne stockent aucune information personnelle.': {
    description: "Nous utilisons des cookies pour vous offrir la meilleure expérience possible. Ils nous permettent également d'analyser le comportement des utilisateurs afin d'améliorer constamment le site Web pour vous.",
    preferenceDescription: "En cliquant, vous acceptez de stocker des cookies sur votre appareil pour améliorer la navigation, analyser l'utilisation et soutenir le marketing.",
  },
  // German
  'Durch Klicken stimmen Sie zu, Cookies auf Ihrem Gerät zu speichern, um die Navigation zu verbessern, die Nutzung zu analysieren und Marketing zu unterstützen': {
    description: 'Wir verwenden Cookies, um Ihnen das bestmögliche Erlebnis zu bieten. Sie helfen uns auch, das Nutzerverhalten zu analysieren, um die Website kontinuierlich für Sie zu verbessern.',
    preferenceDescription: 'Durch Klicken stimmen Sie zu, Cookies auf Ihrem Gerät zu speichern, um die Navigation zu verbessern, die Nutzung zu analysieren und Marketing zu unterstützen.',
  },
  // Italian
  "Cliccando, accetti di memorizzare i cookie sul tuo dispositivo per migliorare la navigazione, analizzare l'utilizzo e supportare il marketing": {
    description: 'Utilizziamo i cookie per fornirti la migliore esperienza possibile. Ci permettono anche di analizzare il comportamento degli utenti per migliorare costantemente il sito web per te.',
    preferenceDescription: "Cliccando, accetti di memorizzare i cookie sul tuo dispositivo per migliorare la navigazione, analizzare l'utilizzo e supportare il marketing.",
  },
  // Portuguese
  'Ao clicar, você concorda em armazenar cookies no seu dispositivo para melhorar a navegação, analisar o uso e apoiar o marketing': {
    description: 'Usamos cookies para fornecer a melhor experiência possível. Eles também nos permitem analisar o comportamento do usuário para melhorar constantemente o site para você.',
    preferenceDescription: 'Ao clicar, você concorda em armazenar cookies no seu dispositivo para melhorar a navegação, analisar o uso e apoiar o marketing.',
  },
  // Swedish
  'Genom att klicka godkänner du att lagra cookies på din enhet för att förbättra navigering, analysera användning och stödja marknadsföring': {
    description: 'Vi använder cookies för att ge dig den bästa möjliga upplevelsen. De låter oss också analysera användarbeteende för att ständigt förbättra webbplatsen för dig.',
    preferenceDescription: 'Genom att klicka godkänner du att lagra cookies på din enhet för att förbättra navigering, analysera användning och stödja marknadsföring.',
  },
  // Dutch
  'Door te klikken stemt u in met het opslaan van cookies op uw apparaat om navigatie te verbeteren, gebruik te analyseren en marketing te ondersteunen': {
    description: 'We gebruiken cookies om u de best mogelijke ervaring te bieden. Ze stellen ons ook in staat om gebruikersgedrag te analyseren om de website voortdurend voor u te verbeteren.',
    preferenceDescription: 'Door te klikken stemt u in met het opslaan van cookies op uw apparaat om navigatie te verbeteren, gebruik te analyseren en marketing te ondersteunen.',
  },
  // Polish
  'Klikając, wyrażasz zgodę na przechowywanie plików cookie na Twoim urządzeniu w celu poprawy nawigacji, analizy użytkowania i wsparcia marketingu': {
    description: 'Używamy plików cookie, aby zapewnić najlepsze możliwe doświadczenie. Pozwalają nam również analizować zachowanie użytkowników, aby stale ulepszać stronę dla Ciebie.',
    preferenceDescription: 'Klikając, wyrażasz zgodę na przechowywanie plików cookie na Twoim urządzeniu w celu poprawy nawigacji, analizy użytkowania i wsparcia marketingu.',
  },
};

export async function handleAdminBackfillDescriptions(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }
  const authError = checkAdminAuth(request, env);
  if (authError) return authError;

  const db = env.CONSENT_WEBAPP;
  if (!db) {
    return Response.json({ success: false, error: 'CONSENT_WEBAPP not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === 'true';

  // Fetch all BannerCustomization rows — wrong description can appear on any site
  // (not just legacy Webflow) if it was published via the old buildCustomizationPayload.
  const { results } = await db.prepare(`
    SELECT bc.siteId, bc.translations, s.domain
    FROM BannerCustomization bc
    JOIN Site s ON bc.siteId = s.id
  `).all();

  const rows = results ?? [];

  const fixed = [];
  const skipped = [];
  const errors = [];

  for (const row of rows) {
    const { siteId, domain, translations: rawTranslations } = row;

    let trans;
    try {
      trans = typeof rawTranslations === 'string' ? JSON.parse(rawTranslations) : rawTranslations;
    } catch (_) {
      errors.push({ siteId, domain, reason: 'Failed to parse translations JSON' });
      continue;
    }

    if (!trans?.en) {
      skipped.push({ siteId, domain, reason: 'No en translations block' });
      continue;
    }

    const currentDesc = (trans.en.description ?? '').trim();

    // Match exact or repeated/duplicated variants (e.g. text saved multiple times)
    let fix = null;
    for (const [wrongText, correction] of Object.entries(WRONG_TO_CORRECT)) {
      if (currentDesc === wrongText || currentDesc.startsWith(wrongText)) {
        fix = correction;
        break;
      }
    }

    if (!fix) {
      skipped.push({ siteId, domain, reason: 'description not in wrong-text set', currentDesc: currentDesc || '(empty)' });
      continue;
    }

    if (dryRun) {
      fixed.push({ siteId, domain, status: 'dry-run', oldDescription: currentDesc, newDescription: fix.description });
      continue;
    }

    try {
      const updatedTrans = {
        ...trans,
        en: {
          ...trans.en,
          description: fix.description,
          managePreferences: fix.preferenceDescription,
        },
      };

      await db.prepare(
        `UPDATE BannerCustomization SET translations = ?1, updatedAt = ?2 WHERE siteId = ?3`
      ).bind(JSON.stringify(updatedTrans), new Date().toISOString(), siteId).run();

      fixed.push({ siteId, domain, status: 'fixed', oldDescription: currentDesc, newDescription: fix.description });
    } catch (err) {
      errors.push({ siteId, domain, reason: err?.message });
    }
  }

  return Response.json({
    success: true,
    dryRun,
    total: rows.length,
    fixed: fixed.length,
    skipped: skipped.length,
    errors: errors.length,
    results: { fixed, skipped, errors },
  });
}
