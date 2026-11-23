// Banner text sets per page locale (Webflow Localize). TEST-ONLY: used by cdnTest.js.
//
// WHY THIS FILE EXISTS
// A site publishes ONE language: its copy sits in `translations.en` whatever the
// language (`languageSelected` records which). A Webflow Localize site serves the
// same head script on every locale (/fr/, /de/ …) and marks each page with
// <html lang="xx"> plus hreflang alternates, so without these sets a French locale
// page shows the banner in the published language. The runtime picks a set from
// <html lang> when it differs from the published language (cdnTest.js LOCALE_SWITCH).
//
// SOURCE: the Webflow Designer App's per-language defaults (Consentbit-Webflow-Production
// src/lib/bannerContent.js: localization, preferenceLocalization, categoryLocalization,
// ccpaLocalization), mapped to the same keys buildCustomizationPayload.js writes. So a
// locale page shows exactly what the customer would get by selecting that language.
// Changes from that source, all for the runtime's length caps (title / cookiePreferences /
// privacyPolicy 30, category names / alwaysActive 20):
//   - Strictly Necessary shortened where the source is over 20 chars (fr, it, pt, es)
//   - French title + preference intro use FRENCH_DEFAULT_FIXES (quebecFrench.js)
// Keys the Designer App has no copy for (back, confirmChoice, ccpaOptOut, functional,
// performance, advertisement) are our translations — DRAFT, not native-reviewed.
//
// pt-br uses PT_BR_TRANSLATIONS (the Brazil set) rather than the European Portuguese below.

import { FRENCH_DEFAULT_FIXES } from './quebecFrench.js';
import { PT_BR_TRANSLATIONS } from './ptBrTranslations.js';

function frFix(key, text) {
  const map = FRENCH_DEFAULT_FIXES[key];
  return (map && map[text]) || text;
}

// One entry per language: [banner, preference center, categories (SN, Mkt, Ana, Pref), ccpa, extras]
const RAW = {
  en: {
    title: 'We value your privacy',
    description: 'We use cookies to enhance your browsing experience, serve personalised ads or content, and analyse our traffic. By clicking "Accept", you consent to our use of cookies.',
    acceptAll: 'Accept', rejectAll: 'Reject', customise: 'Preference', privacyPolicy: 'Privacy Policy',
    cookiePreferences: 'Cookie Preferences',
    managePreferences: 'By clicking, you agree to store cookies on your device to enhance navigation, analyze usage, and support marketing.',
    saveMyPreferences: 'Save my preferences', alwaysActive: 'Always Active',
    essential: 'Strictly Necessary', marketing: 'Marketing', analytics: 'Analytics', preferences: 'Preferences',
    essentialDescription: "Essential cookies enable core site functions like security and accessibility. They don't store personal data and can't be disabled.",
    marketingDescription: 'Marketing cookies track visitors across websites to display relevant, engaging advertisements.',
    analyticsDescription: 'Analytics cookies help us understand how visitors interact with the website by collecting anonymous usage data.',
    preferencesDescription: 'Preference cookies let the website remember your settings and choices for a more personal experience.',
    ccpaDescription: 'We use cookies to provide you with the best possible experience. They also allow us to analyze user behavior in order to constantly improve the website for you.',
    optOutPreference: 'Opt-out Preference',
    ccpaOptOutPreferenceIntro: 'We use third-party cookies that help us analyze how you use this website, store your preferences, and provide the content and advertisements that are relevant to you. We do not sell your information. However, you can opt out of these cookies by checking Do Not Share My Personal Information and clicking the Save My Preferences button. Once you opt out, you can opt in again at any time by unchecking Do Not Share My Personal Information and clicking the Save My Preferences button.',
    doNotSell: 'Do Not Share My Personal Information', cancel: 'Cancel',
    back: 'Back', confirmChoice: 'Confirm My Choice',
    ccpaOptOut: 'We use cookies and similar technologies to personalize and enhance your experience. Some of these technologies may involve the "sale" or "sharing" of your personal information under state privacy laws.',
    functional: 'Functional', performance: 'Performance', advertisement: 'Advertisement',
  },
  nl: {
    title: 'Wij waarderen uw privacy',
    description: 'We gebruiken cookies om uw browse-ervaring te verbeteren, gepersonaliseerde advertenties of inhoud weer te geven en ons verkeer te analyseren. Door op "Accepteren" te klikken, stemt u in met ons gebruik van cookies.',
    acceptAll: 'Accepteren', rejectAll: 'Weigeren', customise: 'Voorkeuren', privacyPolicy: 'Privacybeleid',
    cookiePreferences: 'Cookievoorkeuren',
    managePreferences: 'Door te klikken gaat u akkoord met het opslaan van cookies op uw apparaat om de navigatie te verbeteren, het gebruik te analyseren en marketing te ondersteunen.',
    saveMyPreferences: 'Voorkeuren opslaan', alwaysActive: 'Altijd actief',
    essential: 'Strikt Noodzakelijk', marketing: 'Marketing', analytics: 'Analytisch', preferences: 'Voorkeuren',
    essentialDescription: 'Essentiële cookies maken basisfuncties van de site mogelijk, zoals beveiliging en toegankelijkheid. Ze slaan geen persoonlijke gegevens op en kunnen niet worden uitgeschakeld.',
    marketingDescription: 'Marketingcookies volgen bezoekers op websites om relevante, aantrekkelijke advertenties weer te geven.',
    analyticsDescription: 'Analytische cookies helpen ons te begrijpen hoe bezoekers omgaan met de website door anonieme gebruiksgegevens te verzamelen.',
    preferencesDescription: 'Voorkeurscookies laten de website uw instellingen en keuzes onthouden voor een persoonlijkere ervaring.',
    ccpaDescription: 'We gebruiken cookies om u de best mogelijke ervaring te bieden. Ze stellen ons ook in staat om gebruikersgedrag te analyseren om de website voortdurend voor u te verbeteren.',
    optOutPreference: 'Opt-outvoorkeur',
    ccpaOptOutPreferenceIntro: 'We gebruiken cookies van derden die ons helpen analyseren hoe u deze website gebruikt, uw voorkeuren op te slaan en de inhoud en advertenties te bieden die voor u relevant zijn. We verkopen uw informatie niet. U kunt deze cookies echter weigeren door Mijn persoonlijke gegevens niet delen aan te vinken en op de knop Mijn voorkeuren opslaan te klikken. Zodra u zich hebt afgemeld, kunt u zich op elk moment opnieuw aanmelden door het vinkje te verwijderen en opnieuw op te slaan.',
    doNotSell: 'Mijn persoonlijke gegevens niet delen', cancel: 'Annuleren',
    back: 'Terug', confirmChoice: 'Mijn keuze bevestigen',
    ccpaOptOut: 'We gebruiken cookies en vergelijkbare technologieën om uw ervaring te personaliseren en te verbeteren. Sommige daarvan kunnen onder Amerikaanse privacywetten gelden als "verkoop" of "delen" van uw persoonlijke gegevens.',
    functional: 'Functioneel', performance: 'Prestaties', advertisement: 'Advertenties',
  },
  fr: {
    title: frFix('title', 'Nous respectons votre vie privée'),
    description: 'Nous utilisons des cookies pour améliorer votre expérience de navigation, diffuser des publicités ou contenus personnalisés et analyser notre trafic. En cliquant sur « Accepter », vous consentez à notre utilisation des cookies.',
    acceptAll: 'Accepter', rejectAll: 'Refuser', customise: 'Préférences', privacyPolicy: 'Politique de confidentialité',
    cookiePreferences: 'Préférences de cookies',
    managePreferences: frFix('managePreferences', "En cliquant, vous acceptez de stocker des cookies sur votre appareil pour améliorer la navigation, analyser l'utilisation et soutenir le marketing."),
    saveMyPreferences: 'Valider mes choix', alwaysActive: 'Toujours actif',
    essential: 'Nécessaires', marketing: 'Marketing', analytics: 'Analytiques', preferences: 'Préférences',
    essentialDescription: "Les cookies essentiels activent les fonctions de base du site comme la sécurité et l'accessibilité. Ils ne stockent pas de données personnelles et ne peuvent pas être désactivés.",
    marketingDescription: 'Les cookies marketing suivent les visiteurs sur les sites web pour afficher des publicités pertinentes et attrayantes.',
    analyticsDescription: "Les cookies analytiques nous aident à comprendre comment les visiteurs interagissent avec le site web en collectant des données d'utilisation anonymes.",
    preferencesDescription: 'Les cookies de préférences permettent au site web de mémoriser vos paramètres et choix pour une expérience plus personnelle.',
    ccpaDescription: "Nous utilisons des cookies pour vous offrir la meilleure expérience possible. Ils nous permettent également d'analyser le comportement des utilisateurs afin d'améliorer constamment le site web pour vous.",
    optOutPreference: 'Préférence de désinscription',
    ccpaOptOutPreferenceIntro: 'Nous utilisons des cookies tiers qui nous aident à analyser votre utilisation de ce site web, à stocker vos préférences et à fournir le contenu et les publicités qui vous sont pertinents. Nous ne vendons pas vos informations. Cependant, vous pouvez refuser ces cookies en cochant Ne pas partager mes informations personnelles et en cliquant sur le bouton Enregistrer mes préférences. Une fois désinscrit, vous pouvez vous réinscrire à tout moment en décochant Ne pas partager mes informations personnelles et en cliquant sur le bouton Enregistrer mes préférences.',
    doNotSell: 'Ne pas partager mes informations personnelles', cancel: 'Annuler',
    back: 'Retour', confirmChoice: 'Confirmer mon choix',
    ccpaOptOut: 'Nous utilisons des cookies et des technologies similaires pour personnaliser et améliorer votre expérience. Certaines peuvent constituer une « vente » ou un « partage » de vos informations personnelles au sens des lois américaines sur la vie privée.',
    functional: 'Fonctionnels', performance: 'Performance', advertisement: 'Publicité',
  },
  de: {
    title: 'Wir schätzen Ihre Privatsphäre',
    description: 'Wir verwenden Cookies, um Ihr Surferlebnis zu verbessern, personalisierte Anzeigen oder Inhalte bereitzustellen und unseren Datenverkehr zu analysieren. Durch Klicken auf „Akzeptieren“ stimmen Sie unserer Verwendung von Cookies zu.',
    acceptAll: 'Akzeptieren', rejectAll: 'Ablehnen', customise: 'Einstellungen', privacyPolicy: 'Datenschutzrichtlinie',
    cookiePreferences: 'Cookie-Einstellungen',
    managePreferences: 'Durch Klicken stimmen Sie der Speicherung von Cookies auf Ihrem Gerät zu, um die Navigation zu verbessern, die Nutzung zu analysieren und Marketing zu unterstützen.',
    saveMyPreferences: 'Auswahl speichern', alwaysActive: 'Immer aktiv',
    essential: 'Unbedingt Notwendig', marketing: 'Marketing', analytics: 'Analyse', preferences: 'Präferenzen',
    essentialDescription: 'Wesentliche Cookies ermöglichen grundlegende Website-Funktionen wie Sicherheit und Barrierefreiheit. Sie speichern keine personenbezogenen Daten und können nicht deaktiviert werden.',
    marketingDescription: 'Marketing-Cookies verfolgen Besucher über Websites hinweg, um relevante und ansprechende Werbung anzuzeigen.',
    analyticsDescription: 'Analyse-Cookies helfen uns zu verstehen, wie Besucher mit der Website interagieren, indem anonyme Nutzungsdaten gesammelt werden.',
    preferencesDescription: 'Präferenz-Cookies ermöglichen es der Website, Ihre Einstellungen und Auswahl für ein persönlicheres Erlebnis zu speichern.',
    ccpaDescription: 'Wir verwenden Cookies, um Ihnen das bestmögliche Erlebnis zu bieten. Sie ermöglichen es uns außerdem, das Nutzerverhalten zu analysieren, um die Website kontinuierlich für Sie zu verbessern.',
    optOutPreference: 'Opt-out-Einstellung',
    ccpaOptOutPreferenceIntro: 'Wir verwenden Cookies von Drittanbietern, die uns helfen zu analysieren, wie Sie diese Website nutzen, Ihre Einstellungen zu speichern und die für Sie relevanten Inhalte und Werbeanzeigen bereitzustellen. Wir verkaufen Ihre Informationen nicht. Sie können diese Cookies jedoch ablehnen, indem Sie Meine personenbezogenen Daten nicht weitergeben ankreuzen und auf die Schaltfläche Meine Einstellungen speichern klicken. Sobald Sie sich abgemeldet haben, können Sie sich jederzeit wieder anmelden, indem Sie das Häkchen entfernen und erneut speichern.',
    doNotSell: 'Meine personenbezogenen Daten nicht weitergeben', cancel: 'Abbrechen',
    back: 'Zurück', confirmChoice: 'Auswahl bestätigen',
    ccpaOptOut: 'Wir verwenden Cookies und ähnliche Technologien, um Ihr Erlebnis zu personalisieren und zu verbessern. Einige davon können nach US-Datenschutzgesetzen als „Verkauf“ oder „Weitergabe“ Ihrer personenbezogenen Daten gelten.',
    functional: 'Funktional', performance: 'Leistung', advertisement: 'Werbung',
  },
  it: {
    title: 'Rispettiamo la tua privacy',
    description: 'Utilizziamo i cookie per migliorare la tua esperienza di navigazione, offrire annunci o contenuti personalizzati e analizzare il nostro traffico. Cliccando su «Accetta», acconsenti al nostro utilizzo dei cookie.',
    acceptAll: 'Accetta', rejectAll: 'Rifiuta', customise: 'Preferenze', privacyPolicy: 'Informativa sulla privacy',
    cookiePreferences: 'Preferenze sui cookie',
    managePreferences: "Cliccando, accetti di memorizzare i cookie sul tuo dispositivo per migliorare la navigazione, analizzare l'utilizzo e supportare il marketing.",
    saveMyPreferences: 'Salva preferenze', alwaysActive: 'Sempre attivo',
    essential: 'Necessari', marketing: 'Marketing', analytics: 'Analitica', preferences: 'Preferenze',
    essentialDescription: "I cookie essenziali abilitano le funzioni principali del sito come la sicurezza e l'accessibilità. Non memorizzano dati personali e non possono essere disattivati.",
    marketingDescription: 'I cookie di marketing tracciano i visitatori sui siti web per mostrare pubblicità pertinenti e coinvolgenti.',
    analyticsDescription: 'I cookie analitici ci aiutano a capire come i visitatori interagiscono con il sito web raccogliendo dati di utilizzo anonimi.',
    preferencesDescription: "I cookie di preferenza permettono al sito web di ricordare le tue impostazioni e scelte per un'esperienza più personale.",
    ccpaDescription: 'Utilizziamo i cookie per offrirti la migliore esperienza possibile. Ci permettono inoltre di analizzare il comportamento degli utenti per migliorare costantemente il sito web per te.',
    optOutPreference: 'Preferenza di rinuncia',
    ccpaOptOutPreferenceIntro: 'Utilizziamo cookie di terze parti che ci aiutano ad analizzare come utilizzi questo sito web, a memorizzare le tue preferenze e a fornire i contenuti e gli annunci pertinenti per te. Non vendiamo le tue informazioni. Tuttavia, puoi rinunciare a questi cookie selezionando Non condividere le mie informazioni personali e facendo clic sul pulsante Salva le mie preferenze. Dopo la rinuncia, puoi acconsentire nuovamente in qualsiasi momento deselezionando la casella e salvando di nuovo.',
    doNotSell: 'Non condividere le mie informazioni personali', cancel: 'Annulla',
    back: 'Indietro', confirmChoice: 'Conferma la mia scelta',
    ccpaOptOut: 'Utilizziamo cookie e tecnologie simili per personalizzare e migliorare la tua esperienza. Alcune di queste possono costituire una «vendita» o «condivisione» delle tue informazioni personali ai sensi delle leggi statunitensi sulla privacy.',
    functional: 'Funzionali', performance: 'Prestazioni', advertisement: 'Pubblicità',
  },
  pl: {
    title: 'Cenimy Twoją prywatność',
    description: 'Używamy plików cookie, aby ulepszyć Twoje doświadczenie przeglądania, wyświetlać spersonalizowane reklamy lub treści oraz analizować nasz ruch. Klikając „Akceptuj”, wyrażasz zgodę na używanie przez nas plików cookie.',
    acceptAll: 'Akceptuj', rejectAll: 'Odrzuć', customise: 'Preferencje', privacyPolicy: 'Polityka prywatności',
    cookiePreferences: 'Ustawienia plików cookie',
    managePreferences: 'Klikając, wyrażasz zgodę na przechowywanie plików cookie na Twoim urządzeniu w celu poprawy nawigacji, analizy użytkowania i wsparcia marketingu.',
    saveMyPreferences: 'Zapisz preferencje', alwaysActive: 'Zawsze aktywne',
    essential: 'Ściśle Niezbędne', marketing: 'Marketingowe', analytics: 'Analityczne', preferences: 'Preferencje',
    essentialDescription: 'Niezbędne pliki cookie umożliwiają podstawowe funkcje witryny, takie jak bezpieczeństwo i dostępność. Nie przechowują danych osobowych i nie można ich wyłączyć.',
    marketingDescription: 'Marketingowe pliki cookie śledzą odwiedzających w różnych witrynach, aby wyświetlać trafne i angażujące reklamy.',
    analyticsDescription: 'Analityczne pliki cookie pomagają nam zrozumieć, jak odwiedzający korzystają z witryny, zbierając anonimowe dane o użytkowaniu.',
    preferencesDescription: 'Pliki cookie preferencji pozwalają witrynie zapamiętać Twoje ustawienia i wybory, aby zapewnić bardziej spersonalizowane doświadczenie.',
    ccpaDescription: 'Używamy plików cookie, aby zapewnić Ci najlepsze możliwe doświadczenie. Pozwalają nam one również analizować zachowanie użytkowników, aby stale ulepszać stronę dla Ciebie.',
    optOutPreference: 'Preferencja rezygnacji',
    ccpaOptOutPreferenceIntro: 'Używamy zewnętrznych plików cookie, które pomagają nam analizować, jak korzystasz z tej witryny, przechowywać Twoje preferencje oraz dostarczać treści i reklamy, które są dla Ciebie istotne. Nie sprzedajemy Twoich informacji. Możesz jednak zrezygnować z tych plików cookie, zaznaczając Nie udostępniaj moich danych osobowych i klikając przycisk Zapisz moje preferencje. Po rezygnacji możesz w każdej chwili wyrazić zgodę ponownie, odznaczając to pole i zapisując ponownie.',
    doNotSell: 'Nie udostępniaj moich danych osobowych', cancel: 'Anuluj',
    back: 'Wstecz', confirmChoice: 'Potwierdź mój wybór',
    ccpaOptOut: 'Używamy plików cookie i podobnych technologii, aby personalizować i ulepszać Twoje doświadczenie. Niektóre z nich mogą stanowić „sprzedaż” lub „udostępnianie” Twoich danych osobowych w rozumieniu amerykańskich przepisów o prywatności.',
    functional: 'Funkcjonalne', performance: 'Wydajność', advertisement: 'Reklamowe',
  },
  pt: {
    title: 'Valorizamos a sua privacidade',
    description: 'Utilizamos cookies para melhorar a sua experiência de navegação, apresentar anúncios ou conteúdos personalizados e analisar o nosso tráfego. Ao clicar em «Aceitar», consente a nossa utilização de cookies.',
    acceptAll: 'Aceitar', rejectAll: 'Rejeitar', customise: 'Preferências', privacyPolicy: 'Política de privacidade',
    cookiePreferences: 'Preferências de cookies',
    managePreferences: 'Ao clicar, você concorda em armazenar cookies no seu dispositivo para melhorar a navegação, analisar o uso e apoiar o marketing.',
    saveMyPreferences: 'Salvar preferências', alwaysActive: 'Sempre ativo',
    essential: 'Necessários', marketing: 'Marketing', analytics: 'Analíticos', preferences: 'Preferências',
    essentialDescription: 'Os cookies essenciais permitem funções básicas do site, como segurança e acessibilidade. Não armazenam dados pessoais e não podem ser desativados.',
    marketingDescription: 'Os cookies de marketing rastreiam visitantes em diferentes sites para exibir anúncios relevantes e atrativos.',
    analyticsDescription: 'Os cookies analíticos ajudam-nos a entender como os visitantes interagem com o site, recolhendo dados de utilização anónimos.',
    preferencesDescription: 'Os cookies de preferências permitem que o site memorize as suas definições e escolhas para uma experiência mais personalizada.',
    ccpaDescription: 'Usamos cookies para lhe proporcionar a melhor experiência possível. Também nos permitem analisar o comportamento dos utilizadores para melhorar constantemente o site para si.',
    optOutPreference: 'Preferência de exclusão',
    ccpaOptOutPreferenceIntro: 'Usamos cookies de terceiros que nos ajudam a analisar como utiliza este site, a armazenar as suas preferências e a fornecer os conteúdos e anúncios que são relevantes para si. Não vendemos as suas informações. No entanto, pode recusar estes cookies marcando Não partilhar as minhas informações pessoais e clicando no botão Guardar as minhas preferências. Depois de recusar, pode voltar a aceitar a qualquer momento desmarcando a caixa e guardando novamente.',
    doNotSell: 'Não partilhar as minhas informações pessoais', cancel: 'Cancelar',
    back: 'Voltar', confirmChoice: 'Confirmar a minha escolha',
    ccpaOptOut: 'Usamos cookies e tecnologias semelhantes para personalizar e melhorar a sua experiência. Algumas podem constituir uma «venda» ou «partilha» das suas informações pessoais ao abrigo das leis de privacidade dos EUA.',
    functional: 'Funcionais', performance: 'Desempenho', advertisement: 'Publicidade',
  },
  es: {
    title: 'Valoramos su privacidad',
    description: 'Usamos cookies para mejorar su experiencia de navegación, mostrar anuncios o contenido personalizado y analizar nuestro tráfico. Al hacer clic en «Aceptar», acepta nuestro uso de cookies.',
    acceptAll: 'Aceptar', rejectAll: 'Rechazar', customise: 'Preferencias', privacyPolicy: 'Política de privacidad',
    cookiePreferences: 'Preferencias de cookies',
    managePreferences: 'Al hacer clic, acepta almacenar cookies en su dispositivo para mejorar la navegación, analizar el uso y respaldar el marketing.',
    saveMyPreferences: 'Guardar preferencias', alwaysActive: 'Siempre activo',
    essential: 'Necesarias', marketing: 'Marketing', analytics: 'Analíticas', preferences: 'Preferencias',
    essentialDescription: 'Las cookies esenciales habilitan funciones básicas del sitio como la seguridad y la accesibilidad. No almacenan datos personales y no se pueden desactivar.',
    marketingDescription: 'Las cookies de marketing rastrean a los visitantes en los sitios web para mostrar anuncios relevantes y atractivos.',
    analyticsDescription: 'Las cookies analíticas nos ayudan a comprender cómo interactúan los visitantes con el sitio web mediante la recopilación de datos de uso anónimos.',
    preferencesDescription: 'Las cookies de preferencias permiten que el sitio web recuerde su configuración y elecciones para una experiencia más personal.',
    ccpaDescription: 'Utilizamos cookies para brindarle la mejor experiencia posible. También nos permiten analizar el comportamiento de los usuarios para mejorar constantemente el sitio web para usted.',
    optOutPreference: 'Preferencia de exclusión',
    ccpaOptOutPreferenceIntro: 'Usamos cookies de terceros que nos ayudan a analizar cómo usa este sitio web, almacenar sus preferencias y proporcionar el contenido y los anuncios relevantes para usted. No vendemos su información. Sin embargo, puede excluir estas cookies marcando No compartir mi información personal y haciendo clic en el botón Guardar mis preferencias. Una vez que se excluya, puede volver a incluirse en cualquier momento desmarcando No compartir mi información personal y haciendo clic en el botón Guardar mis preferencias.',
    doNotSell: 'No compartir mi información personal', cancel: 'Cancelar',
    back: 'Atrás', confirmChoice: 'Confirmar mi elección',
    ccpaOptOut: 'Usamos cookies y tecnologías similares para personalizar y mejorar su experiencia. Algunas pueden constituir una «venta» o «intercambio» de su información personal según las leyes de privacidad de EE. UU.',
    functional: 'Funcionales', performance: 'Rendimiento', advertisement: 'Publicidad',
  },
  sv: {
    title: 'Vi värnar om din integritet',
    description: 'Vi använder cookies för att förbättra din surfupplevelse, visa personanpassade annonser eller innehåll och analysera vår trafik. Genom att klicka på ”Acceptera” samtycker du till vår användning av cookies.',
    acceptAll: 'Acceptera', rejectAll: 'Avvisa', customise: 'Inställningar', privacyPolicy: 'Integritetspolicy',
    cookiePreferences: 'Cookie-inställningar',
    managePreferences: 'Genom att klicka godkänner du att cookies lagras på din enhet för att förbättra navigeringen, analysera användningen och stödja marknadsföring.',
    saveMyPreferences: 'Spara preferenser', alwaysActive: 'Alltid aktiv',
    essential: 'Strikt Nödvändiga', marketing: 'Marknadsföring', analytics: 'Analytik', preferences: 'Inställningar',
    essentialDescription: 'Nödvändiga cookies möjliggör grundläggande webbplatsfunktioner som säkerhet och tillgänglighet. De lagrar inga personuppgifter och kan inte inaktiveras.',
    marketingDescription: 'Marknadsföringscookies spårar besökare över webbplatser för att visa relevanta och engagerande annonser.',
    analyticsDescription: 'Analyscookies hjälper oss att förstå hur besökare interagerar med webbplatsen genom att samla in anonym användningsdata.',
    preferencesDescription: 'Inställningscookies låter webbplatsen komma ihåg dina val och inställningar för en mer personlig upplevelse.',
    ccpaDescription: 'Vi använder cookies för att ge dig bästa möjliga upplevelse. De gör det också möjligt för oss att analysera användarbeteende för att ständigt förbättra webbplatsen för dig.',
    optOutPreference: 'Avanmälningsinställning',
    ccpaOptOutPreferenceIntro: 'Vi använder tredjepartscookies som hjälper oss att analysera hur du använder den här webbplatsen, lagra dina inställningar och tillhandahålla innehåll och annonser som är relevanta för dig. Vi säljer inte dina uppgifter. Du kan dock välja bort dessa cookies genom att markera Dela inte mina personuppgifter och klicka på knappen Spara mina inställningar. När du har valt bort dem kan du när som helst välja in igen genom att avmarkera rutan och spara på nytt.',
    doNotSell: 'Dela inte mina personuppgifter', cancel: 'Avbryt',
    back: 'Tillbaka', confirmChoice: 'Bekräfta mitt val',
    ccpaOptOut: 'Vi använder cookies och liknande tekniker för att anpassa och förbättra din upplevelse. Vissa av dem kan räknas som ”försäljning” eller ”delning” av dina personuppgifter enligt amerikanska integritetslagar.',
    functional: 'Funktionella', performance: 'Prestanda', advertisement: 'Reklam',
  },
};

// Not read by the GDPR/CCPA runtime today; kept so every set has every default key.
const UNUSED_KEYS = {
  en: { limitUse: 'Limit the use of my sensitive personal information', alwaysOn: 'always on' },
  nl: { limitUse: 'Het gebruik van mijn gevoelige persoonsgegevens beperken', alwaysOn: 'altijd aan' },
  fr: { limitUse: 'Limiter l’utilisation de mes informations personnelles sensibles', alwaysOn: 'toujours actifs' },
  de: { limitUse: 'Verwendung meiner sensiblen personenbezogenen Daten einschränken', alwaysOn: 'immer aktiv' },
  it: { limitUse: 'Limita l’uso delle mie informazioni personali sensibili', alwaysOn: 'sempre attivi' },
  pl: { limitUse: 'Ogranicz wykorzystanie moich wrażliwych danych osobowych', alwaysOn: 'zawsze włączone' },
  pt: { limitUse: 'Limitar a utilização das minhas informações pessoais sensíveis', alwaysOn: 'sempre ativos' },
  es: { limitUse: 'Limitar el uso de mi información personal sensible', alwaysOn: 'siempre activas' },
  sv: { limitUse: 'Begränsa användningen av mina känsliga personuppgifter', alwaysOn: 'alltid på' },
};

function toTextSet(code, r) {
  return {
    languageSelected: code,
    ...UNUSED_KEYS[code],
    ...r,
    // The runtime's save button and the preference center's save share one label.
    save: r.saveMyPreferences,
    strictlyNecessary: '',
  };
}

/**
 * Text sets keyed by lowercase locale: the 9 Designer App languages plus 'pt-br'.
 * Every key the GDPR/CCPA runtime reads is present, so W()'s per-key fallback to
 * TRANSLATIONS.en (the published language) never mixes two languages on one banner.
 */
export const LOCALE_TRANSLATIONS = (() => {
  const out = {};
  for (const code of Object.keys(RAW)) out[code] = toTextSet(code, RAW[code]);
  const { refusalConsequences, ...ptBr } = PT_BR_TRANSLATIONS; // banner has no slot for it
  out['pt-br'] = { ...ptBr, languageSelected: 'pt' };
  return out;
})();
