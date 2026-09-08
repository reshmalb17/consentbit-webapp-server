/**
 * TCF String Manager
 * Exposes a TCF v2.2-compatible __tcfapi bridge and stores consent locally.
 */
function mapPreferencesToGoogle(preferences) {
  if (!preferences) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () {
    window.dataLayer.push(arguments);
  };

  const categories = preferences.cookieCategories || {};
  const purposes = preferences.purposes || {};
  const googleVendorAllowed = preferences.vendors?.__755?.consent === true;

  const analyticsEnabled = categories.analytics?.enabled === true;
  const adsEnabled = categories.advertisement?.enabled === true;
  const p1 = purposes.purpose1?.consent === true;
  const p3 = purposes.purpose3?.consent === true;
  const p4 = purposes.purpose4?.consent === true;

  window.gtag('consent', 'update', {
    analytics_storage: analyticsEnabled && p1 && googleVendorAllowed ? 'granted' : 'denied',
    ad_storage: adsEnabled && p1 && googleVendorAllowed ? 'granted' : 'denied',
    ad_user_data: adsEnabled && p3 && googleVendorAllowed ? 'granted' : 'denied',
    ad_personalization: adsEnabled && p4 && googleVendorAllowed ? 'granted' : 'denied'
  });
}

/**
 * Languages the banner offers. Every entry is served by the worker's
 * /gvl/purposes-[LANG].json route. Two-letter codes only — the TCF core
 * validates against its 2-char consentLanguages set, so regional variants
 * (pt-br, pt-pt) are rejected client-side before a request is ever made.
 * The worker resolves 'pt' to European Portuguese on our behalf.
 */
const SUPPORTED_LANGUAGES = ['en', 'nl', 'fr', 'de', 'it', 'pl', 'pt', 'es', 'sv'];

/**
 * Resolve the banner language the same way the GDPR/CCPA loader does.
 *
 * Reads window.__CONSENT_SITE__, which the CDN emits inline immediately ahead of
 * the banner script that injects this file — so it is always populated by the
 * time this runs. Keeping the lookup here, rather than baking a value in, is
 * what lets one shared copy of this file serve every site.
 *
 * Priority: manual override → browser language (when the dashboard's
 * auto-detect toggle is on) → the language selected in the dashboard.
 * resolveLanguage() clamps whatever comes back to a language we actually ship.
 */
function detectLanguage() {
  const site = (typeof window !== 'undefined' && window.__CONSENT_SITE__) || {};
  const custom = site.customization || {};

  // Manual override — set window.__cbIabLanguage before this script loads.
  if (typeof window !== 'undefined' && window.__cbIabLanguage) {
    return String(window.__cbIabLanguage);
  }

  // Auto-detect: follow the visitor's browser, English when we don't ship
  // their language. Mirrors R() in the standard loader.
  if (custom.autoDetectLanguage === true) {
    const nav = (navigator.language || navigator.userLanguage || 'en')
      .split('-')[0]
      .toLowerCase();
    return SUPPORTED_LANGUAGES.includes(nav) ? nav : 'en';
  }

  return custom.language || 'en';
}

class TCFManager {
  constructor() {
    this.tcModel = null;
    this.gvl = null;
    // Translated GVL fields the bundled TCF core drops on load, held here
    // instead of on the GVL itself — see loadExtraTranslations().
    this.dataCategories = null;
    this.standardTexts = null;
    this.tcString = '';
    this.isInitialized = false;
    this.eventListeners = [];
    this.listenerId = 0;

    this.config = {
      cmpId: 502,
      cmpVersion: 1,
      consentScreen: 1,
      // Resolved per-site from window.__CONSENT_SITE__ — see detectLanguage().
      // To test a language: set window.__cbIabLanguage = 'de' before this script
      // loads, or call window.tcfManager.setLanguage('de') at runtime (no reload).
      language: detectLanguage(),
      // Derived from `language` — never set this by hand. It is encoded into the
      // TC string to record which language the user actually read the notice in.
      consentLanguage: 'EN',
      policyVersion: 5,
      publisherCountryCode: 'IN',
      // Translation-capable worker: same vendor-list/ATP routes as the previous
      // worker, plus /gvl/purposes-[LANG].json for GVL.changeLanguage().
      gvlUrl: 'https://weathered-surf-ae57.narendra-3c5.workers.dev/gvl',
      storageKey: 'cookieConsentPrefs',
      tcStringKey: 'TCF_TC_STRING'
    };

    this.setupTCFApiStub();
  }

  async initialize() {
    if (!window.IABTCF || !window.IABTCF.TCModel || !window.IABTCF.TCString || !window.IABTCF.GVL) {
      console.error('IAB TCF bundle not loaded.');
      return false;
    }

    const { GVL } = window.IABTCF;
    GVL.baseUrl = this.config.gvlUrl;
    this.gvl = new GVL();

    try {
      await this.gvl.readyPromise;

      // Must run BEFORE the TC model is built: changeLanguage() swaps the GVL's
      // purpose/feature text, and createBaseTCModel() stamps consentLanguage
      // into the encoded string.
      await this.applyLanguage(this.config.language);

      const existingConsent = this.loadStoredConsent();
      if (existingConsent) {
        await this.applyStoredConsent(existingConsent);
      } else {
        await this.createDefaultTCModel();
      }

      this.isInitialized = true;
      this.notifyEventListeners(existingConsent ? 'tcloaded' : 'cmpuishown');
      return true;
    } catch (error) {
      console.error('Failed to initialize TCF Manager:', error);
      return false;
    }
  }

  /**
   * Normalise any input to a supported two-letter code, falling back to English.
   * Accepts browser-style tags too ('de-AT' → 'de', 'pt-BR' → 'pt').
   */
  resolveLanguage(input) {
    const raw = String(input || '').trim().toLowerCase();
    if (SUPPORTED_LANGUAGES.includes(raw)) return raw;
    const base = raw.split(/[-_]/)[0];
    if (SUPPORTED_LANGUAGES.includes(base)) return base;
    return 'en';
  }

  /**
   * Load the GVL's translated declaration text. Replaces purposes,
   * specialPurposes, features, specialFeatures and stacks in place; vendor names
   * are proper nouns and are never translated.
   *
   * Does NOT rebuild the TC model — initialize() does that immediately after,
   * and setLanguage() handles it for runtime switches.
   */
  async applyLanguage(language) {
    const lang = this.resolveLanguage(language);
    this.config.language = lang;
    this.config.consentLanguage = lang.toUpperCase();

    if (!this.gvl) return false;

    try {
      // No-op inside the library when the GVL is already in this language, so
      // the default ('en') costs no extra request.
      await this.gvl.changeLanguage(lang);
      await this.loadExtraTranslations(lang);
      return true;
    } catch (error) {
      // Fall back to English rather than leaving the banner with no text at all.
      //
      // The revert is not optional. changeLanguage() assigns its internal lang_
      // BEFORE fetching, so a failed request leaves the GVL flagged as the new
      // language while still holding English text — and TCString.encode() reads
      // consentLanguage off that flag, not off our config. Without this the TC
      // string would claim the notice was read in a language it was not shown in.
      console.error('Failed to load GVL translation for "' + lang + '":', error);
      try {
        await this.gvl.changeLanguage('en'); // served from the library's LANGUAGE_CACHE
      } catch (revertError) {
        console.error('Failed to revert GVL to English:', revertError);
      }
      this.config.language = 'en';
      this.config.consentLanguage = 'EN';
      this.dataCategories = null;
      this.standardTexts = null;
      return false;
    }
  }

  /**
   * Recover the translated GVL fields the bundled TCF core throws away.
   *
   * Its populate() copies only purposes, specialPurposes, features,
   * specialFeatures and stacks — so gvl.dataCategories and gvl.standardTexts
   * are never set, and the banner silently falls back to English no matter
   * which language is active. Both fields ARE present in the language file, so
   * we read the same URL ourselves:
   *
   *   dataCategories — vendor accordion, "Categories of data collected"
   *   standardTexts  — the TCF v2.4 standard feature explanation
   *
   * The core has just fetched this URL, so it normally comes from the HTTP
   * cache. Best-effort: on failure both stay null and the banner keeps its
   * hardcoded English fallbacks.
   */
  async loadExtraTranslations(lang) {
    try {
      const response = await fetch(this.config.gvlUrl + '/purposes-' + lang + '.json');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      this.dataCategories = (data && data.dataCategories) || null;
      this.standardTexts = (data && data.standardTexts) || null;
    } catch (error) {
      this.dataCategories = null;
      this.standardTexts = null;
      console.error('Failed to load extra GVL translations for "' + lang + '":', error);
    }
  }

  /**
   * Switch language at runtime. Reloads the translated GVL, re-encodes the TC
   * string with the new consentLanguage, and re-renders the vendor list.
   *
   *   await window.tcfManager.setLanguage('de');
   */
  async setLanguage(language) {
    const ok = await this.applyLanguage(language);

    if (this.isInitialized) {
      const stored = this.loadStoredConsent();
      if (stored) await this.applyStoredConsent(stored);
      else await this.createDefaultTCModel();

      await this.refreshTranslatedUI();
      this.notifyEventListeners('tcloaded');
    }

    return ok;
  }

  /**
   * Re-render every part of the banner that reads from the GVL. These are all
   * top-level functions in the generated banner script, so they land on window;
   * each call is guarded because Tcfmanager.js can be loaded without the banner.
   *
   * Mirrors the init sequence: rebuilding the purpose accordions replaces the
   * container's innerHTML, which destroys the toggle inputs, so group toggles
   * must be re-bound and the user's saved state re-applied afterwards or the
   * checkboxes come back blank.
   */
  async refreshTranslatedUI() {
    const run = (name) => {
      try {
        if (typeof window[name] === 'function') return window[name]();
      } catch (error) {
        console.error('Language refresh — ' + name + '() failed:', error);
      }
      return undefined;
    };

    // applyStaticStrings() must come first: it replaces containers holding the
    // spans updateDynamicCounts() fills, so the counts have to be written after.
    run('applyStaticStrings');
    run('rebuildPurposeAccordionsFromGvl');
    try {
      if (typeof window.initCookieAccordions === 'function') window.initCookieAccordions(true);
    } catch (error) {
      console.error('Language refresh — initCookieAccordions() failed:', error);
    }
    run('initGroupToggles');
    run('loadExistingPreferences');
    run('updateDynamicCounts');
    await run('loadVendors');
  }

  setupTCFApiStub() {
    if (!window.frames.__tcfapiLocator) {
      this.addTCFLocatorFrame();
    }

    if (!window.__tcfapiMessageHandlerAttached) {
      window.addEventListener('message', (event) => this.handlePostMessage(event));
      window.__tcfapiMessageHandlerAttached = true;
    }

    if (typeof window.__tcfapi === 'function' && window.__tcfapi.__tcfManagerInstalled) {
      return;
    }

    window.__tcfapi = (command, version, callback, parameter) => {
      if (typeof callback !== 'function') return;

      if (command === 'ping') {
        const hasStoredConsent = !!this.loadStoredConsent();
        callback({
          gdprApplies: true,
          cmpLoaded: this.isInitialized,
          cmpStatus: this.isInitialized ? 'loaded' : 'loading',
          displayStatus: hasStoredConsent ? 'hidden' : 'visible',
          apiVersion: '2.2',
          cmpVersion: this.config.cmpVersion,
          cmpId: this.config.cmpId,
          gvlVersion: this.gvl ? this.gvl.vendorListVersion : undefined,
          tcfPolicyVersion: this.config.policyVersion
        }, true);
        return;
      }

      if (command === 'addEventListener') {
        const listenerId = ++this.listenerId;
        this.eventListeners.push({ callback, listenerId });
        callback({ ...this.getTCData(undefined, listenerId) }, true);
        return;
      }

      if (command === 'removeEventListener') {
        const index = this.eventListeners.findIndex((listener) => listener.listenerId === parameter);
        if (index > -1) {
          this.eventListeners.splice(index, 1);
          callback(true, true);
          return;
        }
        callback(false, false);
        return;
      }

      if (command === 'getTCData') {
        callback(this.getTCData(parameter), this.isInitialized);
        return;
      }

      if (command === 'getVendorList') {
        callback(this.getVendorListResponse(), !!this.gvl);
        return;
      }

      callback(null, false);
    };

    window.__tcfapi.a = [];
    window.__tcfapi.__tcfManagerInstalled = true;
  }

  addTCFLocatorFrame() {
    const createFrame = () => {
      if (window.frames.__tcfapiLocator || !document.body) return;
      const iframe = document.createElement('iframe');
      iframe.name = '__tcfapiLocator';
      iframe.title = '__tcfapiLocator';
      iframe.style.cssText = 'display:none';
      document.body.appendChild(iframe);
    };

    if (document.body) {
      createFrame();
    } else {
      document.addEventListener('DOMContentLoaded', createFrame, { once: true });
    }
  }

  handlePostMessage(event) {
    const payload = event?.data;
    if (!payload) return;

    let message = payload;
    let stringifyResponse = false;

    if (typeof payload === 'string') {
      try {
        message = JSON.parse(payload);
        stringifyResponse = true;
      } catch (_error) {
        return;
      }
    }

    const call = message?.__tcfapiCall;
    if (!call) return;

    window.__tcfapi(call.command, call.version, (returnValue, success) => {
      const response = {
        __tcfapiReturn: {
          returnValue: this.serializeForPostMessage(returnValue),
          success,
          callId: call.callId
        }
      };

      if (event.source && typeof event.source.postMessage === 'function') {
        event.source.postMessage(stringifyResponse ? JSON.stringify(response) : response, '*');
      }
    }, call.parameter);
  }

  serializeForPostMessage(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'function') return undefined;
    if (typeof Promise !== 'undefined' && value instanceof Promise) return undefined;

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_error) {
      return this.deepSanitize(value, new WeakSet());
    }
  }

  deepSanitize(value, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'function') return undefined;
    if (typeof Promise !== 'undefined' && value instanceof Promise) return undefined;
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return undefined;

    seen.add(value);

    if (Array.isArray(value)) {
      return value
        .map((item) => this.deepSanitize(item, seen))
        .filter((item) => item !== undefined);
    }

    const output = {};
    Object.keys(value).forEach((key) => {
      const sanitized = this.deepSanitize(value[key], seen);
      if (sanitized !== undefined) {
        output[key] = sanitized;
      }
    });
    return output;
  }

  createBaseTCModel() {
    const { TCModel } = window.IABTCF;
    const model = new TCModel(this.gvl);

    model.cmpId = this.config.cmpId;
    model.cmpVersion = this.config.cmpVersion;
    model.consentScreen = this.config.consentScreen;
    model.consentLanguage = this.config.consentLanguage;
    model.vendorListVersion = this.gvl.vendorListVersion;
    model.policyVersion = this.config.policyVersion;
    model.isServiceSpecific = true;
    model.useNonStandardStacks = false;
    model.useNonStandardTexts = false;
    model.purposeOneTreatment = false;
    model.publisherCountryCode = this.config.publisherCountryCode;

    return model;
  }

  getVendorListResponse() {
    if (!this.gvl) return null;

    const rawVendorList = typeof this.gvl.getJson === 'function'
      ? this.gvl.getJson()
      : this.gvl;

    return this.serializeForPostMessage({
      gvlSpecificationVersion: rawVendorList.gvlSpecificationVersion,
      vendorListVersion: rawVendorList.vendorListVersion || this.gvl.vendorListVersion,
      tcfPolicyVersion: rawVendorList.tcfPolicyVersion || this.config.policyVersion,
      lastUpdated: rawVendorList.lastUpdated,
      purposes: rawVendorList.purposes || {},
      specialPurposes: rawVendorList.specialPurposes || {},
      features: rawVendorList.features || {},
      specialFeatures: rawVendorList.specialFeatures || {},
      stacks: rawVendorList.stacks || {},
      vendors: rawVendorList.vendors || this.gvl.vendors || {}
    });
  }

  async createDefaultTCModel() {
    const { TCString } = window.IABTCF;
    this.tcModel = this.createBaseTCModel();
    this.applyDisclosedVendors();
    this.tcString = TCString.encode(this.tcModel, { segments: this.getEncodeSegments() });
    this.persistTCString();

    if (typeof window.gtag === 'function') {
      window.gtag('consent', 'default', {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied'
      });
    }
  }

  loadStoredConsent() {
    try {
      const stored = localStorage.getItem(this.config.storageKey);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      console.error('Failed to load stored consent:', error);
      return null;
    }
  }

  async applyStoredConsent(preferences) {
    const { TCString } = window.IABTCF;
    this.tcModel = this.createBaseTCModel();

    this.applyPurposeSection(preferences.purposes || {});
    this.applySpecialFeatures(preferences.specialFeatures || {});
    this.applyVendors(preferences.vendors || {});
    this.applyDisclosedVendors();

    this.tcString = TCString.encode(this.tcModel, { segments: this.getEncodeSegments() });
    this.persistTCString();
    mapPreferencesToGoogle(preferences);
  }

  getEncodeSegments() {
    return ['core', 'vendorsDisclosed', 'publisherTC'];
  }

  applyDisclosedVendors() {
    if (!this.gvl?.vendors || !this.tcModel?.vendorsDisclosed) return;

    Object.keys(this.gvl.vendors).forEach((vendorId) => {
      this.tcModel.vendorsDisclosed.set(Number(vendorId));
    });
  }

  applyPurposeSection(purposes) {
    Object.entries(purposes).forEach(([key, value]) => {
      if (!key.startsWith('purpose')) return;
      const purposeId = Number(key.replace('purpose', ''));
      if (!Number.isInteger(purposeId) || !this.isValidPurposeId(purposeId)) return;

      if (value.consent === true) this.tcModel.purposeConsents.set(purposeId);
      else this.tcModel.purposeConsents.unset(purposeId);

      if (value.legitimate === true && this.purposeSupportsLegitimateInterest(purposeId)) {
        this.tcModel.purposeLegitimateInterests.set(purposeId);
      }
      else this.tcModel.purposeLegitimateInterests.unset(purposeId);
    });
  }

  applySpecialFeatures(features) {
    Object.entries(features).forEach(([key, value]) => {
      if (!key.startsWith('special-feature')) return;
      const featureId = Number(key.replace('special-feature', ''));
      if (!Number.isInteger(featureId) || !this.isValidSpecialFeatureId(featureId)) return;

      if (value.consent === true) this.tcModel.specialFeatureOptins.set(featureId);
      else this.tcModel.specialFeatureOptins.unset(featureId);
    });
  }

  applyVendors(vendors) {
    Object.entries(vendors).forEach(([rawId, value]) => {
      const vendorId = Number(String(rawId).replace('__', '').trim());
      if (!Number.isInteger(vendorId) || vendorId <= 0) return;

      if (value.consent === true && this.vendorSupportsConsent(vendorId)) this.tcModel.vendorConsents.set(vendorId);
      else this.tcModel.vendorConsents.unset(vendorId);

      if (value.legitimateInterest === true && this.vendorSupportsLegitimateInterest(vendorId)) {
        this.tcModel.vendorLegitimateInterests.set(vendorId);
      }
      else this.tcModel.vendorLegitimateInterests.unset(vendorId);
    });
  }

  persistTCString() {
    localStorage.setItem(this.config.tcStringKey, this.tcString);
    this.setCookie('euconsent-v2', this.tcString);
  }

  async saveConsent(preferences) {
    preferences.timestamp = new Date().toISOString();
    localStorage.setItem(this.config.storageKey, JSON.stringify(preferences));
    await this.applyStoredConsent(preferences);
    this.notifyEventListeners('useractioncomplete');
  }

  getTCData(vendorIds, listenerId) {
    const hasStoredConsent = !!this.loadStoredConsent();
    const eventStatus = hasStoredConsent
      ? 'tcloaded'
      : (this.isInitialized ? 'cmpuishown' : 'stub');
    const normalizedVendorIds = Array.isArray(vendorIds)
      ? vendorIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : null;
    const tcData = {
      tcString: this.tcString || '',
      addtlConsent: this.getAddtlConsent(),
      tcfPolicyVersion: this.config.policyVersion,
      cmpId: this.config.cmpId,
      cmpVersion: this.config.cmpVersion,
      gdprApplies: true,
      cmpStatus: this.isInitialized ? 'loaded' : 'loading',
      eventStatus,
      isServiceSpecific: true,
      useNonStandardTexts: false,
      useNonStandardStacks: false,
      publisherCC: this.config.publisherCountryCode,
      purposeOneTreatment: !!this.tcModel?.purposeOneTreatment,
      purpose: {
        consents: this.createVectorField(this.tcModel?.purposeConsents, this.getAllPurposeIds()),
        legitimateInterests: this.createVectorField(this.tcModel?.purposeLegitimateInterests, this.getAllPurposeIds())
      },
      vendor: {
        consents: this.createVectorField(this.tcModel?.vendorConsents, normalizedVendorIds || this.getAllVendorIds()),
        legitimateInterests: this.createVectorField(this.tcModel?.vendorLegitimateInterests, normalizedVendorIds || this.getAllVendorIds()),
        disclosedVendors: this.createVectorField(this.tcModel?.vendorsDisclosed, normalizedVendorIds || this.getAllVendorIds())
      },
      specialFeatureOptins: this.createVectorField(this.tcModel?.specialFeatureOptins, this.getAllSpecialFeatureIds()),
      publisher: {
        consents: this.createVectorField(this.tcModel?.publisherConsents),
        legitimateInterests: this.createVectorField(this.tcModel?.publisherLegitimateInterests),
        customPurpose: {
          consents: this.createVectorField(this.tcModel?.publisherCustomConsents),
          legitimateInterests: this.createVectorField(this.tcModel?.publisherCustomLegitimateInterests)
        },
        restrictions: this.createRestrictions(this.tcModel?.publisherRestrictions)
      }
    };

    if (typeof listenerId === 'number') {
      tcData.listenerId = listenerId;
    }

    if (this.tcModel && this.tcModel.isServiceSpecific === false) {
      tcData.outOfBand = {
        allowedVendors: this.createVectorField(this.tcModel?.vendorsAllowed, normalizedVendorIds || this.getAllVendorIds()),
        disclosedVendors: this.createVectorField(this.tcModel?.vendorsDisclosed, normalizedVendorIds || this.getAllVendorIds())
      };
    }

    return tcData;
  }

  getAddtlConsent() {
    // Google Additional Consent (AC) string — produced by the banner's AC layer
    // (window.__cbAcString) and stored in localStorage/cookie. Surfaced here so
    // Google's tags read it via getTCData().addtlConsent. Empty string when none.
    try {
      if (typeof window !== 'undefined' && window.__cbAcString) return window.__cbAcString;
      const ls = (typeof localStorage !== 'undefined') ? localStorage.getItem('cb_addtl_consent') : null;
      if (ls) return ls;
      const m = (typeof document !== 'undefined' && document.cookie)
        ? document.cookie.match(/(?:^|;\s*)addtl_consent=([^;]*)/) : null;
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) {
      return '';
    }
  }

  createVectorField(vector, ids) {
    if (!vector) return {};

    if (Array.isArray(ids) && ids.length > 0) {
      return ids.reduce((booleanVector, id) => {
        booleanVector[String(id)] = typeof vector.has === 'function' ? vector.has(Number(id)) : false;
        return booleanVector;
      }, {});
    }

    try {
      return [...vector].reduce((booleanVector, tuple) => {
        booleanVector[String(tuple[0])] = tuple[1];
        return booleanVector;
      }, {});
    } catch (_error) {
      const fallback = {};
      if (typeof vector.forEach === 'function') {
        vector.forEach((value, key) => {
          fallback[String(key)] = value;
        });
      }
      return fallback;
    }
  }

  createRestrictions(restrictionsVector) {
    const restrictions = {};
    if (!restrictionsVector || !restrictionsVector.numRestrictions || restrictionsVector.numRestrictions <= 0) {
      return restrictions;
    }

    const maxVendorId = typeof restrictionsVector.getMaxVendorId === 'function'
      ? restrictionsVector.getMaxVendorId()
      : 0;

    for (let vendorId = 1; vendorId <= maxVendorId; vendorId += 1) {
      const vendorRestrictions = typeof restrictionsVector.getRestrictions === 'function'
        ? restrictionsVector.getRestrictions(vendorId)
        : [];

      vendorRestrictions.forEach((entry) => {
        const purposeId = String(entry.purposeId);
        if (!restrictions[purposeId]) {
          restrictions[purposeId] = {};
        }
        restrictions[purposeId][String(vendorId)] = entry.restrictionType;
      });
    }

    return restrictions;
  }

  notifyEventListeners(eventStatus) {
    const tcData = { ...this.getTCData(), eventStatus };
    this.eventListeners.forEach((listener) => {
      try {
        listener.callback({ ...tcData, listenerId: listener.listenerId }, true);
      } catch (error) {
        console.error('Failed to notify listener:', error);
      }
    });
  }

  async acceptAll() {
    const preferences = {
      cookieCategories: {
        necessary: { enabled: true, alwaysActive: true },
        analytics: { enabled: true, alwaysActive: false },
        performance: { enabled: true, alwaysActive: false },
        advertisement: { enabled: true, alwaysActive: false }
      },
      purposes: {},
      vendors: {},
      specialFeatures: {}
    };

    this.getAllPurposeIds().forEach((purposeId) => {
      preferences.purposes[`purpose${purposeId}`] = {
        consent: true,
        legitimate: this.purposeSupportsLegitimateInterest(purposeId)
      };
    });

    this.getAllSpecialFeatureIds().forEach((featureId) => {
      preferences.specialFeatures[`special-feature${featureId}`] = { consent: true };
    });

    if (this.gvl?.vendors) {
      Object.keys(this.gvl.vendors).forEach((vendorId) => {
        const numericVendorId = Number(vendorId);
        preferences.vendors[`__${vendorId}`] = {
          consent: this.vendorSupportsConsent(numericVendorId),
          legitimateInterest: this.vendorSupportsLegitimateInterest(numericVendorId)
        };
      });
    }

    await this.saveConsent(preferences);
  }

  async rejectAll() {
    const preferences = {
      cookieCategories: {
        necessary: { enabled: true, alwaysActive: true }
      },
      purposes: {},
      vendors: {},
      specialFeatures: {}
    };

    this.getAllPurposeIds().forEach((purposeId) => {
      preferences.purposes[`purpose${purposeId}`] = { consent: false, legitimate: false };
    });

    this.getAllSpecialFeatureIds().forEach((featureId) => {
      preferences.specialFeatures[`special-feature${featureId}`] = { consent: false };
    });

    if (this.gvl?.vendors) {
      Object.keys(this.gvl.vendors).forEach((vendorId) => {
        preferences.vendors[`__${vendorId}`] = { consent: false, legitimateInterest: false };
      });
    }

    await this.saveConsent(preferences);
  }

  getTCString() {
    return this.tcString;
  }

  setCookie(name, value, days = 365) {
    try {
      const expires = new Date(Date.now() + days * 864e5).toUTCString();
      document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=None; Secure`;
    } catch (error) {
      console.error('Failed to set cookie:', error);
    }
  }

  getVendors() {
    return this.gvl?.vendors || null;
  }

  getAllPurposeIds() {
    if (!this.gvl?.purposes) return [];
    return Object.keys(this.gvl.purposes)
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
  }

  getAllSpecialFeatureIds() {
    if (!this.gvl?.specialFeatures) return [];
    return Object.keys(this.gvl.specialFeatures)
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
  }

  getAllVendorIds() {
    if (!this.gvl?.vendors) return [];
    return Object.keys(this.gvl.vendors)
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
  }

  isValidPurposeId(purposeId) {
    return this.getAllPurposeIds().includes(purposeId);
  }

  isValidSpecialFeatureId(featureId) {
    return this.getAllSpecialFeatureIds().includes(featureId);
  }

  getVendorDeclaration(vendorId) {
    return this.gvl?.vendors?.[String(vendorId)] || this.gvl?.vendors?.[vendorId] || null;
  }

  vendorSupportsConsent(vendorId) {
    const vendor = this.getVendorDeclaration(vendorId);
    if (!vendor) return false;
    return this.hasItems(vendor.purposes) || this.hasItems(vendor.flexiblePurposes);
  }

  vendorSupportsLegitimateInterest(vendorId) {
    const vendor = this.getVendorDeclaration(vendorId);
    if (!vendor) return false;
    return this.hasItems(vendor.legIntPurposes) || this.hasItems(vendor.flexiblePurposes);
  }

  purposeSupportsLegitimateInterest(purposeId) {
    return this.getAllVendorIds().some((vendorId) => {
      const vendor = this.getVendorDeclaration(vendorId);
      if (!vendor) return false;
      return this.hasId(vendor.legIntPurposes, purposeId) || this.hasId(vendor.flexiblePurposes, purposeId);
    });
  }

  hasItems(value) {
    return Array.isArray(value) ? value.length > 0 : false;
  }

  hasId(value, id) {
    return Array.isArray(value) ? value.includes(id) : false;
  }

  hasConsent() {
    return !!this.loadStoredConsent();
  }
}

window.tcfManager = new TCFManager();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.tcfManager.initialize();
  });
} else {
  window.tcfManager.initialize();
}