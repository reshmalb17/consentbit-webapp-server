!function() {
    window.cookieyes = window.cookieyes || {};
    const e = window.cookieyes;
    e._dataLayerName = window.ckySettings && window.ckySettings.dataLayerName ? window.ckySettings.dataLayerName : "dataLayer";
    const t = window.ckySettings && window.ckySettings.nativeFunctions || {};
    e._ckyFetch = (t.fetch || window.fetch).bind(window),
    Object.assign(e._ckyStore, {
        _ruleData: {
            _countryName: "",
            _regionCode: "",
            _regionName: "",
            _euStatus: "",
            _currentLanguage: document.documentElement.lang,
            _geoIPStatus: ""
        },
        _language: {
            _store: new Map,
            _supportedMap: {
                en: "a_99DTpF"
            },
            _active: "",
            _default: "en",
            _localeMap: {}
        },
        _banners: {
            3751203: "qpISCj9-"
        },
        _bannerConfig: {},
        _bannerDisplayState: "none",
        _auditTable: {
            _headerKeys: []
        },
        _isPreview: !!location.search && location.search.substring(1).split("&").some((e => {
            const [t,n] = e.split("=").map((e => decodeURIComponent(e)));
            return "cky_preview" === t && "true" === n
        }
        )),
        _tcStringValue: "",
        _preConsentTCString: "",
        _vendorDisplayStatus: !1,
        _vendorToggleState: {},
        _gcmAdvanced: !1
    });
    let n = []
      , o = null;
    function c(t) {
        let n = arguments.length > 1 && void 0 !== arguments[1] ? arguments[1] : "GET"
          , o = arguments.length > 2 && void 0 !== arguments[2] ? arguments[2] : null
          , c = null;
        const r = {};
        return "POST" === n && o && (c = JSON.stringify(o),
        r["Content-Type"] = "application/json"),
        e._ckyFetch(t, {
            method: n,
            headers: r,
            body: c
        })
    }
    function r(t) {
        return e._ckyIsCategoryToBeBlocked(t) ? "denied" : "granted"
    }
    async function a() {
        await de(),
        arguments[0] && "object" == typeof arguments[0] ? window[e._dataLayerName].push(arguments[0]) : window[e._dataLayerName].push(arguments)
    }
    function i() {
        return window[e._dataLayerName] && Array.isArray(window[e._dataLayerName])
    }
    function s(e, t) {
        const n = g(e);
        n && function(e, t) {
            e.addEventListener("click", t)
        }(n, t)
    }
    function l() {
        return y("contains", ...arguments)
    }
    function d() {
        return y("add", ...arguments)
    }
    function u() {
        return y("remove", ...arguments)
    }
    function y(e, t, n) {
        const o = g(t, !(arguments.length > 3 && void 0 !== arguments[3]) || arguments[3]);
        return o && o.classList[e](n)
    }
    function _() {
        o = document.activeElement
    }
    function g(t, o) {
        let c, r = t;
        if (e._ckyStartsWith(t, "=")) {
            const e = t.substring(1);
            c = n.get(e) || null,
            c || (r = `[data-cky-tag="${e}"]`)
        }
        return c = c || document.querySelector(r),
        !c || o && !c.parentElement ? null : o ? c.parentElement : c
    }
    function k(e, t) {
        const n = new CustomEvent(e,{
            detail: t
        });
        document.dispatchEvent(n)
    }
    function f(t) {
        const n = function(e, t) {
            let n = e.split(".");
            return /cookies\.(.*\..*)\..*/gm.test(e) && (n = [n[0], n.slice(1, -1).join("."), n[n.length - 1]]),
            n.reduce(( (e, t) => e ? e[t] : null), t)
        }(t, e._ckyStore._language._store.get(e._ckyStore._language._active));
        return n || ""
    }
    function p(e) {
        let t = arguments.length > 1 && void 0 !== arguments[1] ? arguments[1] : null;
        const n = g(e);
        if (!n)
            return;
        if (t)
            return n.setAttribute("aria-expanded", t);
        const o = "true" === n.getAttribute("aria-expanded") ? "false" : "true";
        n.setAttribute("aria-expanded", o)
    }
    function b() {
        if (1 === navigator.doNotTrack)
            return;
        const t = e._ckyGetFromStore("consent");
        ("gdpr" !== e._ckyStore._bannerConfig.activeLaw || t && "yes" === t || !e._ckyStore._categories.every((t => t.isNecessary || "no" === e._ckyGetFromStore(t.slug)))) && (e._ckyStore._backupNodes = e._ckyStore._backupNodes.filter((t => {
            let {position: n, node: o, uniqueID: c} = t;
            try {
                if (e._ckyShouldBlockProvider(o.src))
                    return !0;
                if ("script" === o.nodeName.toLowerCase()) {
                    const e = document.createElement("script");
                    e.src = o.src,
                    e.type = "text/javascript",
                    document[n].appendChild(e)
                } else {
                    const e = document.getElementById(c);
                    if (!e)
                        return !1;
                    e.parentNode.insertBefore(o, e),
                    e.parentNode.removeChild(e)
                }
                return !1
            } catch (e) {
                return console.error(e),
                !1
            }
        }
        )))
    }
    function S() {
        let t = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : "all"
          , n = arguments.length > 1 && void 0 !== arguments[1] && arguments[1];
        const {activeLaw: o, reloadOnAccept: c} = e._ckyStore._bannerConfig
          , a = c && (n || window._ckyScannerBot);
        e._ckySetInStore("action", "yes"),
        e._ckySetInStore("consent", "reject" === t ? "no" : "yes");
        const i = {
            accepted: [],
            rejected: []
        };
        for (const n of e._ckyStore._categories) {
            let o = n.isNecessary || "reject" !== t && ("custom" !== t || Y(n.slug)) ? "yes" : "no";
            e._ckySetInStore(`${n.slug}`, o),
            "no" === o ? (i.rejected.push(n.slug),
            h(n)) : i.accepted.push(n.slug)
        }
        a ? e._ckyStore._isPreview ? location.reload() : ee(a) : (e._ckyStore._isPreview || ee(),
        b()),
        k("cookieyes_consent_update", i),
        C(),
        $(),
        function() {
            if (!window.clarity)
                return;
            const e = r("advertisement")
              , t = r("analytics");
            window.clarity("consentv2", {
                ad_Storage: e,
                analytics_Storage: t
            })
        }(),
        "gdpr" === o && z(!1)
    }
    function m() {
        e._ckySetInStore("action", "no"),
        e._ckySetInStore("consent", "yes");
        const t = {
            accepted: [],
            rejected: []
        };
        for (const n of e._ckyStore._categories)
            e._ckySetInStore(`${n.slug}`, "yes"),
            t.accepted.push(n.slug);
        b(),
        e._nodeListObserver.disconnect(),
        document.createElement = e._ckyCreateElementBackup,
        k("cookieyes_consent_update", t),
        v(),
        L()
    }
    function h(t) {
        let {cookies: n} = t;
        const o = e._ckyGetCookieMap();
        for (const {cookieID: t, domain: c} of n) {
            const n = w(o, t);
            if (n) {
                const t = window.location.host
                  , r = t.replace("www", "");
                [c, "", t, r].map((t => e._ckySetCookie(n, "", 0, t))),
                delete o[n];
                continue
            }
            const r = w(localStorage, t);
            r && localStorage.removeItem(r);
            const a = w(sessionStorage, t);
            a && sessionStorage.removeItem(a)
        }
    }
    function w(t, n) {
        try {
            (n = e._ckyEscapeRegex(n)).includes("*") && (n = n.replace("\\*", ".+")),
            n = `^${n}$`;
            return Object.keys(t).find((e => new RegExp(n).test(e)))
        } catch (e) {
            return ""
        }
    }
    function v() {
        i() && (a("set", "developer_id.dY2Q2ZW", !0),
        C())
    }
    function C() {
        if (!i())
            return;
        const e = r("functional")
          , t = r("advertisement");
        a("consent", "update", {
            ad_storage: t,
            ad_user_data: t,
            ad_personalization: t,
            analytics_storage: r("analytics"),
            functionality_storage: e,
            personalization_storage: e,
            security_storage: "granted"
        }),
        a({
            event: "cookie_consent_update"
        })
    }
    function L() {
        window.uetq = window.uetq || [],
        $()
    }
    function $() {
        !async function() {
            await de(),
            window.uetq.push(...arguments)
        }("consent", "update", {
            ad_storage: r("advertisement")
        })
    }
    function T(t) {
        const n = / OR /i.test(t)
          , o = / AND /i.test(t);
        if (!n && !o)
            return function(t) {
                const [n,o] = t.split(/ IS | IS_NOT | IN | NOT_IN /i);
                switch (!0) {
                case / IS /i.test(t):
                    return !("regionName" !== n || "'EU'" !== o || !e._ckyStore._ruleData._euStatus) || A(n) === o;
                case / IS_NOT /i.test(t):
                    return A(n) !== o;
                case / IN /i.test(t):
                    return o.replace(/\[|\]/g, "").split(",").includes(A(n));
                case / NOT_IN /i.test(t):
                    return !o.replace(/\[|\]/g, "").split(",").includes(A(n));
                default:
                    return !1
                }
            }(t);
        const c = t.split(n ? / OR /i : / AND /i);
        for (const e of c) {
            const t = T(e);
            if (n && t)
                return !0;
            if (!n && !t)
                return !1
        }
        return !n
    }
    function A(t) {
        switch (!0) {
        case !!e._ckyStore._ruleData[`_${t}`]:
            return `'${e._ckyStore._ruleData[`_${t}`]}'`;
        case "" === e._ckyStore._ruleData[`_${t}`]:
            return "";
        case !!window.ckySettings && !!window.ckySettings[t]:
            return `'${window.ckySettings[t]}'`;
        default:
            return ""
        }
    }
    function M() {
        let t = !(arguments.length > 0 && void 0 !== arguments[0]) || arguments[0]
          , n = d
          , c = u;
        t || (n = u,
        c = d,
        function() {
            if ("function" != typeof window.requestAnimationFrame)
                return;
            if (!o) {
                const e = g("=revisit-consent", !1);
                e && (o = e.firstChild)
            }
            if (!o)
                return;
            let e = 0;
            const t = () => {
                "visible" === window.getComputedStyle(o).visibility ? (o.focus(),
                o = null) : e < 100 && (e++,
                requestAnimationFrame(t))
            }
            ;
            requestAnimationFrame(t)
        }());
        const {activeLaw: r, bannerType: a} = e._ckyStore._bannerConfig;
        "classic" === a ? (p("=settings-button", t ? "true" : "false"),
        n("=notice", "cky-consent-bar-expand")) : (c(".cky-overlay", "cky-hide", !1),
        n("gdpr" === r ? "=detail" : "=optout-popup", "cky-modal-open")),
        function(t) {
            const {activeLaw: n, bannerType: o} = e._ckyStore._bannerConfig
              , c = "classic" === o ? "=notice" : "ccpa" === n ? "=optout-popup" : "=detail"
              , r = g(c);
            if (!r)
                return;
            const a = t ? "addEventListener" : "removeEventListener";
            r[a]("keydown", K)
        }(t)
    }
    function j() {
        let t = !(arguments.length > 0 && void 0 !== arguments[0]) || arguments[0];
        t && !(arguments.length > 1 && void 0 !== arguments[1] && arguments[1]) && (e._ckyStore._bannerDisplayState = "banner");
        const n = t ? u : d;
        n("=notice", "cky-hide"),
        "popup" === e._ckyStore._bannerConfig.bannerType && n(".cky-overlay", "cky-hide", !1)
    }
    function E() {
        let t = !(arguments.length > 0 && void 0 !== arguments[0]) || arguments[0];
        if (t && (e._ckyStore._bannerDisplayState = "revisit"),
        !e._ckyStore._bannerConfig.showToggler)
            return;
        (t ? u : d)("=revisit-consent", "cky-revisit-hide", !1)
    }
    function N() {
        let t = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : "init";
        "redraw" === t && function() {
            const e = document.querySelectorAll(".cky-audit-table-element");
            if (e.length < 1)
                return;
            for (const t of e)
                t.innerHTML = ""
        }(),
        e._ckyStore._auditTable._headerKeys = function() {
            const t = e._ckyStore._language._store.get(e._ckyStore._language._active)
              , n = [];
            for (const e in t)
                e.includes("cky_audit_table_header_") && n.push(e.replace("cky_audit_table_header_", ""));
            return n
        }();
        const {showAuditTable: n, activeLaw: o} = e._ckyStore._bannerConfig;
        n && "gdpr" === o && function() {
            const t = e._ckyStore._commonShortCodes.find((e => "cky_audit_table" === e.key))
              , n = e._ckyStore._commonShortCodes.find((e => "cky_audit_table_empty" === e.key));
            for (const o of e._ckyStore._categories) {
                const e = D(o, t.content.container, n.content.container);
                document.querySelector(`#ckyDetailCategory${o.slug} [data-cky-tag="audit-table"]`).insertAdjacentHTML("beforeend", e)
            }
        }(),
        I(),
        "init" === t && new MutationObserver(I).observe(document.documentElement, {
            childList: !0,
            subtree: !0
        })
    }
    function D(t, n, o) {
        if (0 === t.cookies.length)
            return o.replace("[cky_audit_table_empty_text]", f("cky_audit_table_empty_text"));
        let c = "";
        for (const o of t.cookies) {
            let t = "";
            for (const n of e._ckyStore._auditTable._headerKeys)
                t = `${t}<li><div>${f(`cky_audit_table_header_${n}`)}</div><div>${"id" === n ? o.cookieID : f(`cookies.${o.cookieID}.${n}`)}</div></li>`;
            c = `${c}${n.replace("[CONTENT]", t)}`
        }
        return c
    }
    function I() {
        const t = Array.from(document.querySelectorAll(".cky-audit-table-element")).filter((e => {
            let {innerHTML: t} = e;
            return ["", "&nbsp;", " "].includes(t)
        }
        )).map((e => (e.innerHTML = "",
        e)));
        if (t.length < 1)
            return;
        document.getElementById("cky-audit-table-style") || document.head.insertAdjacentHTML("beforeend", '<style id="cky-audit-table-style">.cky-table-wrapper{width: 100%; max-width: 100%; overflow: auto;}.cky-cookie-audit-table{font-family: inherit; border-collapse: collapse; width: 100%;}.cky-cookie-audit-table th{background-color: #d9dfe7; border: 1px solid #cbced6;}.cky-cookie-audit-table td{border: 1px solid #d5d8df;}.cky-cookie-audit-table th,.cky-cookie-audit-table td{text-align: left; padding: 10px; font-size: 12px; color: #000000; word-break: normal;}.cky-cookie-audit-table td p{font-size: 12px; line-height: 24px; margin-bottom: 1em;}.cky-cookie-audit-table td p:last-child{margin-bottom: 0;}.cky-cookie-audit-table tr:nth-child(2n + 1) td{background: #f1f5fa;}.cky-cookie-audit-table tr:nth-child(2n) td{background: #ffffff;}.cky-audit-table-element h3{margin: 35px 0 16px 0;}.cky-audit-table-element .cky-table-wrapper{margin-bottom: 1rem;}.cky-audit-table-element .cky-category-des p{margin-top: 0;}</style>');
        const n = e._ckyStore._commonShortCodes.find((e => "cky_outside_audit_table" === e.key));
        for (const o of e._ckyStore._categories) {
            const e = x(o, n.content.container);
            if (e)
                for (const n of t)
                    n.insertAdjacentHTML("beforeend", e)
        }
    }
    function x(t, n) {
        if (0 === t.cookies.length)
            return "";
        const {_headerKeys: o} = e._ckyStore._auditTable
          , c = n.replace("[cky_preference_{{category_slug}}_title]", f(`cky_preference_${t.slug}_title`)).replace("[cky_preference_{{category_slug}}_description]", f(`cky_preference_${t.slug}_description`));
        let r = "<thead><tr>";
        for (const e of o)
            r = `${r}<th>${f(`cky_audit_table_header_${e}`)}</th>`;
        r = `${r}</tr></thead><tbody>`;
        for (const e of t.cookies) {
            let t = "<tr>";
            for (const n of o)
                t = `${t}<td>${"id" === n ? e.cookieID : f(`cookies.${e.cookieID}.${n}`)}</td>`;
            r = `${r}${t}</tr>`
        }
        return r = `${r}</tbody>`,
        c.replace("[CONTENT]", r)
    }
    function q(e) {
        const t = document.querySelector(`[data-cky-tag="${e}"]`);
        if (!t)
            return [];
        const n = Array.from(t.querySelectorAll('a:not([disabled]), button:not([disabled]), [tabindex]:not([disabled]):not([tabindex="-1"])')).filter((e => "none" !== e.style.display));
        return n.length <= 0 ? [] : [n[0], n[n.length - 1]]
    }
    function O(e, t) {
        let n = arguments.length > 2 && void 0 !== arguments[2] && arguments[2]
          , o = arguments.length > 3 && void 0 !== arguments[3] && arguments[3];
        e && t && e.addEventListener("keydown", (e => {
            9 !== e.which || n && !e.shiftKey || !n && e.shiftKey || o && !function() {
                const e = g("=notice");
                if (!e)
                    return !1;
                const {width: t, height: n} = e.getBoundingClientRect();
                return t * n / (window.innerWidth * window.innerHeight) >= .6
            }() || (e.preventDefault(),
            t.focus())
        }
        ))
    }
    function F() {
        const {activeLaw: t, bannerType: n} = e._ckyStore._bannerConfig;
        if (M(!1, !0),
        "revisit" !== e._ckyStore._bannerDisplayState) {
            j();
            const e = document.querySelector(`[data-cky-tag="${"gdpr" === t ? "settings-button" : "donotsell-button"}"]`);
            return e && e.focus()
        }
        "classic" === n && j(!1),
        E()
    }
    function H() {
        if (_(),
        "classic" === e._ckyStore._bannerConfig.bannerType) {
            const e = g("=powered-by")
              , t = Z();
            return e && (e.style.display = t ? "flex" : "none"),
            M(!t)
        }
        j(!1),
        M(),
        P()
    }
    function P() {
        if ("function" != typeof window.requestAnimationFrame)
            return;
        const [t] = q("ccpa" === e._ckyStore._bannerConfig.activeLaw ? "optout-popup" : "detail");
        if (!t)
            return;
        let n = 0;
        const o = () => {
            "visible" === window.getComputedStyle(t).visibility ? t.focus() : n < 100 && (n++,
            requestAnimationFrame(o))
        }
        ;
        requestAnimationFrame(o)
    }
    function G() {
        if (_(),
        E(!1),
        "classic" === e._ckyStore._bannerConfig.bannerType) {
            const e = g("=powered-by");
            e && (e.style.display = "none"),
            j(!0, !0)
        }
        M(),
        P()
    }
    function B() {
        let t = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : "custom";
        return n => {
            const {activeLaw: c} = e._ckyStore._bannerConfig;
            S(t, n.isTrusted),
            j(!1);
            const r = g("gdpr" === c ? "=settings-button" : "=donotsell-button", !1);
            o === r && (o = null),
            M(!1),
            E()
        }
    }
    function R() {
        var t;
        t = "yes",
        e._ckySetInStore("action", t),
        j(!1),
        E()
    }
    function K(e) {
        "Escape" === e.key && F()
    }
    function W() {
        if (!e._ckyStore._bannerConfig.showAuditTable)
            return;
        const t = e._ckyStore._categories.map((e => {
            let {slug: t} = e;
            return t
        }
        ));
        t.map((e => {
            const n = `#ckyDetailCategory${e}`
              , o = `${n}  .cky-accordion-btn`;
            s(n, (c => {
                let {target: {id: r}} = c;
                if (r === `ckySwitch${e}` || !function() {
                    return y("toggle", ...arguments)
                }(n, "cky-accordion-active", !1))
                    return p(o, "false");
                p(o, "true"),
                t.filter((t => t !== e)).map((e => {
                    u(`#ckyDetailCategory${e}`, "cky-accordion-active", !1),
                    p(`#ckyDetailCategory${e} .cky-accordion-btn`, "false")
                }
                ))
            }
            ))
        }
        ))
    }
    async function z() {
        let t = !(arguments.length > 0 && void 0 !== arguments[0]) || arguments[0];
        await de();
        const {dataShortCodes: n, togglerSwitch: o, activeLaw: c} = e._ckyStore._bannerConfig
          , r = n.find((e => "cky_category_toggle_label" === e.key));
        for (const n of e._ckyStore._categories) {
            const a = e._ckyGetFromStore(n.slug)
              , i = "yes" === a || !a && n.defaultConsent[c]
              , s = r.content.container.replace("[cky_preference_{{category_slug}}_title]", f(`cky_preference_${n.slug}_title`));
            ["ckyCategoryDirect", "ckySwitch"].map((e => U(g(`#${e}${n.slug}`), s, {
                checked: i,
                disabled: n.isNecessary,
                addListeners: t
            }, o.styles)))
        }
    }
    function U(e, t, n, o) {
        let {checked: c, disabled: r, addListeners: a} = n
          , {activeColor: i, inactiveColor: l} = o
          , d = arguments.length > 4 && void 0 !== arguments[4] && arguments[4];
        e && (d && a && s("=optout-option-title", ( () => e.click())),
        e.checked = c,
        e.disabled = r,
        e.style.backgroundColor = c ? i : l,
        J(e, c, t, d),
        a && e.addEventListener("change", (n => {
            let {currentTarget: o} = n;
            const c = o.checked;
            o.style.backgroundColor = c ? i : l,
            J(e, c, t, d)
        }
        )))
    }
    function J(e, t, n) {
        const o = t ? "disable" : "enable"
          , c = `cky_${o}_${arguments.length > 3 && void 0 !== arguments[3] && arguments[3] ? "optout" : "category"}_label`
          , r = n.replace(/{{status}}/g, o).replace(`[${c}]`, f(c));
        e.setAttribute("aria-label", r)
    }
    function Y() {
        let e = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : "";
        return (e ? ["ckySwitch", "ckyCategoryDirect"] : ["ckyCCPAOptOut"]).some((t => {
            const n = g(`#${t}${e}`);
            return n && n.checked
        }
        ))
    }
    function Q() {
        const {readMore: t, activeLaw: n} = e._ckyStore._bannerConfig;
        t.status && function(t, n, o, c) {
            const r = e._ckyStore._bannerConfig.dataShortCodes.find((e => e.key === t))
              , a = `&nbsp;${e._ckyReplaceAll(r.processedHTML, `[${n}]`, f(n)).replace('href="#"', `href="${f(o)}"`)}`
              , i = document.querySelector(`[data-cky-tag="${c}"] p:last-child`);
            i && i.insertAdjacentHTML("beforeend", a)
        }("cky_readmore", "cky_readmore_text", "cky_readmore_privacyLink", "description")
    }
    function V() {
        let t = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : null;
        const {manualLinkColor: n} = e._ckyStore._bannerConfig;
        if (!n)
            return;
        if (t)
            return void t.querySelectorAll("a:not([rel])").forEach((e => {
                e.style.color = n
            }
            ));
        document.querySelectorAll(".cky-consent-bar a:not([rel]), .cky-preference-center a:not([rel])").forEach((e => {
            e.style.color = n
        }
        ))
    }
    function Z() {
        const {activeLaw: t, bannerType: n} = e._ckyStore._bannerConfig;
        return "classic" === n ? l("=notice", "cky-consent-bar-expand") : l("gdpr" === t ? "=detail" : "=optout-popup", "cky-modal-open")
    }
    function X() {
        const t = Z();
        return ["=notice", "=detail", "=optout-popup", ".cky-overlay", "=revisit-consent"].map(( (e, t) => function(e) {
            const t = g(e, !(arguments.length > 1 && void 0 !== arguments[1]) || arguments[1]);
            t && t.remove()
        }(e, t < 3))),
        ie(),
        N("redraw"),
        t ? ("classic" === e._ckyStore._bannerConfig.bannerType && j(!0, !0),
        M()) : "banner" === e._ckyStore._bannerDisplayState ? j() : void E()
    }
    async function ee() {
        let t = arguments.length > 0 && void 0 !== arguments[0] && arguments[0];
        try {
            await de();
            const n = JSON.stringify(e._ckyStore._categories.map((t => {
                let {slug: n} = t;
                return {
                    name: n,
                    status: e._ckyGetFromStore(n) || "no"
                }
            }
            )).concat([{
                name: "CookieYes Consent",
                status: "ccpa" === e._ckyStore._bannerConfig.activeLaw ? "yes" : e._ckyGetFromStore("consent") || "no"
            }]))
              , o = new FormData;
            o.append("log", n),
            o.append("key", "040a441d4818e9d47ed2318bd7caaed6"),
            o.append("consent_id", e._ckyGetFromStore("consentid")),
            o.append("language", e._ckyStore._language._active),
            o.append("consented_domain", window.location.host),
            o.append("cookie_list_version", "7"),
            navigator.sendBeacon("https://log.cookieyes.com/api/v1/consent", o),
            t && location.reload()
        } catch (e) {
            console.error(e)
        }
    }
    async function te(t) {
        try {
            if (e._ckyStore._language._active === t)
                return;
            await re(t),
            e._ckyStore._language._active = t,
            X()
        } catch (e) {
            console.error(e)
        }
    }
    function ne(e) {
        for (const t of e) {
            if ("attributes" !== t.type || "lang" !== t.attributeName)
                continue;
            te(oe(document.documentElement.lang))
        }
    }
    function oe(t) {
        return t = t.replace(/_/g, "-"),
        e._ckyStore._language._localeMap[t] ? e._ckyStore._language._localeMap[t] : e._ckyStore._language._supportedMap[t] ? t : (t = t.split("-")[0],
        e._ckyStore._language._supportedMap[t] ? t : e._ckyStore._language._default)
    }
    async function ce(e) {
        const t = await c(e);
        if (!t.ok)
            throw new Error("Invalid response");
        const n = await t.json();
        if (!n || "object" != typeof n || 0 === Object.keys(n).length)
            throw new Error("Invalid response");
        return n
    }
    async function re(t) {
        const n = e._ckyStore._language._store.get(t);
        if (n && n.setAuditTableContent && n.setLanguageContent)
            return;
        let o = {};
        n && n.setLanguageContent || !e._ckyStore._bannerConfig.languageMap || !e._ckyStore._bannerConfig.languageMap[t] || (o = await ce(`https://cdn-cookieyes.com/client_data/040a441d4818e9d47ed2318bd7caaed6/translations/${e._ckyStore._bannerConfig.languageMap[t]}.json`));
        let c = {};
        return n && n.setAuditTableContent || (c = await ce(`https://cdn-cookieyes.com/client_data/040a441d4818e9d47ed2318bd7caaed6/audit-table/${e._ckyStore._language._supportedMap[t]}.json`)),
        e._ckyStore._language._store.set(t, {
            ...o,
            ...c,
            setLanguageContent: Object.keys(o).length > 0,
            setAuditTableContent: Object.keys(c).length > 0
        }),
        t
    }
    async function ae() {
        try {
            const t = oe(document.documentElement.lang);
            e._ckyStore._language._active = t,
            await re(t);
            new MutationObserver(ne).observe(document.querySelector("html"), {
                attributes: !0
            })
        } catch (e) {
            console.error(e)
        }
    }
    function ie() {
        const {html: t, css: o, activeLaw: c, bannerType: r} = e._ckyStore._bannerConfig;
        document.head.insertAdjacentHTML("beforeend", o);
        const a = function(t) {
            const n = e._ckyStore._language._store.get(e._ckyStore._language._active)
              , o = Object.keys(n).reduce(( (t, o) => (e._ckyStartsWith(o, "cky_") && (t[`[${o}]`] = n[o] || ""),
            t)), {})
              , c = new RegExp(Object.keys(o).join("|").replace(/[\[\]]/g, "\\$&"),"gi");
            return t.replace(c, (e => o[e]))
        }(t);
        document.body.insertAdjacentHTML("afterbegin", a),
        n = new Map(Array.from(document.querySelectorAll("[data-cky-tag]")).map((e => [e.dataset.ckyTag, e]))),
        "classic" === r && p("=settings-button", "false"),
        z(),
        W(),
        ["=accept-button", "=detail-accept-button"].map((e => s(e, B("all")))),
        ["=reject-button", "=detail-reject-button"].map((e => s(e, B("reject")))),
        ["=detail-save-button", "=detail-category-preview-save-button", "=optout-confirm-button"].map((e => s(e, B()))),
        ["=settings-button", "=donotsell-button"].map((e => s(e, H))),
        ["=optout-cancel-button", "=detail-close", "=optout-close"].map((e => s(e, F))),
        s("=close-button", R),
        s("=revisit-consent", G),
        e._ckySetPlaceHolder(),
        Q(),
        V(),
        function() {
            const {dataShortCodes: t, activeLaw: n} = e._ckyStore._bannerConfig
              , o = t.find((e => "cky_show_desc" === e.key))
              , c = t.find((e => "cky_hide_desc" === e.key));
            if (!o || !c)
                return;
            const r = `${e._ckyReplaceAll(c.processedHTML, "[cky_showless_text]", f("cky_showless_text"))}`
              , a = `${e._ckyReplaceAll(o.processedHTML, "[cky_showmore_text]", f("cky_showmore_text"))}`
              , i = window.innerWidth < 376 ? 150 : 300
              , l = document.querySelector(`[data-cky-tag="${"gdpr" === n ? "detail" : "optout"}-description"]`);
            if (l.textContent.length < i)
                return;
            const d = l.innerHTML
              , u = (new DOMParser).parseFromString(d, "text/html").querySelectorAll("body > p");
            if (u.length <= 1)
                return;
            let y = "";
            for (let e = 0; e < u.length; e++) {
                if (e === u.length - 1)
                    return;
                const t = u[e];
                if (`${y}${t.outerHTML}`.length > i && t.insertAdjacentHTML("beforeend", `...&nbsp;${a}`),
                y = `${y}${t.outerHTML}`,
                y.length > i)
                    break
            }
            const _ = (new DOMParser).parseFromString(y, "text/html").querySelectorAll("p").length;
            function k() {
                l.innerHTML = `${d}${r}`,
                V(l);
                const e = l.querySelectorAll("p");
                e[_] && (e[_].setAttribute("tabindex", "-1"),
                e[_].style.outline = "none",
                e[_].focus()),
                s("gdpr" === n ? "=hide-desc-button" : "=optout-hide-desc-button", p)
            }
            function p() {
                l.innerHTML = y,
                V(l);
                const e = "gdpr" === n ? "=show-desc-button" : "=optout-show-desc-button";
                s(e, k);
                const t = g(e, !1);
                t && t.focus()
            }
            p()
        }(),
        function() {
            const {activeLaw: t, bannerType: n} = e._ckyStore._bannerConfig;
            if ("classic" === n)
                return;
            const [o,c] = q("notice")
              , r = "popup" !== n;
            O(o, c, !0, r),
            O(c, o, !1, r);
            const [a,i] = q("ccpa" === t ? "optout-popup" : "detail");
            O(a, i, !0),
            O(i, a)
        }(),
        e._ckyStore._bannerAttached = !0
    }
    async function se(t) {
        const n = await c(`https://cdn-cookieyes.com/client_data/040a441d4818e9d47ed2318bd7caaed6/config/${t}.json`)
          , o = await n.json();
        e._ckyStore._bannerConfig = o,
        await ae(),
        e._ckyStore._gpcStatus = !!navigator.globalPrivacyControl,
        o.shouldFollowGPC = o.respectGPC && e._ckyStore._gpcStatus,
        ie();
        if (!e._ckyGetFromStore("action"))
            return function() {
                const {activeLaw: t, shouldFollowGPC: n} = e._ckyStore._bannerConfig;
                e._ckySetInStore("consent", "ccpa" === t && n ? "yes" : "no");
                const o = {
                    accepted: [],
                    rejected: []
                };
                for (const n of e._ckyStore._categories) {
                    let c = "yes";
                    n.isNecessary || n.defaultConsent[t] || (c = "no"),
                    "no" === c ? o.rejected.push(n.slug) : o.accepted.push(n.slug),
                    e._ckySetInStore(`${n.slug}`, c)
                }
                b(),
                k("cookieyes_consent_update", o),
                v(),
                L()
            }(),
            j();
        v(),
        L(),
        e._ckyStore._isPreview ? j() : E()
    }
    async function le(t) {
        try {
            t && document.removeEventListener("DOMContentLoaded", le);
            const n = await async function() {
                try {
                    const t = await c("https://cdn-cookieyes.com/client_data/040a441d4818e9d47ed2318bd7caaed6/e14ES3Jd.json");
                    if (e.ruleSet = await t.json(),
                    !Array.isArray(e.ruleSet) || e.ruleSet.length <= 0)
                        return !1;
                    if (e._ckyStore._isPreview) {
                        const t = e.ruleSet[e.ruleSet.length - 1];
                        return e._ckyStore._banners[t.targetBanner]
                    }
                    for (const t of e.ruleSet)
                        if ("all" === t.condition || T(t.condition))
                            return e._ckyStore._banners[t.targetBanner]
                } catch (e) {}
                return !1
            }();
            if (n) {
                await se(n);
                for (const t of e._ckyStore._categories)
                    "yes" !== e._ckyGetFromStore(t.slug) && h(t);
                document.querySelector("body").addEventListener("click", (e => {
                    const t = ".cky-banner-element, .cky-banner-element *";
                    (e.target.matches ? e.target.matches(t) : e.target.msMatchesSelector(t)) && G()
                }
                ))
            } else
                m(),
                await ae();
            k("cookieyes_banner_load", getCkyConsent()),
            N()
        } catch (e) {
            console.error(e)
        }
    }
    function de() {
        return new Promise((e => {
            setTimeout(e, 0)
        }
        ))
    }
    window.revisitCkyConsent = () => G(),
    window.performBannerAction = e => B("accept_all" === e ? "all" : "accept_partial" === e ? "custom" : "reject")({
        isTrusted: !0
    }),
    window.getCkyConsent = function() {
        const t = {
            activeLaw: "",
            categories: {},
            isUserActionCompleted: !1,
            consentID: "",
            languageCode: ""
        };
        try {
            t.activeLaw = e._ckyStore._bannerConfig.activeLaw || "",
            e._ckyStore._categories.forEach((n => {
                t.categories[n.slug] = "yes" === e._ckyGetFromStore(n.slug)
            }
            )),
            t.isUserActionCompleted = "yes" === e._ckyGetFromStore("action"),
            t.consentID = e._ckyGetFromStore("consentid") || "",
            t.languageCode = e._ckyStore._language._active || ""
        } catch (e) {}
        return t
    }
    ,
    e._ckySetPlaceHolder = function() {
        let t = arguments.length > 0 && void 0 !== arguments[0] ? arguments[0] : "";
        const {status: n, styles: o} = e._ckyStore._bannerConfig.placeHolder;
        if (!n)
            return;
        const c = (t ? `#${t} ` : "") + '[data-cky-tag="placeholder-title"]'
          , r = document.querySelectorAll(c);
        r.length < 1 || Array.from(r).forEach((t => {
            t.innerHTML = f("cky_video_placeholder_title"),
            t.style.display = "block",
            t.addEventListener("click", ( () => {
                "revisit" === e._ckyStore._bannerDisplayState && G()
            }
            ));
            for (const e in o)
                o[e] && (t.style[e] = o[e])
        }
        ))
    }
    ,
    "loading" !== document.readyState ? le() : document.addEventListener("DOMContentLoaded", le)
}();
