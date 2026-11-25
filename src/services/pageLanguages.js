// Page-language banner (CookieYes-style), 2026-11-18. Essential + Growth.
//
// The banner follows the language of the PAGE, not the visitor's country or browser:
// the runtime reads window.CONSENTBIT_LANGUAGE (for pages with no lang attribute) or
// <html lang>, and if the site owner enabled that language it swaps in that language's
// text. No match, or the page is in the published language → the published text stays.
//
// Saved by the webapp banner editor (PageLanguagesCard.tsx) as
//   translations.config.pageLanguages = {
//     languages: ['fr', 'de', 'pt-br'],           // which languages to serve
//     text: { fr: { title: '…', acceptAll: '…' } } // owner's edits, per language
//   }
// Defaults per language come from data/localeTranslations.js (same sets the Webflow
// Localize test uses). Only the enabled languages are shipped, so a site with none
// pays nothing in script size.
//
// Gated in cdnM.js on env.PAGE_LANGUAGES === '1', the plan (Essential/Growth), not IAB
// (the IAB banner keeps its official translations), and no regional override (Quebec /
// Brazil "Regional requirements" wins, because that one is a legal requirement).

import { LOCALE_TRANSLATIONS } from '../data/localeTranslations.js';
import { EXTRA_PAGE_TRANSLATIONS } from '../data/pageLanguageTranslations.js';

// The 10 Designer-App languages + the page-only ones (31 more, 2026-11-18).
const ALL_SETS = { ...LOCALE_TRANSLATIONS, ...EXTRA_PAGE_TRANSLATIONS };

export const PAGE_LANGUAGE_PLANS = ['essential', 'growth'];

/** Language codes an owner may enable (lowercase, as matched against <html lang>). */
export const PAGE_LANGUAGE_CODES = Object.keys(ALL_SETS);

/**
 * Keys the owner may edit per language, with the max stored length. The runtime applies
 * its own display caps on top (title 30, category names 20, …); these only stop junk.
 */
export const PAGE_LANGUAGE_EDITABLE = {
  title: 30,
  description: 600,
  acceptAll: 40,
  rejectAll: 40,
  customise: 40,
  privacyPolicy: 30,
  cookiePreferences: 30,
  managePreferences: 600,
  saveMyPreferences: 40,
  essential: 20,
  marketing: 20,
  analytics: 20,
  preferences: 20,
  essentialDescription: 300,
  marketingDescription: 300,
  analyticsDescription: 300,
  preferencesDescription: 300,
  ccpaDescription: 600,
  doNotSell: 60,
};

/** Parse + clean translations.config.pageLanguages. Never throws; bad input → no languages. */
export function readPageLanguages(config) {
  const out = { languages: [], text: {} };
  try {
    const raw = config && config.pageLanguages;
    if (!raw || typeof raw !== 'object') return out;
    const langs = Array.isArray(raw.languages) ? raw.languages : [];
    for (const l of langs) {
      const code = String(l || '').trim().toLowerCase();
      if (PAGE_LANGUAGE_CODES.includes(code) && !out.languages.includes(code)) out.languages.push(code);
    }
    const text = raw.text && typeof raw.text === 'object' ? raw.text : {};
    for (const code of out.languages) {
      const t = text[code];
      if (!t || typeof t !== 'object') continue;
      const clean = {};
      for (const [k, max] of Object.entries(PAGE_LANGUAGE_EDITABLE)) {
        const v = t[k];
        if (typeof v === 'string' && v.trim()) clean[k] = v.trim().slice(0, max);
      }
      if (Object.keys(clean).length) out.text[code] = clean;
    }
  } catch (_) { /* fall through with what we have */ }
  return out;
}

/**
 * Text sets to ship, keyed by lowercase code. Each = built-in defaults for that language,
 * then the site's button on/off switches (they live in the published `en` set and the
 * runtime reads them from the active set), then the owner's own wording.
 * The published language itself is skipped: the page in that language keeps the owner's
 * main text.
 */
export function buildPageLanguageSets(pageLanguages, enText, textSetSwitches) {
  const sets = {};
  if (!pageLanguages || !pageLanguages.languages.length) return sets;
  const published = String((enText && enText.languageSelected) || 'en').toLowerCase();
  for (const code of pageLanguages.languages) {
    if (code === published) continue;
    const base = ALL_SETS[code];
    if (!base) continue;
    // pageLang: the exact tag for the banner lang attribute (pt-br, zh-tw).
    const set = { ...base, pageLang: code };
    for (const key of textSetSwitches || []) {
      if (enText && enText[key] != null) set[key] = enText[key];
    }
    const own = pageLanguages.text[code];
    if (own) {
      Object.assign(set, own);
      // The runtime's save button and the preference center's save share one label.
      if (own.saveMyPreferences) set.save = own.saveMyPreferences;
    }
    sets[code] = set;
  }
  return sets;
}

/**
 * Page languages are edited only in the webapp. The Webflow app and Framer plugin replace
 * the whole translations blob and don't know the key, so before a save that leaves
 * config.pageLanguages out, copy the saved value across. A webapp save always sends the
 * key (empty list = off), so it can still clear it. Mutates `customization`; never throws.
 *
 * The same applies to config.bannerRegion (where the GDPR / CCPA banner is shown; an object
 * since 2026-11-25, see cdnM.js "Banner region"; carried over whole):
 * also webapp-only, also always sent by a webapp save. Each key is carried independently.
 * So are config.gcmSupport / config.gcmTagsBeforeConsent (Google Consent Mode Advanced /
 * Basic / Off, 2026-11-25, see cdnM.js "gcmMode"): a plugin save must never silently put
 * a Basic or Off site back on Advanced.
 */
const WEBAPP_ONLY_CONFIG_KEYS = ['pageLanguages', 'bannerRegion', 'gcmSupport', 'gcmTagsBeforeConsent'];

export async function carryOverPageLanguages(db, siteId, customization) {
  try {
    if (!db || !siteId || !customization) return;
    let inTr = customization.translations;
    if (typeof inTr === 'string') { try { inTr = JSON.parse(inTr); } catch (_) { return; } }
    if (!inTr || typeof inTr !== 'object') return;
    const inCfg = inTr.config && typeof inTr.config === 'object' ? inTr.config : null;
    const missing = WEBAPP_ONLY_CONFIG_KEYS.filter((k) => !(inCfg && k in inCfg));
    if (!missing.length) return;
    const prevRow = await db
      .prepare('SELECT translations FROM BannerCustomization WHERE siteId = ?1 LIMIT 1')
      .bind(siteId)
      .first();
    if (!prevRow || !prevRow.translations) return;
    const prevTr = typeof prevRow.translations === 'string' ? JSON.parse(prevRow.translations) : prevRow.translations;
    const prevCfg = prevTr && prevTr.config;
    const carried = {};
    for (const k of missing) if (prevCfg && prevCfg[k]) carried[k] = prevCfg[k];
    if (!Object.keys(carried).length) return;
    inTr.config = { ...(inTr.config || {}), ...carried };
    customization.translations = inTr;
  } catch (e) {
    console.warn('[pageLanguages] carry-over failed (non-fatal)', e && e.message);
  }
}

/**
 * Runtime snippet, injected right after `var TRANSLATIONS = …;` where the runtime's
 * language (x) and auto-detect flag (C) are already declared. Exact code first
 * (pt-br), then the base (pt). Sets are keyed into TRANSLATIONS by the 2-letter base
 * because the runtime's own per-language maps use those.
 */
// Other spellings pages use for the same language → our code.
const PAGE_LANGUAGE_ALIASES = {
  nb: 'no', nn: 'no',
  'zh-hans': 'zh', 'zh-cn': 'zh', 'zh-sg': 'zh',
  'zh-hant': 'zh-tw', 'zh-hk': 'zh-tw', 'zh-mo': 'zh-tw',
  'sr-latn': 'sr', in: 'id', iw: 'he',
};

export function pageLanguageRuntime(sets, jsonForInlineScript) {
  if (!sets || !Object.keys(sets).length) return '';
  return (
    'var CB_PAGE_LANGS=' + jsonForInlineScript(sets) + ';' +
    '(function(){try{' +
      'var A=' + JSON.stringify(PAGE_LANGUAGE_ALIASES) + ';' +
      'var raw=String(window.CONSENTBIT_LANGUAGE||document.documentElement.getAttribute("lang")||"").trim().toLowerCase().replace(/_/g,"-");' +
      'var base=raw.split("-")[0];' +
      // zh-Hant-TW → zh-hant; exact, then alias, then base, then alias of base.
      'var two=raw.split("-").slice(0,2).join("-");' +
      'var s=raw&&(CB_PAGE_LANGS[raw]||CB_PAGE_LANGS[A[raw]]||CB_PAGE_LANGS[A[two]]||CB_PAGE_LANGS[base]||CB_PAGE_LANGS[A[base]]);' +
      'var L=String((TRANSLATIONS.en&&TRANSLATIONS.en.languageSelected)||"en");' +
      'if(s){var k=String(s.languageSelected||base).split("-")[0];TRANSLATIONS[k]=s;x=k;C=!1;L=s.pageLang||s.languageSelected||k;}' +
      // Mark the banner with the language it is in, so screen readers read it right
      // and CJK pages get the right glyphs. The banner is built after this runs.
      'var ids=["cb-initial-banner","cb-preferences-banner"];' +
      'var tag=function(){var n=0;for(var i=0;i<ids.length;i++){var el=document.getElementById(ids[i]);if(el){el.setAttribute("lang",L);n++}}return n};' +
      'if(tag()<ids.length&&window.MutationObserver){var mo=new MutationObserver(function(){if(tag()>=ids.length)mo.disconnect()});' +
      'mo.observe(document.documentElement,{childList:!0,subtree:!0});setTimeout(function(){mo.disconnect()},15000)}' +
    '}catch(e){}})();'
  );
}
