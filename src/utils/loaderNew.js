// @ts-nocheck
export function getLoaderScript(translationsVar) {
  return `! function () {
  var e = window.__CONSENT_SITE__ || {};
  var t = !0;
  ! function () {
    var n = e.registeredDomain;
    if (n) try {
      var a = window.location.hostname.replace(/^www\./, "").toLowerCase();
      if (a !== n && e.platform !== 'webflow' && !a.endsWith('.webflow.io')) {
        console.warn("[ConsentBit] Script is not authorized for this domain (" + a + "). Expected: " + n);
        window.__CONSENT_SITE__ = null;
        t = !1
      }
    } catch (e) {}
  }();
  if (t) {
    var n = e.floatingLogoUrl || "";
    var a = e.floatingLogoFallbackUrl || "";
    var r = e.id || null;
    var i = e.bannerType || "gdpr";
    var o = !1 !== e.bannerEnabled;
    var c = e.apiBase;
    var s = e.gaId || null;
    var l = e.customization || null;
    var d = !0 === e.pendingScan;
    var p = l && l.bannerLayoutVisual || "box";
    var b = l ? l.privacyPolicyUrl : null;
    var f = !!l && l.stopScroll;
    var m = !l || !1 !== l.animationEnabled;
    var u = l && l.bannerEntranceAnimation || "fade-in";
    var g = l && l.preferencePosition || "center";
    var v = l && l.centerAnimationDirection || "fade";
    var y = l && l.language || "en";
    var h = !!l && !0 === l.autoDetectLanguage;
    ${translationsVar}
    var x = ["customise", "rejectAll", "acceptAll", "save", "back", "doNotSell", "saveMyPreferences", "confirmChoice", "cancel", "optOutPreference"];
    var w = 30,
      k = 320,
      C = 20,
      E = 30,
      S = 200;
    var _ = 56;
    var I = "consentbit_" + r;
    var O = void 0 !== l && l && null != l.cookieExpirationDays ? Math.max(1, Math.min(365, Number(l.cookieExpirationDays) || 30)) : 30;
    var A = ee();
    var B = "consentbit_prefs_" + (r || "");
    var L = "cb_pv_over_limit_" + (r || "");
    var T = [];
    var z = !1;
    var N = null;
    var j = e.scriptBlockProviders || [];
    var P = e.customCookieRules || [];
    var F = [{
      domain: "facebook.com",
      category: "marketing"
    }, {
      domain: "facebook.net",
      category: "marketing"
    }, {
      domain: "adroll.com",
      category: "marketing"
    }, {
      domain: "doubleclick.net",
      category: "marketing"
    }, {
      domain: "googleadservices.com",
      category: "marketing"
    }, {
      domain: "bing.com",
      category: "marketing"
    }, {
      domain: "bat.bing.com",
      category: "marketing"
    }, {
      domain: "twitter.com",
      category: "marketing"
    }, {
      domain: "analytics.twitter.com",
      category: "marketing"
    }, {
      domain: "t.co",
      category: "marketing"
    }, {
      domain: "linkedin.com",
      category: "marketing"
    }, {
      domain: "ads.linkedin.com",
      category: "marketing"
    }, {
      domain: "pinterest.com",
      category: "marketing"
    }, {
      domain: "ct.pinterest.com",
      category: "marketing"
    }, {
      domain: "tiktok.com",
      category: "marketing"
    }, {
      domain: "analytics.tiktok.com",
      category: "marketing"
    }, {
      domain: "hotjar.com",
      category: "analytics"
    }, {
      domain: "clarity.ms",
      category: "analytics"
    }, {
      domain: "scorecardresearch.com",
      category: "analytics"
    }, {
      domain: "outbrain.com",
      category: "marketing"
    }, {
      domain: "taboola.com",
      category: "marketing"
    }, {
      domain: "criteo.com",
      category: "marketing"
    }, {
      domain: "criteo.net",
      category: "marketing"
    }, {
      domain: "quantserve.com",
      category: "analytics"
    }, {
      domain: "zemanta.com",
      category: "marketing"
    }];
    var D = ".cb-banner,.cb-banner *{box-sizing:border-box;}#cb-initial-banner.cb-banner{width:440px;min-width:280px;max-width:min(440px,92vw);max-height:min(80vh,420px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;bottom:32px;left:32px;right:auto;padding:16px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:inline-flex;flex-direction:column;align-items:stretch;font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px!important;line-height:1.5!important;}#cb-initial-banner.cb-banner .cb-banner-body{flex:0 1 auto;min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner{width:540px;max-width:92vw;max-height:min(85vh,580px);min-height:0;overflow:hidden;overflow-x:hidden;background-color:#ffffff;color:#334155;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:20px;border:1px solid #e2e8f0;border-radius:0.375rem;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);z-index:2147483647;display:flex;flex-direction:column;font-family:Montserrat,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px!important;line-height:1.5!important;}#cb-preferences-banner.cb-banner .cb-banner-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;}#cb-preferences-banner.cb-banner.prefs-left{left:32px;right:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-right{right:32px;left:auto;top:50%;transform:translateY(-50%);}#cb-preferences-banner.cb-banner.prefs-center{left:50%;top:50%;transform:translate(-50%,-50%);}.cb-banner-body{overflow-y:auto;overflow-x:hidden;margin-bottom:12px;}.cb-banner h3{margin:0 0 8px;font-size:16px!important;line-height:1.4!important;font-weight:600;color:#0f172a;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}#cb-initial-banner.cb-banner h3{font-size:16px!important;font-weight:600;color:rgba(0,0,0,0.8);padding-right:36px;}#cb-initial-banner.cb-banner .cb-banner-body > p{color:rgba(0,0,0,0.8);}.cb-gdpr-accordion{margin-top:4px;margin-bottom:4px;}.cb-gdpr-cat-label{color:#0f172a;}.cb-gdpr-cat-desc{color:#64748b;}.cb-banner p{margin:0 0 12px;font-size:14px!important;line-height:1.5!important;color:#334155;word-break:break-word;overflow-wrap:anywhere;max-width:100%;}.cb-banner-footer{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;align-items:center;}#cb-preferences-banner.cb-banner .cb-banner-footer{flex:0 0 auto;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:wrap;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}" + (l && "banner" === l.bannerLayoutVisual ? "#cb-initial-banner.cb-banner .cb-banner-footer{flex-wrap:nowrap;justify-content:flex-end;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:0 0 auto;width:auto;min-width:80px;max-width:140px;}" : "") + ".cb-banner button{padding:12px 32px;border-radius:0.375rem;cursor:pointer;font-size:14px;font-weight:600;border:1px solid #e2e8f0;transition:opacity 0.2s;white-space:normal;word-break:break-word;min-width:0;text-align:center;}@media (max-width:660px){#cb-initial-banner.cb-banner{width:100vw!important;max-width:100vw!important;left:0!important;right:0!important;bottom:0!important;transform:none!important;border-radius:0!important;border-left:none!important;border-right:none!important;border-bottom:none!important;}#cb-initial-banner.cb-banner .cb-banner-footer{flex-direction:column!important;align-items:stretch!important;}#cb-initial-banner.cb-banner .cb-banner-footer button{width:100%!important;min-width:0!important;box-sizing:border-box!important;}#cb-preferences-banner.cb-banner{width:calc(100vw - 32px)!important;max-width:calc(100vw - 32px)!important;padding:20px!important;}#cb-preferences-banner.cb-banner .cb-banner-footer{flex-direction:column!important;align-items:stretch!important;}#cb-preferences-banner.cb-banner .cb-banner-footer button{width:100%!important;min-width:0!important;box-sizing:border-box!important;}}@media (max-width:350px){#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{font-size:12px!important;}#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-size:13px!important;}#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,.cb-gdpr-cat-desc{font-size:12px!important;}#cb-initial-banner.cb-banner .cb-banner-footer button,#cb-preferences-banner.cb-banner .cb-banner-footer button{font-size:12px!important;padding:10px 16px!important;}}.cb-banner button:hover:not(.cb-pref-toggle-track){opacity:0.8;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track{display:block !important;width:40px !important;min-width:40px !important;height:22px !important;padding:0 !important;margin:0 !important;border:none !important;border-radius:11px !important;background:#d1d5db !important;box-shadow:none !important;flex-shrink:0 !important;position:relative !important;overflow:visible !important;box-sizing:border-box !important;cursor:pointer !important;appearance:none !important;-webkit-appearance:none !important;font-size:0 !important;line-height:0 !important;opacity:1 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']{background:#22c55e !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track::after{content:'' !important;position:absolute !important;top:2px !important;left:2px !important;width:18px !important;height:18px !important;border-radius:50% !important;background:#ffffff !important;box-shadow:0 1px 3px rgba(0,0,0,.2) !important;pointer-events:none !important;transition:left .15s ease !important;z-index:2 !important;}#cb-preferences-banner.cb-banner button.cb-pref-toggle-track[aria-checked='true']::after{left:20px !important;}.cb-banner button#cb-accept-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-reject-all-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}.cb-banner button#cb-preferences-btn,.cb-banner button#cb-ccpa-donotsell-link{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner button#cb-prefs-reject-btn{background-color:#007aff;color:#ffffff;border-color:#007aff;}#cb-preferences-banner.cb-banner:not(.cb-ccpa-prefs) .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}.cb-banner label{display:block;margin-bottom:6px;font-size:11px;color:#334155;}.cb-banner input[type='checkbox']{margin-right:6px;}.cb-banner a{color:#007aff;text-decoration:underline;font-size:inherit;}@keyframes slideInFromLeft{from{transform:translateX(-100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromRight{from{transform:translateX(100%);opacity:0;}to{transform:translateX(0);opacity:1;}}@keyframes slideInFromTop{from{transform:translateY(-100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes slideInFromBottom{from{transform:translateY(100%);opacity:0;}to{transform:translateY(0);opacity:1;}}@keyframes fadeIn{from{opacity:0;}to{opacity:1;}}@keyframes prefsSlideInFromLeft{from{transform:translate(-120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideInFromRight{from{transform:translate(120%,-50%);opacity:0;}to{transform:translate(0,-50%);opacity:1;}}@keyframes prefsSlideCenterFromBottom{from{transform:translate(-50%,calc(-50% + 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes prefsSlideCenterFromTop{from{transform:translate(-50%,calc(-50% - 28px));opacity:0;}to{transform:translate(-50%,-50%);opacity:1;}}@keyframes zoomIn{from{transform:scale(0.85);opacity:0;}to{transform:scale(1);opacity:1;}}@keyframes cbInitialCenterSlideFromBottom{from{transform:translate(-50%,100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterSlideFromTop{from{transform:translate(-50%,-100%);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}@keyframes cbInitialCenterZoomIn{from{transform:translateX(-50%) scale(0.85);opacity:0;}to{transform:translateX(-50%) scale(1);opacity:1;}}.cb-banner-animate-initial-center-bottom{animation:cbInitialCenterSlideFromBottom 0.35s ease-out;}.cb-banner-animate-initial-center-top{animation:cbInitialCenterSlideFromTop 0.35s ease-out;}.cb-banner-animate-initial-center-zoom{animation:cbInitialCenterZoomIn 0.3s ease-out;}@keyframes prefsZoomIn{from{transform:translate(-50%,-50%) scale(0.85);opacity:0;}to{transform:translate(-50%,-50%) scale(1);opacity:1;}}.cb-banner-animate-left{animation:slideInFromLeft 0.4s ease-out;}.cb-banner-animate-right{animation:slideInFromRight 0.4s ease-out;}.cb-banner-animate-top{animation:slideInFromTop 0.4s ease-out;}.cb-banner-animate-bottom{animation:slideInFromBottom 0.4s ease-out;}.cb-banner-animate-fade{animation:fadeIn 0.3s ease-out;}.cb-banner-animate-prefs-left{animation:prefsSlideInFromLeft 0.4s ease-out;}.cb-banner-animate-prefs-right{animation:prefsSlideInFromRight 0.4s ease-out;}.cb-banner-animate-center-top{animation:prefsSlideCenterFromTop 0.35s ease-out;}.cb-banner-animate-center-bottom{animation:prefsSlideCenterFromBottom 0.35s ease-out;}.cb-banner-animate-zoom-in{animation:zoomIn 0.3s ease-out;}.cb-banner-animate-prefs-zoom-in{animation:prefsZoomIn 0.3s ease-out;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-save-prefs-btn{background-color:#ffffff;color:#334155;border-color:#e2e8f0;}#cb-initial-banner.cb-banner .cb-banner-footer{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;flex-shrink:0;}#cb-initial-banner.cb-banner .cb-banner-footer button{flex:1 1 auto;min-width:80px;}#cb-initial-banner.cb-banner #cb-preferences-btn{background:#ffffff!important;color:#334155!important;border:1px solid #334155!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-initial-banner.cb-banner #cb-reject-all-btn,#cb-initial-banner.cb-banner #cb-accept-all-btn{background:#007aff!important;color:#ffffff!important;border-color:#007aff!important;font-size:13px!important;padding:10px 12px!important;font-weight:600!important;}#cb-floating-trigger{position:fixed;z-index:2147483646!important;width:56px;height:56px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;}#cb-floating-trigger img,#cb-floating-trigger svg{display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;}";
    e.styles && (D = D + "\\n" + e.styles);
    var M = "cb-banner-animate-left cb-banner-animate-right cb-banner-animate-top cb-banner-animate-bottom cb-banner-animate-fade cb-banner-animate-prefs-left cb-banner-animate-prefs-right cb-banner-animate-center-top cb-banner-animate-center-bottom cb-banner-animate-zoom-in cb-banner-animate-prefs-zoom-in";
    Oe();
    "complete" === document.readyState || "interactive" === document.readyState ? He() : window.addEventListener("DOMContentLoaded", He)
  }

  function R() {
    if (h) {
      var e = (navigator.language || navigator.userLanguage || "en").split("-")[0].toLowerCase();
      return TRANSLATIONS[e] ? e : "en"
    }
    return y
  }

  function U(e) {
    var t = R();
    var n = TRANSLATIONS[t] || TRANSLATIONS.en;
    var a = null != n[e] ? n[e] : null != TRANSLATIONS.en[e] ? TRANSLATIONS.en[e] : "";
    return "" === a && "title" === e ? "We value your privacy" : "" === a && "description" === e ? "We use cookies to provide you with the best possible experience. They also allow us to analyze user behavior in order to constantly improve the website for you." : a
  }

  function W(e) {
    var t = R();
    var n;
    var a = (TRANSLATIONS[t] || TRANSLATIONS.en)[e];
    a && a.length > 80 && (a = TRANSLATIONS.en[e] || e);
    return a || TRANSLATIONS.en[e] || e
  }

  function J(e, t) {
    var n = null == e ? "" : String(e);
    return n.length > t ? n.slice(0, t) : n
  }

  function Y(e, t) {
    return J(U(e), t)
  }

  function X() {
    try {
      var e = R();
      var _cfg = TRANSLATIONS.config || {};
      var n = _cfg.cookiePolicyLinkEnabled != null ? _cfg.cookiePolicyLinkEnabled : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).cookiePolicyLinkEnabled;
      return !1 !== n && "0" !== n && "false" !== String(n).toLowerCase()
    } catch (e) {
      return !0
    }
  }

  function q() {
    try {
      var e = R();
      var _cfg = TRANSLATIONS.config || {};
      var n = _cfg.closeButtonEnabled != null ? _cfg.closeButtonEnabled : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).closeButtonEnabled;
      return !0 === n || 1 === n || !1 !== n && "0" !== n && "false" !== String(n).toLowerCase()
    } catch (e) {
      return !0
    }
  }

  function qR() {
    try {
      var e = R();
      var _cfg = TRANSLATIONS.config || {};
      var n = _cfg.rejectButtonEnabled != null ? _cfg.rejectButtonEnabled : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).rejectButtonEnabled;
      return !0 === n || 1 === n || !1 !== n && "0" !== n && "false" !== String(n).toLowerCase()
    } catch (e) {
      return !0
    }
  }

  function qC() {
    try {
      var e = R();
      var _cfg = TRANSLATIONS.config || {};
      var n = _cfg.customizeButtonEnabled != null ? _cfg.customizeButtonEnabled : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).customizeButtonEnabled;
      return !0 === n || 1 === n || !1 !== n && "0" !== n && "false" !== String(n).toLowerCase()
    } catch (e) {
      return !0
    }
  }

  function H(e) {
    var t = String(e || "bottom-left").trim().toLowerCase().replace(/_/g, "-");
    return "bottom-right" === t || "right" === t ? "bottom-right" : "bottom" === t || "bottom-center" === t ? "bottom" : "bottom-left"
  }

  function V(e) {
    if (e) {
      e.style.marginLeft = "";
      e.style.marginRight = "";
      e.style.paddingLeft = "";
      e.style.paddingRight = "";
      if (De()) {
        var t = p || "box";
        var n = H(l && l.position);
        var a = Me();
        var r = "56px";
        "banner" !== t ? "left" === a ? "bottom-center" !== t && "popup" !== t && "bottom" !== n && "bottom-left" !== n || (e.style.marginLeft = r) : "bottom-center" !== t && "popup" !== t && "bottom" !== n && "bottom-right" !== n || (e.style.marginRight = r) : "left" === a ? e.style.paddingLeft = r : e.style.paddingRight = r
      }
    }
  }

  function Z(e) {
    if (!e) return !1;
    var t = p || "box";
    var n = H(l && l.position);
    e.style.left = "";
    e.style.right = "";
    e.style.top = "";
    e.style.bottom = "";
    e.style.transform = "";
    e.style.width = "";
    e.style.maxWidth = "";
    e.style.marginLeft = "";
    e.style.marginRight = "";
    e.style.paddingLeft = "";
    e.style.paddingRight = "";
    if ("banner" === t) {
      e.style.left = "0";
      e.style.right = "0";
      e.style.bottom = "0";
      e.style.transform = "none";
      e.style.width = "100%";
      e.style.maxWidth = "none";
      e.setAttribute("data-cb-initial-centered", "0");
      V(e);
      return !1
    }
    if (window.innerWidth <= 660) {
      e.style.setProperty("left", "0", "important");
      e.style.setProperty("right", "0", "important");
      e.style.setProperty("bottom", "0", "important");
      e.style.setProperty("transform", "none", "important");
      e.style.setProperty("width", "100vw", "important");
      e.style.setProperty("max-width", "100vw", "important");
      e.style.setProperty("min-width", "0", "important");
      e.style.setProperty("border-radius", "0", "important");
      e.style.setProperty("border-left", "none", "important");
      e.style.setProperty("border-right", "none", "important");
      e.style.setProperty("border-bottom", "none", "important");
      e.setAttribute("data-cb-initial-centered", "0");
      return !1
    }
    if ("bottom-center" === t || "popup" === t || "bottom" === n) {
      e.style.bottom = "32px";
      e.style.left = "50%";
      e.style.transform = "translateX(-50%)";
      e.setAttribute("data-cb-initial-centered", "1");
      V(e);
      return !0
    }
    e.style.bottom = "32px";
    "bottom-right" === n ? e.style.right = "32px" : e.style.left = "32px";
    e.style.transform = "none";
    e.setAttribute("data-cb-initial-centered", "0");
    V(e);
    return !1
  }

  function $(e) {
    var t = e;
    var n = t.indexOf("#");
    n >= 0 && (t = t.slice(0, n));
    (n = t.indexOf("?")) >= 0 && (t = t.slice(0, n));
    (n = t.indexOf("/")) >= 0 && (t = t.slice(0, n));
    return t.trim()
  }

  function G(e) {
    var t = e.lastIndexOf(".");
    if (t < 0) return !1;
    var n = e.slice(t).toLowerCase();
    return ".js" === n || ".mjs" === n || ".css" === n || ".png" === n || ".jpg" === n || ".jpeg" === n || ".gif" === n || ".svg" === n || ".webp" === n || ".pdf" === n || ".json" === n || ".xml" === n || ".ico" === n || ".woff" === n || ".woff2" === n
  }

  function K(e) {
    if (!e || "string" != typeof e) return "";
    var t = e.trim();
    if (!t) return "";
    var n = t.toLowerCase();
    if (0 === n.indexOf("mailto:") || 0 === n.indexOf("tel:")) return t;
    if (0 === n.indexOf("http://") || 0 === n.indexOf("https://")) return t;
    if (0 === t.indexOf("//")) return "https:" + t;
    if ("/" === t.charAt(0) || 0 === t.indexOf("./") || 0 === t.indexOf("../")) {
      try {
        if ("undefined" != typeof window && window.location) return new URL(t, window.location.href).href
      } catch (e) {}
      return t
    }
    var a = $(t);
    if (a.indexOf(".") > 0 && !G(a)) {
      for (; t.length > 0 && "/" === t.charAt(0);) t = t.slice(1);
      return "https://" + t
    }
    try {
      if ("undefined" != typeof window && window.location) return new URL(t, window.location.href).href
    } catch (e) {}
    return t
  }

  function Q(e, t) {
    var n = K(t);
    if (n) {
      e.href = n;
      e.target = "_blank";
      e.rel = "noopener noreferrer";
      e.addEventListener("click", function (e) {
        e.stopPropagation && e.stopPropagation();
        e.preventDefault && e.preventDefault();
        try {
          window.open(n, "_blank", "noopener,noreferrer")
        } catch (e) {}
      }, !0)
    }
  }

  function ee() {
    try {
      var e = localStorage.getItem(I);
      var t = e ? JSON.parse(e) : {
        accepted: !1,
        timestamp: null
      };
      if (!t || !t.accepted) return t || {
        accepted: !1,
        timestamp: null
      };
      var n = Date.now();
      var a = 24 * O * 60 * 60 * 1e3;
      var r = t.expiresAt ? new Date(t.expiresAt).getTime() : t.timestamp ? new Date(t.timestamp).getTime() + a : 0;
      return r > 0 && n > r ? {
        accepted: !1,
        timestamp: null
      } : t
    } catch (e) {
      console.warn("[ConsentBit] Failed to read consent from localStorage", e);
      return {
        accepted: !1,
        timestamp: null
      }
    }
  }

  function te(e) {
    try {
      var t = 24 * O * 60 * 60 * 1e3;
      e.expiresAt = e.expiresAt || new Date(Date.now() + t).toISOString();
      localStorage.setItem(I, JSON.stringify(e))
    } catch (e) {
      console.warn("[ConsentBit] Failed to save consent state", e)
    }
    A = e;
    try {
      ke()
    } catch (e) {
      console.warn("[ConsentBit] releaseBlockedScripts failed", e)
    }
    try {
      _e()
    } catch (e) {
      console.warn("[ConsentBit] releaseBlockedPixels failed", e)
    }
  }

  function ne(e) {
    try {
      var t = {
        analytics: !!e.analytics,
        preferences: !!e.preferences,
        marketing: !!e.marketing
      };
      var n = btoa(JSON.stringify(t));
      localStorage.setItem(B, n)
    } catch (e) {
      console.warn("[ConsentBit] Failed to save preference toggles", e)
    }
  }

  function ae() {
    try {
      var e = localStorage.getItem(B);
      if (!e) return null;
      var t = JSON.parse(atob(e));
      return t && "object" == typeof t ? {
        analytics: !!t.analytics,
        preferences: !!t.preferences,
        marketing: !!t.marketing
      } : null
    } catch (e) {
      console.warn("[ConsentBit] Failed to load preference toggles", e);
      return null
    }
  }

  function re(e, t) {
    if (r && c) {
      t = t || {};
      var n = e && e.expiresAt || t.expiresAt || new Date(Date.now() + 24 * O * 60 * 60 * 1e3).toISOString();
      var a = {
        siteId: r,
        regulation: "gdpr" === i ? "gdpr" : "ccpa",
        bannerType: i,
        consentMethod: t.consentMethod || "banner",
        status: t.status || "given",
        expiresAt: n,
        consent: e
      };
      try {
        fetch(c + "/api/consent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(a)
        }).catch(function (e) {
          console.warn("[ConsentBit] /api/consent failed", e)
        })
      } catch (e) {
        console.warn("[ConsentBit] /api/consent threw", e)
      }
    }
  }

  function ie() {
    try {
      var e = localStorage.getItem(L);
      if (!e) return !1;
      var t = JSON.parse(e);
      var n = new Date;
      var a = n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0");
      return t.yearMonth === a && !0 === t.overLimit
    } catch (e) {
      return !1
    }
  }

  function oe(e) {
    try {
      localStorage.setItem(L, JSON.stringify({
        overLimit: !0,
        yearMonth: e
      }))
    } catch (e) {}
  }

  function ce() {
    if (r && c && !ie()) try {
      var e = {
        siteId: r,
        pageUrl: "undefined" != typeof window && window.location ? window.location.href : null
      };
      fetch(c + "/api/pageview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(e),
        keepalive: !0
      }).then(function (e) {
        return e.json()
      }).then(function (e) {
        if (e && e.overLimit) {
          var t = new Date;
          var n;
          oe(e.yearMonth || t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0"))
        }
      }).catch(function (e) {
        console.warn("[ConsentBit] /api/pageview failed", e)
      })
    } catch (e) {
      console.warn("[ConsentBit] /api/pageview threw", e)
    }
  }

  function se() {
    try {
      var e = "undefined" != typeof document && document.cookie ? document.cookie : "";
      return e ? e.split(";").map(function (e) {
        return e.trim()
      }).filter(Boolean) : []
    } catch (e) {
      return []
    }
  }

  function le() {
    try {
      var e = [];
      var t = document.getElementsByTagName("script");
      for (var n = 0; n < t.length; n++) {
        var a = t[n].src;
        a && -1 === a.indexOf("consentbit") && -1 === a.indexOf("client_data") && e.push(a)
      }
      return e
    } catch (e) {
      return []
    }
  }

  function de(e) {
    try {
      var t;
      var n = new URL(e).hostname;
      return -1 !== n.indexOf("google-analytics.com") || -1 !== e.indexOf("gtag/js") || -1 !== n.indexOf("googletagmanager.com") ? "analytics" : -1 !== n.indexOf("facebook.com") || -1 !== n.indexOf("fbcdn.net") || -1 !== n.indexOf("doubleclick.net") || 0 === n.indexOf("ads.") ? "marketing" : -1 !== n.indexOf("hotjar.com") || -1 !== n.indexOf("intercom.io") || -1 !== n.indexOf("fullstory.com") ? "behavioral" : "uncategorized"
    } catch (e) {
      return "uncategorized"
    }
  }

  function pe() {
    var e = {};
    var t = [];
    var n = document.scripts;
    for (var a = 0; a < n.length; a++) {
      var r = n[a];
      if (r.src && !e[r.src]) {
        e[r.src] = !0;
        t.push(r)
      }
    }
    return t
  }

  function be() {
    var e = document.scripts;
    for (var t = 0; t < e.length; t++) {
      var n = e[t];
      var a = n.src || n.getAttribute("data-cb-blocked-src") || "";
      if (-1 !== a.indexOf("googletagmanager.com/gtag/js") || -1 !== a.indexOf("googletagmanager.com/gtm.js") || -1 !== a.indexOf("google-analytics.com")) return !0
    }
    return !1
  }

  function fe(e) {
    return "analytics" === e || "marketing" === e || "behavioral" === e || "advertisement" === e || "functional" === e || "performance" === e
  }

  function me(e) {
    if (!e || "string" != typeof e) return !1;
    var t = e.toLowerCase();
    return -1 !== t.indexOf("googletagmanager.com/gtag/js") || -1 !== t.indexOf("googletagmanager.com/gtm.js") || -1 !== t.indexOf("google-analytics.com")
  }

  function ue(e) {
    var t = e;
    "behavioral" === t && (t = "analytics");
    if ("essential" === t) return !0;
    if ("ccpa" === i) {
      return !(A && A.accepted && A.ccpa && A.ccpa.doNotSell && fe(t));
      var n
    }
    if (!A || !A.accepted) return !1;
    var a = A.categories || {};
    return "analytics" === t ? !!a.analytics : "marketing" === t || "advertisement" === t ? !!a.marketing : "preferences" !== t && "functional" !== t && "performance" !== t || !!a.preferences
  }

  function ge(e) {
    if (!e) return null;
    var t = String(e).toLowerCase().trim();
    if ("analytics" === t || "marketing" === t || "behavioral" === t || "preferences" === t || "essential" === t) return ["essential" === t ? "essential" : t];
    var n = t;
    return n.indexOf("necessary") >= 0 || n.indexOf("essential") >= 0 ? ["essential"] : n.indexOf("functional") >= 0 || n.indexOf("preference") >= 0 ? ["preferences"] : n.indexOf("analytics") >= 0 || n.indexOf("performance") >= 0 || n.indexOf("statistics") >= 0 ? ["analytics"] : n.indexOf("advertisement") >= 0 || n.indexOf("marketing") >= 0 || n.indexOf("ads") >= 0 || n.indexOf("social") >= 0 ? ["marketing"] : n.indexOf("other") >= 0 ? ["analytics"] : null
  }

  function ve(e, t) {
    if (t && t.getAttribute) {
      var n = ge(t.getAttribute("data-consentbit"));
      if (n) return n;
      var a = t.getAttribute("data-consentbit-category");
      if (a) {
        var r = String(a).toLowerCase().trim();
        if ("analytics" === r || "marketing" === r || "behavioral" === r || "preferences" === r || "essential" === r) return [r]
      }
      var i = ge(t.getAttribute("data-cookieyes"));
      if (i) return i
    }
    if (e && j.length)
      for (var o = 0; o < j.length; o++) {
        var c = j[o];
        if (c && c.pattern) try {
          if (new RegExp(c.pattern, "i").test(e)) return c.categories && c.categories.length ? c.categories.slice() : ["analytics"]
        } catch (e) {}
      }
    if (e && P.length)
      for (var s = 0; s < P.length; s++) {
        var l = P[s];
        if (l && l.scriptUrlPattern) try {
          if (new RegExp(l.scriptUrlPattern, "i").test(e)) return [l.category || "uncategorized"]
        } catch (e) {}
      }
    return []
  }

  function ye(e, t) {
    if (z) return !1;
    if (!e || "string" != typeof e) return !1;
    var n = e.toLowerCase();
    if (-1 !== n.indexOf("consentbit") || -1 !== n.indexOf("client_data")) return !1;
    var a = ve(e, t);
    if (!a || 0 === a.length) return !1;
    if ("ccpa" === i) return !!(A && A.accepted && A.ccpa && A.ccpa.doNotSell);
    for (var r = 0; r < a.length; r++) {
      var o = a[r];
      if (fe(o) && !("analytics" === o && me(e) || ue(o))) return !0
    }
    return !1
  }

  function he(e) {
    if (e && "SCRIPT" === e.nodeName && (!e.getAttribute || "javascript/blocked" !== e.getAttribute("type"))) {
      var t = e.getAttribute && e.getAttribute("src") || e.src || "";
      if (t) {
        var n = ve(t, e);
        var a = n.length > 0 ? n[0] : "uncategorized";
        if (ye(t, e)) try {
          e.setAttribute("data-cb-blocked-src", t);
          e.setAttribute("type", "javascript/blocked");
          e.removeAttribute("src")
        } catch (e) {}
      }
    }
  }

  function xe(e) {
    if (e && !e.__cbPatched) {
      e.__cbPatched = !0;
      try {
        Object.defineProperty(e, "src", {
          configurable: !0,
          enumerable: !0,
          get: function () {
            return e.getAttribute("src") || ""
          },
          set: function (t) {
            var n = ve(t, e);
            var a = n.length > 0 ? n[0] : "uncategorized";
            if (ye(t, e)) {
              e.setAttribute("data-cb-blocked-src", t);
              e.setAttribute("type", "javascript/blocked");
              e.removeAttribute("src")
            } else e.setAttribute("src", t)
          }
        })
      } catch (e) {}
      try {
        Object.defineProperty(e, "type", {
          configurable: !0,
          enumerable: !0,
          get: function () {
            return e.getAttribute("type") || ""
          },
          set: function (t) {
            var n = t;
            ye(e.getAttribute("src") || e.src || "", e) && (n = "javascript/blocked");
            e.setAttribute("type", n)
          }
        })
      } catch (e) {}
    }
  }

  function we(e) {
    if (e && 1 === e.nodeType)
      if ("SCRIPT" !== e.nodeName) {
        if (e.querySelectorAll) {
          var t = e.querySelectorAll("script[src]");
          for (var n = 0; n < t.length; n++) he(t[n])
        }
      } else he(e)
  }

  function ke(e) {
    if (window.__CB_WEBFLOW_MODE__) Ie(e || (A && A.categories) || {
      analytics: !0,
      marketing: !0,
      preferences: !0,
      essential: !0
    });
    else {
      var t = document.querySelectorAll('script[type="javascript/blocked"][data-cb-blocked-src]');
      var n = 0;
      var a = 0;
      var r = [];
      var i = [];
      for (var o = 0; o < t.length; o++) {
        var c = t[o];
        var s = c.getAttribute("data-cb-blocked-src");
        if (s)
          if (ye(s, c)) {
            a++;
            r.push(s)
          } else {
            z = !0;
            try {
              var l = document.createElement("script");
              l.async = c.hasAttribute("async");
              l.defer = c.hasAttribute("defer");
              l.crossOrigin = c.crossOrigin || "";
              l.integrity = c.integrity || "";
              l.referrerPolicy = c.referrerPolicy || "";
              c.id && (l.id = c.id);
              l.src = s;
              var d = c.attributes;
              for (var p = 0; p < d.length; p++) {
                var b = d[p].name;
                "src" !== b && "type" !== b && "data-cb-blocked-src" !== b && l.setAttribute(b, d[p].value)
              }
              c.parentNode ? c.parentNode.replaceChild(l, c) : document.head.appendChild(l);
              n++;
              i.push(s)
            } catch (e) {
              console.warn("[ConsentBit][Release] Failed to release script:", s, e)
            } finally {
              z = !1
            }
          }
      }
    }
  }

  function Ce(e) {
    if (!e || "string" != typeof e) return null;
    var t = e.toLowerCase();
    if (0 !== t.indexOf("http")) return null;
    for (var n = 0; n < F.length; n++)
      if (-1 !== t.indexOf(F[n].domain)) return F[n].category;
    for (var a = 0; a < P.length; a++) {
      var r = P[a];
      if (r && r.scriptUrlPattern) try {
        if (new RegExp(r.scriptUrlPattern, "i").test(e)) return r.category || "marketing"
      } catch (e) {}
    }
    return null
  }

  function Ee(e) {
    if (!e || "string" != typeof e) return !1;
    var n = e.toLowerCase();
    if (-1 !== n.indexOf("consentbit") || -1 !== n.indexOf("client_data")) return !1;
    var t = Ce(e);
    return !(!t || !fe(t) || ("ccpa" === i ? !(A && A.accepted && A.ccpa && A.ccpa.doNotSell) : A && A.accepted && ue(t)))
  }

  function Se(e) {
    if (e && !e.__cbImgPatched) {
      e.__cbImgPatched = !0;
      try {
        Object.defineProperty(e, "src", {
          configurable: !0,
          enumerable: !0,
          get: function () {
            return e.getAttribute("src") || ""
          },
          set: function (t) {
            if (Ee(t)) {
              e.setAttribute("data-cb-blocked-src", t);
              e.removeAttribute("src")
            } else e.setAttribute("src", t)
          }
        })
      } catch (e) {}
    }
  }

  function _e() {
    var e = document.querySelectorAll("img[data-cb-blocked-src]");
    for (var t = 0; t < e.length; t++) {
      var n = e[t];
      var a = n.getAttribute("data-cb-blocked-src");
      if (a && !Ee(a)) {
        n.removeAttribute("data-cb-blocked-src");
        n.src = a
      }
    }
  }

  function Ie(e) {
    if (window.__CB_WEBFLOW_MODE__) {
      var t = e || {};
      window.userConsent = t;
      try {
        document.dispatchEvent(new CustomEvent("consentUpdated", {
          detail: t,
          bubbles: !0
        }))
      } catch (e) {}
    }
  }

  function Oe() {
    if (!window.__CB_WEBFLOW_MODE__ && !window.__cbCreateElementHookInstalled) {
      window.__cbCreateElementHookInstalled = !0;
      try {
        N = document.createElement.bind(document)
      } catch (e) {
        N = document.createElement
      }
      try {
        var e = window.Image;
        window.Image = function (t, n) {
          var a = new e(t, n);
          Se(a);
          return a
        };
        window.Image.prototype = e.prototype
      } catch (e) {}
      document.createElement = function (e) {
        var t = N(e);
        var n = String(e || "").toLowerCase();
        "script" === n ? xe(t) : "img" !== n && "iframe" !== n || Se(t);
        return t
      };
      var t = new MutationObserver(function (e) {
        for (var t = 0; t < e.length; t++) {
          var n = e[t];
          if ("childList" === n.type) {
            var a = n.addedNodes;
            for (var r = 0; r < a.length; r++) we(a[r])
          } else "attributes" === n.type && "src" === n.attributeName && n.target && "SCRIPT" === n.target.nodeName && he(n.target)
        }
      });
      try {
        t.observe(document.documentElement, {
          childList: !0,
          subtree: !0,
          attributes: !0,
          attributeFilter: ["src"]
        })
      } catch (e) {
        t.observe(document.documentElement, {
          childList: !0,
          subtree: !0
        })
      }
      window.__cbMutationObserver = t
    }
  }

  function Ae() {
    if (window.__CB_WEBFLOW_MODE__) try {
      document.dispatchEvent(new CustomEvent("cbBlockScripts", {
        detail: {},
        bubbles: !0
      }))
    } catch (e) {} else {
      var e = pe();
      var t = 0;
      var n = 0;
      var a = 0;
      var r = [];
      var i = [];
      for (var o = 0; o < e.length; o++) {
        var c = e[o];
        var l = c.src;
        if ("javascript/blocked" !== c.getAttribute("type")) {
          var d = ve(l, c);
          var p = d.length > 0 ? d[0] : "uncategorized";
          if (fe(p))
            if ("analytics" === p && s && me(l)) {
              n++;
              i.push({
                src: l,
                category: p,
                reason: "ga-cookieless"
              })
            } else if (ue(p)) {
            n++;
            i.push({
              src: l,
              category: p,
              reason: "consent-granted"
            })
          } else try {
            c.setAttribute("data-cb-blocked-src", l);
            c.setAttribute("type", "javascript/blocked");
            c.removeAttribute("src");
            t++;
            r.push({
              src: l,
              category: p
            })
          } catch (e) {
            console.warn("[ConsentBit][Block] Failed to block script:", l, e)
          } else {
            n++;
            i.push({
              src: l,
              category: p,
              reason: "essential"
            })
          }
        } else a++
      }
    }
  }

  function Be() {
    if (T.length) {
      var e = [];
      z = !0;
      try {
        for (var t = 0; t < T.length; t++) {
          var n = T[t];
          var a = n.cats || (n.category ? [n.category] : []);
          var r;
          if (0 === a.length || a.every(function (e) {
              return !fe(e) || ue(e)
            })) {
            var i = document.createElement("script");
            i.src = n.src;
            var o = n.attrs;
            for (var c in o) Object.prototype.hasOwnProperty.call(o, c) && "src" !== c && i.setAttribute(c, o[c]);
            document.head.appendChild(i)
          } else e.push(n)
        }
      } finally {
        z = !1
      }
      T = e
    }
  }

  function Le() {
    if (s) {
      z = !0;
      try {
        var e = !1;
        var t = document.scripts;
        for (var n = 0; n < t.length; n++) {
          var a;
          var r = t[n].src || "";
          if (-1 !== r.indexOf("googletagmanager.com/gtag/js") || -1 !== r.indexOf("googletagmanager.com/gtm.js") || -1 !== r.indexOf("google-analytics.com")) {
            e = !0;
            break
          }
        }
        if (!e) {
          var i = document.createElement("script");
          i.async = !0;
          i.src = "https://www.googletagmanager.com/gtag/js?id=" + s;
          document.head.appendChild(i)
        }
        window.dataLayer = window.dataLayer || [];

        function gtag() {
          dataLayer.push(arguments)
        }
        window.gtag = gtag;
        gtag("consent", "default", {
          ad_storage: "denied",
          analytics_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied"
        });
        gtag("js", new Date);
        gtag("config", s, {
          anonymize_ip: !0,
          allow_google_signals: !1,
          allow_ad_personalization_signals: !1
        });
        gtag("event", "page_view", {
          page_path: window.location.pathname,
          page_title: document.title || ""
        })
      } finally {
        z = !1
      }
    }
  }

  function Te(e, t) {
    if (s || be()) {
      var n = {
        analytics_storage: e.analytics ? "granted" : "denied",
        ad_storage: e.marketing ? "granted" : "denied",
        ad_user_data: e.marketing ? "granted" : "denied",
        ad_personalization: e.preferences ? "granted" : "denied"
      };
      if (window.gtag) window.gtag("consent", "update", n);
      else {
        var a = 0;
        var r = setInterval(function () {
          a++;
          if (window.gtag) {
            clearInterval(r);
            window.gtag("consent", "update", n)
          } else if (a >= 20) {
            clearInterval(r);
            console.warn("[ConsentBit]" + (t || "") + " window.gtag unavailable after 2s — consent NOT updated")
          }
        }, 100)
      }
    } else console.warn("[ConsentBit]" + (t || "") + " No Google tracking detected — gtag update skipped")
  }

  function ze() {
    if (!document.getElementById("cb-styles")) {
      var e;
      var t;
      var n = "#cb-preferences-banner .cb-banner-footer button#cb-save-prefs-btn{background-color:" + (l && l.saveButtonBg ? String(l.saveButtonBg) : "#ffffff") + " !important;color:" + (l && l.saveButtonText ? String(l.saveButtonText) : "#334155") + " !important;border-color:#e2e8f0 !important;}#cb-preferences-banner.cb-ccpa-prefs .cb-banner-footer button#cb-cancel-prefs-btn{background-color:" + (l && l.acceptButtonBg ? String(l.acceptButtonBg) : "#ffffff") + " !important;color:" + (l && l.acceptButtonText ? String(l.acceptButtonText) : "#334155") + " !important;border-color:" + (l && l.acceptButtonBg ? String(l.acceptButtonBg) : "#e2e8f0") + " !important;}";
      var a = "";
      if (l && l.backgroundColor) {
        var r = String(l.backgroundColor);
        a = "#cb-initial-banner.cb-banner,#cb-preferences-banner.cb-banner{background-color:" + r + " !important;}.cb-gdpr-accordion{background-color:" + r + " !important;}"
      }
      var i = "";
      if (l && l.headingColor) {
        var o = String(l.headingColor);
        i = "#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{color:" + o + " !important;}.cb-gdpr-cat-label{color:" + o + " !important;}"
      }
      var c = "";
      if (l && l.textColor) {
        var s;
        c = "#cb-initial-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-banner-body > p,#cb-preferences-banner.cb-banner .cb-gdpr-cat-desc{color:" + String(l.textColor) + " !important;}"
      }
      var d = "";
      if (l && l.bannerFontWeight) {
        var p = String(l.bannerFontWeight);
        d = "#cb-initial-banner.cb-banner h3,#cb-preferences-banner.cb-banner h3{font-weight:" + p + " !important;}.cb-gdpr-cat-label{font-weight:" + p + " !important;}.cb-gdpr-cat-desc{font-weight:" + p + " !important;}.cb-banner p{font-weight:" + p + " !important;}"
      }
      var b = "#cb-preferences-banner.cb-banner h3{padding-right:36px !important;}#cb-preferences-banner.cb-banner.cb-ccpa-prefs h3{padding-right:0 !important;padding-top:16px !important;margin-bottom:14px !important;}#cb-preferences-banner.cb-banner.cb-ccpa-prefs .cb-banner-body>p{margin-bottom:16px !important;}";
      var f = "#cb-preferences-banner.cb-banner .cb-banner-body{padding-right:4px;}#cb-preferences-banner.cb-banner .cb-gdpr-accordion > div{margin-right:2px;}";
      if (!document.getElementById("cb-font-montserrat")) {
        var m = document.createElement("link");
        m.id = "cb-font-montserrat";
        m.rel = "stylesheet";
        m.href = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap";
        document.head.appendChild(m)
      }
      var _acceptBtnCss = "";
      if (l && l.acceptButtonBg) {
        var _abg = String(l.acceptButtonBg);
        var _atxt = l.acceptButtonText ? String(l.acceptButtonText) : "#ffffff";
        _acceptBtnCss = ".cb-banner button#cb-accept-all-btn{background-color:" + _abg + " !important;color:" + _atxt + " !important;}#cb-initial-banner.cb-banner #cb-accept-all-btn{background:" + _abg + " !important;color:" + _atxt + " !important;}"
      }
      var _rejectBtnCss = "";
      if (l && l.acceptButtonBg) {
        var _rbg = String(l.acceptButtonBg);
        var _rtxt = l.acceptButtonText ? String(l.acceptButtonText) : "#ffffff";
        _rejectBtnCss = ".cb-banner button#cb-reject-all-btn{background-color:" + _rbg + " !important;color:" + _rtxt + " !important;}#cb-initial-banner.cb-banner #cb-reject-all-btn{background:" + _rbg + " !important;color:" + _rtxt + " !important;}.cb-banner button#cb-prefs-reject-btn{background-color:" + _rbg + " !important;color:" + _rtxt + " !important;}"
      }
      var u = document.createElement("style");
      u.id = "cb-styles";
      u.type = "text/css";
      var _closeBtnCss = "";
      if (l && l.backgroundColor) {
        var _cbg = String(l.backgroundColor).replace("#", "");
        if (3 === _cbg.length) _cbg = _cbg[0] + _cbg[0] + _cbg[1] + _cbg[1] + _cbg[2] + _cbg[2];
        var _cr = parseInt(_cbg.substr(0, 2), 16) || 0;
        var _cg = parseInt(_cbg.substr(2, 2), 16) || 0;
        var _cb = parseInt(_cbg.substr(4, 2), 16) || 0;
        var _closeColor = (0.299 * _cr + 0.587 * _cg + 0.114 * _cb) > 128 ? "#0f172a" : "#ffffff";
        _closeBtnCss = "#cb-close-initial-btn,#cb-close-prefs-btn{color:" + _closeColor + " !important;}"
      }
      u.appendChild(document.createTextNode(D + "\\n" + n + "\\n" + a + "\\n" + i + "\\n" + c + "\\n" + d + "\\n" + b + "\\n" + f + "\\n" + _acceptBtnCss + "\\n" + _rejectBtnCss + "\\n" + _closeBtnCss));
      document.head.appendChild(u)
    }
  }

  function Ne(e, t) {
    if (q()) {
      var n = document.createElement("button");
      n.type = "button";
      n.id = t;
      n.setAttribute("aria-label", "Close");
      n.textContent = "×";
      var _nc = "#0f172a";
      if (l && l.backgroundColor) {
        var _nhex = String(l.backgroundColor).replace("#", "");
        if (3 === _nhex.length) _nhex = _nhex[0] + _nhex[0] + _nhex[1] + _nhex[1] + _nhex[2] + _nhex[2];
        var _nr = parseInt(_nhex.substr(0, 2), 16) || 0;
        var _ng = parseInt(_nhex.substr(2, 2), 16) || 0;
        var _nb = parseInt(_nhex.substr(4, 2), 16) || 0;
        _nc = (0.299 * _nr + 0.587 * _ng + 0.114 * _nb) > 128 ? "#0f172a" : "#ffffff";
      }
      n.style.cssText = "position:absolute;top:8px;right:24px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:" + _nc + ";opacity:0.75;";
      e.appendChild(n)
    }
  }

  function je(e) {
    if (q()) {
      var t = document.createElement("button");
      t.type = "button";
      t.id = "cb-close-prefs-btn";
      t.setAttribute("aria-label", "Close");
      t.textContent = "×";
      var _jc = "#0f172a";
      if (l && l.backgroundColor) {
        var _jhex = String(l.backgroundColor).replace("#", "");
        if (3 === _jhex.length) _jhex = _jhex[0] + _jhex[0] + _jhex[1] + _jhex[1] + _jhex[2] + _jhex[2];
        var _jr = parseInt(_jhex.substr(0, 2), 16) || 0;
        var _jg = parseInt(_jhex.substr(2, 2), 16) || 0;
        var _jb = parseInt(_jhex.substr(4, 2), 16) || 0;
        _jc = (0.299 * _jr + 0.587 * _jg + 0.114 * _jb) > 128 ? "#0f172a" : "#ffffff";
      }
      t.style.cssText = "position:absolute;top:8px;right:30px;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;cursor:pointer;z-index:10;line-height:1;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;font-size:22px;font-weight:400;color:" + _jc + ";opacity:0.75;";
      e.appendChild(t)
    }
  }

  function Pe() {
    console.log("[CB] Pe() called, banner already exists:", !!document.getElementById("cb-initial-banner"), "bannerType:", i);
    if (!document.getElementById("cb-initial-banner"))
      if (document.body) {
        var e = "ccpa" === i;
        var t = document.createElement("div");
        console.log("[CB] Building banner, ccpa:", e);
        if (e) {
          var n;
          (n = document.createElement("div")).className = "cb-banner";
          n.id = "cb-initial-banner";
          n.style.display = "none";
          var a;
          (a = document.createElement("div")).className = "cb-banner-body";
          var r;
          (r = document.createElement("h3")).textContent = Y("title", w);
          a.appendChild(r);
          var o = document.createElement("p");
          var c = J(U("description"), k);
          if (b && X()) {
            o.appendChild(document.createTextNode(c + " "));
            var s;
            (s = document.createElement("a")).textContent = Y("privacyPolicy", E);
            s.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            Q(s, b);
            o.appendChild(s);
            o.appendChild(document.createTextNode("."))
          } else o.textContent = c;
          a.appendChild(o);
          var l = document.createElement("p");
          l.style.marginTop = "20px";
          l.style.marginBottom = "0";
          var d = document.createElement("button");
          d.id = "cb-ccpa-donotsell-link";
          d.type = "button";
          d.textContent = U("doNotSell");
          d.style.cssText = "background:none;border:none;padding:0;margin:0;color:#007aff;text-decoration:underline;cursor:pointer;font:inherit;text-align:left;display:inline;";
          l.appendChild(d);
          a.appendChild(l);
          n.appendChild(a);
          Ne(n, "cb-close-initial-btn");
          t.appendChild(n);
          var p;
          (p = document.createElement("div")).className = "cb-banner cb-ccpa-prefs";
          p.id = "cb-preferences-banner";
          p.style.display = "none";
          "left" === g ? p.classList.add("prefs-left") : "right" === g ? p.classList.add("prefs-right") : p.classList.add("prefs-center");
          var v;
          (v = document.createElement("div")).className = "cb-banner-body";
          var y;
          (y = document.createElement("h3")).textContent = U("optOutPreference");
          v.appendChild(y);
          var h = document.createElement("p");
          var x = (U("ccpaOptOutPreferenceIntro") || U("ccpaOptOut") || "").replace(/\s*More info\.?\s*$/i, "").trim();
          if (b && X()) {
            h.appendChild(document.createTextNode(x + " "));
            var S = document.createElement("a");
            S.textContent = U("privacyPolicy");
            S.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            Q(S, b);
            h.appendChild(S);
            h.appendChild(document.createTextNode("."))
          } else h.textContent = x;
          h.style.lineHeight = "1.45";
          v.appendChild(h);
          var _ = document.createElement("label");
          _.style.cssText = "display:flex;align-items:flex-start;gap:12px;margin-top:20px;cursor:pointer;";
          var I = document.createElement("span");
          I.style.cssText = "flex:1;line-height:1.45;";
          I.textContent = U("doNotSell");
          var O = document.createElement("input");
          O.type = "checkbox";
          O.id = "cb-ccpa-optout";
          O.style.cssText = "flex-shrink:0;margin-top:2px;";
          O.checked = !!(A && A.accepted && A.ccpa && A.ccpa.doNotSell);
          _.appendChild(O);
          _.appendChild(I);
          v.appendChild(_);
          p.appendChild(v);
          var B;
          (B = document.createElement("div")).className = "cb-banner-footer";
          var L = document.createElement("button");
          L.id = "cb-cancel-prefs-btn";
          L.textContent = W("cancel");
          B.appendChild(L);
          var T;
          (T = document.createElement("button")).id = "cb-save-prefs-btn";
          var z = U("saveMyPreferences") || U("save");
          T.textContent = z;
          B.appendChild(T);
          p.appendChild(B);
          je(p);
          t.appendChild(p)
        } else {
          console.log("[CB] GDPR banner path - building elements");
          var N = function (e) {
            var t = document.createElement("div");
            t.style.borderBottom = "1px solid #e5e7eb";
            var n = document.createElement("div");
            n.style.cssText = "display:flex;align-items:center;gap:14px;padding:12px 14px;min-height:44px;";
            var a = document.createElement("button");
            a.type = "button";
            a.setAttribute("aria-expanded", "false");
            a.textContent = "+";
            a.style.cssText = "flex-shrink:0;width:22px;height:22px;padding:0;border:1px solid #e5e7eb;border-radius:4px;background:#f3f4f6;color:#111827;font-size:14px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;";
            var r = document.createElement("span");
            r.className = "cb-gdpr-cat-label";
            r.style.cssText = "flex:1;font-size:11px;font-weight:600;";
            r.textContent = e.labelText;
            n.appendChild(a);
            n.appendChild(r);
            var i = document.createElement("div");
            i.style.flexShrink = "0";
            if (e.alwaysActive) {
              var o = document.createElement("span");
              o.style.cssText = "font-size:11px;font-weight:600;color:#374151;";
              o.textContent = U("alwaysActive");
              i.appendChild(o)
            } else {
              var c = document.createElement("input");
              c.type = "checkbox";
              c.id = e.checkboxId;
              e.defaultChecked && (c.checked = !0);
              c.style.cssText = "position:absolute;opacity:0;width:0;height:0;margin:0;pointer-events:none;";
              var s = document.createElement("button");
              s.type = "button";
              s.className = "cb-pref-toggle-track";
              s.setAttribute("role", "switch");
              s.setAttribute("aria-label", e.labelText);
              var l = function () {
                s.setAttribute("aria-checked", c.checked ? "true" : "false")
              };
              s.addEventListener("click", function () {
                c.checked = !c.checked;
                l()
              });
              l();
              i.appendChild(c);
              i.appendChild(s)
            }
            n.appendChild(i);
            var d = document.createElement("div");
            d.className = "cb-gdpr-cat-desc";
            d.style.cssText = "display:none;padding:0 12px 12px 44px;font-size:13px;line-height:1.5;";
            d.textContent = e.descText;
            a.addEventListener("click", function () {
              var isOpening = "none" === d.style.display;
              var container = t.parentNode;
              if (container) {
                var items = container.children;
                for (var _i = 0; _i < items.length; _i++) {
                  var _desc = items[_i].querySelector(".cb-gdpr-cat-desc");
                  var _btn = items[_i].querySelector("button[aria-expanded]");
                  if (_desc && _desc !== d) {
                    _desc.style.display = "none";
                    if (_btn) {
                      _btn.textContent = "+";
                      _btn.setAttribute("aria-expanded", "false")
                    }
                  }
                }
              }
              d.style.display = isOpening ? "block" : "none";
              a.textContent = isOpening ? "−" : "+";
              a.setAttribute("aria-expanded", isOpening ? "true" : "false")
            });
            t.appendChild(n);
            t.appendChild(d);
            return t
          };
          var n;
          (n = document.createElement("div")).className = "cb-banner";
          n.id = "cb-initial-banner";
          n.style.display = "none";
          var a;
          (a = document.createElement("div")).className = "cb-banner-body";
          var r;
          (r = document.createElement("h3")).textContent = U("title");
          a.appendChild(r);
          var o = document.createElement("p");
          var c = U("description");
          if (b && X()) {
            o.appendChild(document.createTextNode(c + " "));
            var s;
            (s = document.createElement("a")).textContent = U("privacyPolicy");
            s.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            Q(s, b);
            o.appendChild(s);
            o.appendChild(document.createTextNode("."))
          } else o.textContent = c;
          a.appendChild(o);
          n.appendChild(a);
          var j = document.createElement("div");
          j.className = "cb-banner-footer";
          var P = document.createElement("button");
          P.id = "cb-preferences-btn";
          P.textContent = J(W("customise"), C);
          qC() && j.appendChild(P);
          var F = document.createElement("button");
          F.id = "cb-reject-all-btn";
          F.textContent = J(W("rejectAll"), C);
          qR() && j.appendChild(F);
          var D = document.createElement("button");
          D.id = "cb-accept-all-btn";
          D.textContent = J(W("acceptAll"), C);
          j.appendChild(D);
          n.appendChild(j);
          Ne(n, "cb-close-initial-btn");
          t.appendChild(n);
          var p;
          (p = document.createElement("div")).className = "cb-banner";
          p.id = "cb-preferences-banner";
          p.style.display = "none";
          "left" === g ? p.classList.add("prefs-left") : "right" === g ? p.classList.add("prefs-right") : p.classList.add("prefs-center");
          var v;
          (v = document.createElement("div")).className = "cb-banner-body";
          var y;
          (y = document.createElement("h3")).textContent = Y("cookiePreferences", w);
          v.appendChild(y);
          var h = document.createElement("p");
          var M = (J(U("managePreferences"), k) || "").replace(/\s*More info\.?\s*$/i, "").trim();
          if (b && X()) {
            h.appendChild(document.createTextNode(M + " "));
            var R = document.createElement("a");
            R.textContent = Y("privacyPolicy", E);
            R.style.cssText = "color:#007aff;text-decoration:underline;cursor:pointer;";
            Q(R, b);
            h.appendChild(R);
            h.appendChild(document.createTextNode("."))
          } else h.textContent = M;
          v.appendChild(h);
          var q = document.createElement("div");
          q.className = "cb-gdpr-accordion";
          q.style.cssText = "border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:4px;";
          var H = U("strictlyNecessary") || U("essential");
          q.appendChild(N({
            labelText: H,
            alwaysActive: !0,
            descText: U("essentialDescription")
          }));
          var V;
          var $ = ae() || A && A.accepted && A.categories || {};
          q.appendChild(N({
            labelText: U("marketing"),
            checkboxId: "cb-pref-marketing",
            defaultChecked: !!$.marketing,
            descText: U("marketingDescription")
          }));
          q.appendChild(N({
            labelText: U("analytics"),
            checkboxId: "cb-pref-analytics",
            defaultChecked: !!$.analytics,
            descText: U("analyticsDescription")
          }));
          q.appendChild(N({
            labelText: U("preferences"),
            checkboxId: "cb-pref-preferences",
            defaultChecked: !!$.preferences,
            descText: U("preferencesDescription")
          }));
          q.lastChild && (q.lastChild.style.borderBottom = "none");
          v.appendChild(q);
          p.appendChild(v);
          var B;
          (B = document.createElement("div")).className = "cb-banner-footer";
          var G = document.createElement("button");
          G.id = "cb-prefs-reject-btn";
          G.textContent = J(W("rejectAll"), C);
          B.appendChild(G);
          var T;
          (T = document.createElement("button")).id = "cb-save-prefs-btn";
          T.textContent = J(W("saveMyPreferences") || W("save"), C);
          B.appendChild(T);
          p.appendChild(B);
          je(p);
          t.appendChild(p)
        }
        document.body.appendChild(t);
        console.log("[CB] Banner wrapper appended to body, searching for cb-initial-banner...");
        f && (document.body.style.overflow = "hidden");
        if (!window.__cbResizeInit) {
          window.__cbResizeInit = true;
          window.addEventListener("resize", function() {
            var rb = document.getElementById("cb-initial-banner");
            if (rb && rb.style.display !== "none" && rb.style.visibility !== "hidden") Z(rb);
          });
        }
        var K = document.getElementById("cb-initial-banner");
        console.log("[CB] cb-initial-banner element found:", K, "current display:", K ? K.style.display : "N/A");
        if (K) {
          var ee = Z(K);
          K.style.display = "flex";
          K.style.visibility = "visible";
          K.style.opacity = "1";
          console.log("[CB] Banner display set to flex, visibility:", K.style.visibility, "opacity:", K.style.opacity, "computedDisplay:", window.getComputedStyle(K).display);
          if (m) {
            var te = "";
            var ne = u;
            te = ee ? "slide-up" === u ? "cb-banner-animate-initial-center-bottom" : "slide-down" === u ? "cb-banner-animate-initial-center-top" : "zoom-in" === u ? "cb-banner-animate-initial-center-zoom" : "cb-banner-animate-fade" : "slide-up" === u ? "cb-banner-animate-bottom" : "slide-down" === u ? "cb-banner-animate-top" : "zoom-in" === u ? "cb-banner-animate-zoom-in" : "cb-banner-animate-fade";
            K.classList.add(te)
          }
        } else console.error("[ConsentBit] Failed to find banner element after creation!")
      } else {
        console.warn("[ConsentBit] document.body not ready, retrying...");
        setTimeout(Pe, 100)
      }
  }

  function Fe() {
    f && (document.body.style.overflow = "")
  }

  function De() {
    try {
      if (l && !1 === l.showBannerLogo) return !1;
      if (l && 0 === l.showBannerLogo) return !1;
      var e = R();
      var _cfg = TRANSLATIONS.config || {};
      var n = _cfg.floatingButtonEnabled != null ? _cfg.floatingButtonEnabled : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).floatingButtonEnabled;
      return !1 !== n && "0" !== n && "false" !== String(n).toLowerCase()
    } catch (e) {
      return !0
    }
  }

  function Me() {
    try {
      if (l && l.bannerLogoPosition) return "right" === l.bannerLogoPosition ? "right" : "left";
      var e = R();
      var _cfg = TRANSLATIONS.config || {};
      var _fp = _cfg.floatingButtonPosition != null ? _cfg.floatingButtonPosition : (TRANSLATIONS[e] || TRANSLATIONS.en || {}).floatingButtonPosition;
      return "right" === _fp ? "right" : "left"
    } catch (e) {
      return "left"
    }
  }

  function Re() {
    var e = "http://www.w3.org/2000/svg";
    var t = document.createElementNS(e, "svg");
    t.setAttribute("xmlns", e);
    t.setAttribute("viewBox", "0 0 40 40");
    t.setAttribute("width", "44");
    t.setAttribute("height", "44");
    t.setAttribute("aria-hidden", "true");
    t.setAttribute("focusable", "false");
    t.style.cssText = "display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;";
    var n = document.createElementNS(e, "circle");
    n.setAttribute("cx", "20");
    n.setAttribute("cy", "20");
    n.setAttribute("r", "18");
    n.setAttribute("fill", "#007aff");
    t.appendChild(n);
    var a = [{
      cx: "14",
      cy: "14",
      r: "2.2"
    }, {
      cx: "24",
      cy: "18",
      r: "2.5"
    }, {
      cx: "17",
      cy: "25",
      r: "2"
    }];
    for (var r = 0; r < a.length; r++) {
      var i = document.createElementNS(e, "circle");
      i.setAttribute("cx", a[r].cx);
      i.setAttribute("cy", a[r].cy);
      i.setAttribute("r", a[r].r);
      i.setAttribute("fill", "#ffffff");
      t.appendChild(i)
    }
    return t
  }

  function Ue() {
    try {
      var e = document.getElementsByTagName("script");
      for (var t = e.length - 1; t >= 0; t--) {
        var n = e[t].src || "";
        if (-1 !== n.indexOf("/consentbit/") || -1 !== n.indexOf("/client_data/")) return new URL(n).origin
      }
    } catch (e) {}
    return ""
  }

  function We() {
    if (!document.getElementById("cb-floating-trigger") && De()) {
      var e = Me();
      var t = n || "";
      var r = a || "";
      if (!t) {
        var i = Ue();
        if (i) {
          t = i + "/embed/floating-logo.svg";
          r || (r = t)
        }
      }
      var o = document.createElement("button");
      o.id = "cb-floating-trigger";
      o.type = "button";
      o.setAttribute("aria-label", U("cookiePreferences"));
      o.style.cssText = "position:fixed;bottom:28px;" + ("right" === e ? "right:16px;" : "left:16px;") + "z-index:2147483646;width:56px;height:56px;border:none;border-radius:9999px;background:transparent;cursor:pointer;padding:0;box-shadow:none;";
      if (t) {
        var c = document.createElement("img");
        c.alt = "";
        c.src = t;
        c.setAttribute("width", "44");
        c.setAttribute("height", "44");
        c.draggable = !1;
        c.style.cssText = "display:block;width:44px;height:44px;object-fit:contain;margin:auto;pointer-events:none;";
        var s = !1;
        c.addEventListener("error", function e() {
          if (s || !r || t === r) {
            c.removeEventListener("error", e);
            c.parentNode && c.parentNode.replaceChild(Re(), c)
          } else {
            s = !0;
            c.src = r
          }
        });
        o.appendChild(c)
      } else o.appendChild(Re());
      document.body.appendChild(o)
    }
  }

  function Je() {
    if (!m) return "";
    var e = u;
    return "left" === g ? "zoom-in" === u ? "cb-banner-animate-prefs-zoom-in" : "cb-banner-animate-prefs-left" : "right" === g ? "zoom-in" === u ? "cb-banner-animate-prefs-zoom-in" : "cb-banner-animate-prefs-right" : "slide-up" === u ? "cb-banner-animate-center-bottom" : "slide-down" === u ? "cb-banner-animate-center-top" : "zoom-in" === u ? "cb-banner-animate-prefs-zoom-in" : "cb-banner-animate-fade"
  }

  function Ye(e) {
    if (e) {
      var t = M.split(" ");
      for (var n = 0; n < t.length; n++) t[n] && e.classList.remove(t[n])
    }
  }

  function Xe() {
    ze();
    Pe();
    We();
    var e = document.getElementById("cb-initial-banner");
    var t = document.getElementById("cb-preferences-banner");
    var n = document.getElementById("cb-preferences-btn");
    var a = document.getElementById("cb-accept-all-btn");
    var r = document.getElementById("cb-reject-all-btn");
    var o = document.getElementById("cb-prefs-reject-btn");
    var c = document.getElementById("cb-cancel-prefs-btn");
    var s = document.getElementById("cb-save-prefs-btn");
    var l = document.getElementById("cb-ccpa-donotsell-link");
    var d = "ccpa" === i;

    function p() {
      if (e) {
        e.style.setProperty("display", "none", "important");
        e.classList.remove("cb-banner-animate-left", "cb-banner-animate-right", "cb-banner-animate-top", "cb-banner-animate-bottom", "cb-banner-animate-fade")
      }
      if (t) {
        t.style.display = "none";
        Ye(t)
      }
      var n = document.getElementById("cb-floating-trigger");
      n && (n.style.display = "flex");
      Fe()
    }

    function b() {
      if (e) {
        if (t) {
          t.style.display = "none";
          Ye(t)
        }
        var n = Z(e);
        e.style.setProperty("display", "flex", "important");
        e.style.setProperty("visibility", "visible", "important");
        e.style.setProperty("opacity", "1", "important");
        e.classList.remove("cb-banner-animate-left", "cb-banner-animate-right", "cb-banner-animate-top", "cb-banner-animate-bottom", "cb-banner-animate-fade", "cb-banner-animate-zoom-in");
        if (m) {
          var a = "";
          var r = u;
          a = n ? "slide-up" === u ? "cb-banner-animate-initial-center-bottom" : "slide-down" === u ? "cb-banner-animate-initial-center-top" : "zoom-in" === u ? "cb-banner-animate-initial-center-zoom" : "cb-banner-animate-fade" : "slide-up" === u ? "cb-banner-animate-bottom" : "slide-down" === u ? "cb-banner-animate-top" : "zoom-in" === u ? "cb-banner-animate-zoom-in" : "cb-banner-animate-fade";
          e.classList.add(a)
        }
        f && (document.body.style.overflow = "hidden")
      }
    }
    var g = document.getElementById("cb-floating-trigger");
    g && g.addEventListener("click", function (e) {
      e && e.preventDefault && e.preventDefault();
      e && e.stopPropagation && e.stopPropagation();
      b()
    });
    n && n.addEventListener("click", function () {
      if (e && t) {
        if (!d) {
          var n = ae() || A && A.categories || {};
          var a = function (e, t) {
            var n = document.getElementById(e);
            if (n) {
              n.checked = !!t;
              var a = n.parentNode && n.parentNode.querySelector("button.cb-pref-toggle-track");
              a && a.setAttribute("aria-checked", n.checked ? "true" : "false")
            }
          };
          a("cb-pref-analytics", n.analytics);
          a("cb-pref-preferences", n.preferences);
          a("cb-pref-marketing", n.marketing)
        }
        e.style.display = "none";
        e.classList.remove("cb-banner-animate-left", "cb-banner-animate-right", "cb-banner-animate-top", "cb-banner-animate-bottom", "cb-banner-animate-fade");
        var _ft1 = document.getElementById("cb-floating-trigger");
        _ft1 && (_ft1.style.display = "none");
        t.style.display = "flex";
        t.style.visibility = "visible";
        t.style.opacity = "1";
        Ye(t);
        var r = Je();
        r && t.classList.add(r)
      }
    });
    o && o.addEventListener("click", function () {
      var e = {
        accepted: !0,
        timestamp: (new Date).toISOString(),
        categories: {
          essential: !0,
          analytics: !1,
          preferences: !1,
          marketing: !1
        }
      };
      te(e);
      re(e, {
        status: "rejected"
      });
      ne(e.categories);
      Te(e.categories, "[PrefsReject]");
      Ie(e.categories);
      p()
    });
    var v = document.getElementById("cb-close-initial-btn");
    var y = document.getElementById("cb-close-prefs-btn");
    v && v.addEventListener("click", function () {
      p()
    });
    y && y.addEventListener("click", function () {
      p()
    });
    d && l && l.addEventListener("click", function () {
      if (e && t) {
        e.style.display = "none";
        var _ft2 = document.getElementById("cb-floating-trigger");
        _ft2 && (_ft2.style.display = "none");
        t.style.display = "flex";
        t.style.visibility = "visible";
        t.style.opacity = "1";
        Ye(t);
        var n = Je();
        n && t.classList.add(n)
      }
    });
    c && c.addEventListener("click", function () {
      b()
    });
    r && r.addEventListener("click", function () {
      if (!d) {
        var e = {
          accepted: !0,
          timestamp: (new Date).toISOString(),
          categories: {
            essential: !0,
            analytics: !1,
            preferences: !1,
            marketing: !1
          }
        };
        te(e);
        re(e, {
          status: "rejected"
        });
        ne(e.categories);
        Te(e.categories, "[Reject]");
        Ie(e.categories)
      }
      p()
    });
    a && a.addEventListener("click", function () {
      if (d) {
        var e = {
          accepted: !0,
          timestamp: (new Date).toISOString(),
          ccpa: {
            doNotSell: !1
          }
        };
        te(e);
        re(e, {
          status: "given"
        });
        ke({
          analytics: !0,
          marketing: !0,
          preferences: !0,
          essential: !0
        })
      } else {
        var t = {
          accepted: !0,
          timestamp: (new Date).toISOString(),
          categories: {
            essential: !0,
            analytics: !0,
            preferences: !0,
            marketing: !0
          }
        };
        te(t);
        re(t, {
          status: "given"
        });
        ne(t.categories);
        ke(t.categories);
        Te(t.categories, "[Accept]")
      }
      p()
    });
    s && s.addEventListener("click", function () {
      if (d) {
        var e = document.getElementById("cb-ccpa-optout");
        var t = !(!e || !e.checked);
        var n = {
          accepted: !0,
          timestamp: (new Date).toISOString(),
          ccpa: {
            doNotSell: t
          }
        };
        te(n);
        re(n, {
          status: t ? "rejected" : "given"
        });
        t || ke({
          analytics: !0,
          marketing: !0,
          preferences: !0,
          essential: !0
        })
      } else {
        var a = document.getElementById("cb-pref-analytics");
        var r = document.getElementById("cb-pref-preferences");
        var i = document.getElementById("cb-pref-marketing");
        var o = {
          accepted: !0,
          timestamp: (new Date).toISOString(),
          categories: {
            essential: !0,
            analytics: !(!a || !a.checked),
            preferences: !(!r || !r.checked),
            marketing: !(!i || !i.checked)
          }
        };
        te(o);
        re(o, {
          status: "partial"
        });
        ne(o.categories);
        ke(o.categories);
        Te(o.categories, "[Save]");
        Ie(o.categories)
      }
      p()
    })
  }

  function qe() {
    Xe();
    var e = document.getElementById("cb-initial-banner");
    if (e) {
      e.style.display = "flex";
      e.style.visibility = "visible";
      e.style.opacity = "1";
    }
    var ft = document.getElementById("cb-floating-trigger");
    if (ft) ft.style.display = "none";
  }

  function He() {
    var e = be();
    if ("gdpr" === i) {
      Ae();
      if (s || e) {
        window.gtag && window.gtag("consent", "default", {
          analytics_storage: "denied",
          ad_storage: "denied",
          ad_user_data: "denied",
          ad_personalization: "denied",
          functionality_storage: "denied",
          personalization_storage: "denied",
          security_storage: "granted",
          wait_for_update: 500
        });
        A.accepted ? Te(A.categories || {}, "[Reload]") : s && Le()
      }
    }
    if (!window.__CB_WEBFLOW_MODE__) {
      if (o)
        if (A.accepted) {
          Xe();
          var t = document.getElementById("cb-floating-trigger");
          t && (t.style.display = "flex");
          var _cbi = document.getElementById("cb-initial-banner");
          if (_cbi) {
            _cbi.style.setProperty("display", "none", "important");
            _cbi.style.setProperty("visibility", "hidden", "important");
          }
        } else qe();
    } else {
      Xe();
      if (A.accepted) {
        var _cbib = document.getElementById("cb-initial-banner");
        if (_cbib) {
          _cbib.style.setProperty("display", "none", "important");
          _cbib.style.setProperty("visibility", "hidden", "important");
        }
        var _cbipb = document.getElementById("cb-preferences-banner");
        if (_cbipb) {
          _cbipb.style.setProperty("display", "none", "important");
        }
        var _cbt = document.getElementById("cb-floating-trigger");
        if (_cbt) _cbt.style.display = "flex";
      } else {
        var _cbib2 = document.getElementById("cb-initial-banner");
        if (_cbib2) {
          _cbib2.style.display = "flex";
          _cbib2.style.setProperty("visibility", "visible", "important");
          _cbib2.style.setProperty("opacity", "1", "important");
        }
        var _cbft2 = document.getElementById("cb-floating-trigger");
        if (_cbft2) _cbft2.style.display = "none";
      }
    }
    try {
      ce()
    } catch (e) {
      console.warn("[ConsentBit] sendPageviewToServer threw", e)
    }

    function n() {
      document.addEventListener("click", function (e) {
        var t = e.target;
        for (; t && t !== document.body;) {
          if (t.hasAttribute && t.hasAttribute("data-consentbit-trigger")) {
            e.preventDefault();
            e.stopPropagation();
            try {
              localStorage.removeItem(I);
              A = {
                accepted: !1,
                timestamp: null
              }
            } catch (e) {
              console.warn("[ConsentBit] Failed to clear consent:", e)
            }
            var n = document.getElementById("cb-initial-banner");
            if (n) {
              n.style.display = "flex";
              n.style.visibility = "visible";
              n.style.opacity = "1";
              f && (document.body.style.overflow = "hidden");
              var nft = document.getElementById("cb-floating-trigger");
              if (nft) nft.style.display = "none";
              n.scrollIntoView({
                behavior: "smooth",
                block: "start"
              })
            } else {
              qe();
              setTimeout(function () {
                var e = document.getElementById("cb-initial-banner");
                e && e.scrollIntoView({
                  behavior: "smooth",
                  block: "start"
                })
              }, 100)
            }
            return !1
          }
          t = t.parentElement
        }
      }, !0)
    }
    "loading" === document.readyState ? document.addEventListener("DOMContentLoaded", n) : n()
  }
}();
`;
}
