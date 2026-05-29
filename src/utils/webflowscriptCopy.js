// @ts-nocheck
export function getWebflowSetupScript() {
  return `(function () {
  window.__CB_WEBFLOW_MODE__ = true;
  (function () {
    try {
      var _cbS = window.__CONSENT_SITE__ || {};
      var _bt = (_cbS.bannerType || 'gdpr').toLowerCase();
      var _cc = _bt === 'ccpa';

      var _cats = null;
      var _dns = false;

      // Read saved category prefs from localStorage
      try {
        for (var _pi = 0; _pi < localStorage.length; _pi++) {
          var _pk = localStorage.key(_pi);
          if (_pk && _pk.indexOf('consentbit_prefs_') === 0) {
            try {
              var _pr = localStorage.getItem(_pk);
              if (_pr) { _cats = JSON.parse(atob(_pr)); break; }
            } catch (e) {}
          }
        }
      } catch (e) {}

      // Read top-level consent record from localStorage
      try {
        for (var _mi = 0; _mi < localStorage.length; _mi++) {
          var _mk = localStorage.key(_mi);
          if (_mk && _mk.indexOf('consentbit_') === 0 && _mk.indexOf('consentbit_prefs_') !== 0) {
            try {
              var _md = JSON.parse(localStorage.getItem(_mk));
              if (_md && _md.accepted) {
                if (!_cats && _md.categories) _cats = _md.categories;
                if (_md.ccpa && _md.ccpa.doNotSell) _dns = true;
                break;
              }
            } catch (e) {}
          }
        }
      } catch (e) {}

      // Set up gtag consent — must happen before any GA/GTM script loads
      window.dataLayer = window.dataLayer || [];
      window.gtag = window.gtag || function () { dataLayer.push(arguments); };

      if (!_cc) {
        // GDPR: default everything to denied until the user gives consent
        window.gtag('consent', 'default', {
          ad_storage: 'denied',
          analytics_storage: 'denied',
          ad_user_data: 'denied',
          ad_personalization: 'denied',
          functionality_storage: 'denied',
          personalization_storage: 'denied',
          security_storage: 'granted',
          wait_for_update: 500
        });
        // If consent was already given on a prior visit, replay the update immediately
        if (_cats) {
          window.gtag('consent', 'update', {
            analytics_storage: _cats.analytics ? 'granted' : 'denied',
            ad_storage: _cats.marketing ? 'granted' : 'denied',
            ad_user_data: _cats.marketing ? 'granted' : 'denied',
            ad_personalization: _cats.preferences ? 'granted' : 'denied'
          });
        }
      } else {
        // CCPA: opt-out model — default granted; denied only if user already opted out (doNotSell)
        window.gtag('consent', 'default', {
          ad_storage: _dns ? 'denied' : 'granted',
          analytics_storage: _dns ? 'denied' : 'granted',
          ad_user_data: _dns ? 'denied' : 'granted',
          ad_personalization: _dns ? 'denied' : 'granted',
          security_storage: 'granted'
        });
      }

      // _blk: true = blocking is active
      var _blk = _cc ? _dns : true;
      var _sbp = _cbS.scriptBlockProviders || [];
      var _ccr = _cbS.customCookieRules || [];

      // Built-in tracking domain → category map (mirrors the F array in the standard loader)
      var _builtinDomains = [
        { domain: 'google-analytics.com',    category: 'analytics'  },
        { domain: 'googletagmanager.com',    category: 'analytics'  },
        { domain: 'gtag/js',                 category: 'analytics'  },
        { domain: 'gtm.js',                  category: 'analytics'  },
        { domain: 'hotjar.com',              category: 'analytics'  },
        { domain: 'clarity.ms',              category: 'analytics'  },
        { domain: 'scorecardresearch.com',   category: 'analytics'  },
        { domain: 'quantserve.com',          category: 'analytics'  },
        { domain: 'facebook.com',            category: 'marketing'  },
        { domain: 'facebook.net',            category: 'marketing'  },
        { domain: 'fbcdn.net',               category: 'marketing'  },
        { domain: 'doubleclick.net',         category: 'marketing'  },
        { domain: 'googleadservices.com',    category: 'marketing'  },
        { domain: 'googlesyndication.com',   category: 'marketing'  },
        { domain: 'bing.com',                category: 'marketing'  },
        { domain: 'bat.bing.com',            category: 'marketing'  },
        { domain: 'twitter.com',             category: 'marketing'  },
        { domain: 'analytics.twitter.com',   category: 'marketing'  },
        { domain: 't.co',                    category: 'marketing'  },
        { domain: 'linkedin.com',            category: 'marketing'  },
        { domain: 'ads.linkedin.com',        category: 'marketing'  },
        { domain: 'pinterest.com',           category: 'marketing'  },
        { domain: 'ct.pinterest.com',        category: 'marketing'  },
        { domain: 'tiktok.com',              category: 'marketing'  },
        { domain: 'analytics.tiktok.com',   category: 'marketing'  },
        { domain: 'outbrain.com',            category: 'marketing'  },
        { domain: 'taboola.com',             category: 'marketing'  },
        { domain: 'criteo.com',              category: 'marketing'  },
        { domain: 'criteo.net',              category: 'marketing'  },
        { domain: 'zemanta.com',             category: 'marketing'  },
        { domain: 'adroll.com',              category: 'marketing'  },
        { domain: 'd.adroll.com',            category: 'marketing'  },
        { domain: 'smartlook.com',           category: 'analytics'  },
        { domain: 'smartlookcloud.com',      category: 'analytics'  },
        { domain: 'rec.smartlook.com',       category: 'analytics'  },
        { domain: 'posthog.com',             category: 'analytics'  },
        { domain: 'app.posthog.com',         category: 'analytics'  },
        { domain: 'eu.posthog.com',          category: 'analytics'  },
        { domain: 'matomo.cloud',            category: 'analytics'  },
        { domain: 'matomo.js',               category: 'analytics'  },
        { domain: 'piwik.js',                category: 'analytics'  },
        { domain: 'piwik.php',               category: 'analytics'  },
      ];

      function _ess(c) {
        var lo = (c || '').trim().toLowerCase();
        return lo === 'necessary' || lo === 'essential';
      }

      function _mc(c) {
        var lo = c.trim().toLowerCase();
        if (lo === 'advertising' || lo === 'advertisement') return 'marketing';
        if (lo === 'functional' || lo === 'performance' || lo === 'personalization') return 'preferences';
        return lo;
      }

      // Returns the category of a src URL (from built-in list, then custom providers)
      // Returns null if not a known tracking script
      function _detectCategory(src) {
        if (!src) return null;
        var lo = src.toLowerCase();
        for (var bi = 0; bi < _builtinDomains.length; bi++) {
          if (lo.indexOf(_builtinDomains[bi].domain) !== -1) return _builtinDomains[bi].category;
        }
        for (var k = 0; k < _sbp.length; k++) {
          try {
            if (_sbp[k] && _sbp[k].pattern && new RegExp(_sbp[k].pattern, 'i').test(src))
              return (_sbp[k].categories && _sbp[k].categories[0]) || 'analytics';
          } catch (e) {}
        }
        for (var l = 0; l < _ccr.length; l++) {
          try {
            if (_ccr[l] && _ccr[l].scriptUrlPattern && new RegExp(_ccr[l].scriptUrlPattern, 'i').test(src))
              return _ccr[l].category || 'analytics';
          } catch (e) {}
        }
        return null;
      }

      // Inspect a script element and block it if consent is not granted for its category
      function _jj(el) {
        if (!_blk) return;
        if (!el || el.nodeName !== 'SCRIPT') return;
        var src = (el.getAttribute && el.getAttribute('src')) || '';
        if (src.indexOf('consentbit') !== -1 || src.indexOf('consent.js') !== -1) return;
        if (el.getAttribute && el.getAttribute('type') === 'text/plain') return;

        var dc = el.getAttribute && el.getAttribute('data-category');

        if (dc) {
          // Script has explicit data-category — respect it
          var cl = dc.split(',').map(function (c) { return c.trim().toLowerCase(); });
          if (cl.every(_ess)) return; // all essential — never block
          if (!_cc && _cats) {
            if (cl.every(function (c) { return _ess(c) || !!_cats[_mc(c)]; })) return; // already consented
          }
          if (src) {
            el.setAttribute('data-cb-blocked-src', src);
            el.removeAttribute('src');
          }
          el.setAttribute('type', 'text/plain');
        } else if (src) {
          // No data-category — check against built-in domain list and custom providers
          var detectedCat = _detectCategory(src);
          if (!detectedCat) return; // unknown script — leave it alone
          if (_ess(detectedCat)) return; // essential — never block
          if (!_cc && _cats && !!_cats[_mc(detectedCat)]) return; // already consented for this category
          el.setAttribute('data-cb-blocked-src', src);
          el.setAttribute('data-category', detectedCat); // tag it so unblocking query finds it
          el.removeAttribute('src');
          el.setAttribute('type', 'text/plain');
        }
      }

      // Hook document.createElement so scripts created dynamically are intercepted
      // before they are appended to the DOM (MutationObserver fires after insertion,
      // which is too late for synchronous loaders).
      var _origCE = document.createElement.bind(document);
      document.createElement = function (tag) {
        var el = _origCE(tag);
        if (typeof tag === 'string' && tag.toLowerCase() === 'script') {
          var _srcVal = '';
          try {
            Object.defineProperty(el, 'src', {
              configurable: true,
              enumerable: true,
              get: function () { return _srcVal; },
              set: function (val) {
                _srcVal = val;
                if (!_blk) { el.setAttribute('src', val); return; }
                var dc = el.getAttribute('data-category');
                var detectedCat = _detectCategory(val);
                var shouldBlock = false;
                if (dc) {
                  var cl = dc.split(',').map(function (c) { return c.trim().toLowerCase(); });
                  if (!cl.every(_ess)) {
                    shouldBlock = !(!_cc && _cats && cl.every(function (c) { return _ess(c) || !!_cats[_mc(c)]; }));
                  }
                } else if (detectedCat && !_ess(detectedCat)) {
                  shouldBlock = !(!_cc && _cats && !!_cats[_mc(detectedCat)]);
                }
                if (shouldBlock) {
                  el.setAttribute('data-cb-blocked-src', val);
                  if (!dc && detectedCat) el.setAttribute('data-category', detectedCat);
                  el.setAttribute('type', 'text/plain');
                } else {
                  el.setAttribute('src', val);
                }
              }
            });
          } catch (e) {}
        }
        return el;
      };

      // Watch for dynamically added scripts (catches innerHTML/insertAdjacentHTML paths)
      var _ob = new MutationObserver(function (ms) {
        ms.forEach(function (m) { m.addedNodes.forEach(_jj); });
      });
      _ob.observe(document.documentElement, { childList: true, subtree: true });

      // Register pre-blocked scripts so the consentUpdated handler can find and release them.
      // Do NOT call _jj on normal scripts here — by this point they have already executed,
      // and marking them would cause double-fire when released on consent.
      function _registerPreBlockedScripts() {
        _ob.disconnect();
        document.querySelectorAll('script[type="text/plain"]').forEach(function (el) {
          var src = el.getAttribute('src') || '';
          if (src && !el.getAttribute('data-cb-blocked-src')) {
            el.setAttribute('data-cb-blocked-src', src);
            if (!el.getAttribute('data-category')) {
              var cat = _detectCategory(src);
              if (cat) el.setAttribute('data-category', cat);
              else {
                var _cbcat = el.getAttribute('data-consentbit-category') || el.getAttribute('data-category-cb');
                if (_cbcat) el.setAttribute('data-category', _cbcat.trim().toLowerCase());
              }
            }
          }
          // Mark inline pre-blocked scripts (no src) with a sentinel so the
          // consentUpdated handler can find and release them.
          if (!src && !el.getAttribute('data-cb-inline-blocked')) {
            el.setAttribute('data-cb-inline-blocked', '1');
            if (!el.getAttribute('data-category')) {
              var _incat = el.getAttribute('data-consentbit-category') || el.getAttribute('data-category-cb');
              if (_incat) el.setAttribute('data-category', _incat.trim().toLowerCase());
            }
          }
        });
      }
      // ConsentBit loads async — DOMContentLoaded may have already fired by the time we run.
      // Check readyState and either wait or register immediately.
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _registerPreBlockedScripts, { once: true });
      } else {
        _registerPreBlockedScripts();
      }

      // When consent is given/updated: update gtag + release/block scripts
      document.addEventListener('consentUpdated', function (ev) {
        var cats = (ev && ev.detail) || {};

        // Update in-memory consent state FIRST so the createElement hook and _jj
        // use fresh values when releasing scripts re-triggers them.
        if (_cc) {
          var dns2 = !!(cats.doNotSell || (cats.ccpa && cats.ccpa.doNotSell));
          _dns = dns2;
          // CCPA: when user opts out → deny all; when user allows → grant all
          window.gtag && window.gtag('consent', 'update', {
            ad_storage:         dns2 ? 'denied' : 'granted',
            analytics_storage:  dns2 ? 'denied' : 'granted',
            ad_user_data:       dns2 ? 'denied' : 'granted',
            ad_personalization: dns2 ? 'denied' : 'granted'
          });
          if (dns2 && !_blk) {
            _blk = true;
            document.querySelectorAll('script[data-cb-blocked-src]').forEach(_jj);
            return;
          }
          if (!dns2) _blk = false;
        } else {
          // GDPR: update _cats so the createElement hook stops re-blocking consented categories
          _cats = {
            analytics:   !!cats.analytics,
            marketing:   !!cats.marketing,
            preferences: !!cats.preferences,
            essential:   true
          };
        }
        // Helper: check if a category string is ok given current cats
        function _okForCats(dc2) {
          if (_cc) return cats.doNotSell === false;
          if (!dc2) return !!(cats.analytics || cats.marketing || cats.preferences);
          var dca = dc2.split(',').map(function (x) { return x.trim().toLowerCase(); });
          return dca.every(function (x) {
            if (x === 'necessary' || x === 'essential') return true;
            if (x === 'analytics') return !!cats.analytics;
            if (x === 'marketing' || x === 'advertising' || x === 'advertisement') return !!cats.marketing;
            if (x === 'preferences' || x === 'functional' || x === 'performance' || x === 'personalization') return !!cats.preferences;
            return true;
          });
        }

        // 1. Release blocked scripts where consent is now granted
        var bl = document.querySelectorAll('script[type="text/plain"][data-cb-blocked-src], script[type="text/plain"][data-cb-inline-blocked]');
        for (var i = 0; i < bl.length; i++) {
          var s2 = bl[i];
          var bsrc = s2.getAttribute('data-cb-blocked-src') || '';
          var dc2 = s2.getAttribute('data-category') || '';
          var ok = _okForCats(dc2);
          if (ok) {
            try {
              var ns2 = _origCE('script');
              if (bsrc) {
                ns2.src = bsrc;
                if (s2.hasAttribute('async')) ns2.async = true;
                if (s2.hasAttribute('defer')) ns2.defer = true;
                var at2 = s2.attributes;
                for (var ai = 0; ai < at2.length; ai++) {
                  var an2 = at2[ai].name;
                  if (an2 !== 'src' && an2 !== 'type' && an2 !== 'data-cb-blocked-src' && an2 !== 'data-cb-inline-blocked')
                    ns2.setAttribute(an2, at2[ai].value);
                }
                // Mark so we can re-block if consent is later revoked
                ns2.setAttribute('data-cb-released-src', bsrc);
                s2.parentNode ? s2.parentNode.replaceChild(ns2, s2) : document.head.appendChild(ns2);
              } else {
                var _ic = s2.textContent || s2.innerHTML || '';
                var _nl = String.fromCharCode(10);
                var _ls = _ic.split(_nl);
                var _si = 0;
                while (_si < _ls.length && _si < 10) {
                  var _lt = _ls[_si].trim();
                  if (_lt.length === 0 || (_lt.charAt(0) === '/' && _lt.charAt(1) === '/')) {
                    _si++;
                  } else {
                    break;
                  }
                }
                var _fc = (_si < _ls.length ? _ls.slice(_si).join(_nl) : '').trim().charAt(0);
                if (_fc !== '{' && _fc !== '[') {
                  ns2.textContent = _ic;
                  var at3 = s2.attributes;
                  for (var aj = 0; aj < at3.length; aj++) {
                    var an3 = at3[aj].name;
                    if (an3 !== 'type' && an3 !== 'data-cb-inline-blocked')
                      ns2.setAttribute(an3, at3[aj].value);
                  }
                  ns2.setAttribute('data-cb-released-inline', '1');
                  s2.parentNode && s2.parentNode.replaceChild(ns2, s2);
                }
              }
            } catch (e) {}
          }
        }

        // 2. Re-block previously released scripts where consent is now revoked
        var rl = document.querySelectorAll('script[data-cb-released-src], script[data-cb-released-inline]');
        for (var ri = 0; ri < rl.length; ri++) {
          var rs = rl[ri];
          var rdc = rs.getAttribute('data-category') || '';
          var rok = _okForCats(rdc);
          if (!rok) {
            try {
              var rb = _origCE('script');
              rb.setAttribute('type', 'text/plain');
              if (rdc) rb.setAttribute('data-category', rdc);
              var rIsInline = rs.hasAttribute('data-cb-released-inline');
              if (rIsInline) {
                rb.textContent = rs.textContent || rs.innerHTML || '';
                rb.setAttribute('data-cb-inline-blocked', '1');
              } else {
                var rSrc = rs.getAttribute('data-cb-released-src') || '';
                rb.setAttribute('data-cb-blocked-src', rSrc);
                if (rs.hasAttribute('async')) rb.setAttribute('async', '');
                if (rs.hasAttribute('defer')) rb.setAttribute('defer', '');
              }
              rs.parentNode && rs.parentNode.replaceChild(rb, rs);
            } catch (e) {}
          }
        }
      });
    } catch (e) {}
  })();
})();`;
}
