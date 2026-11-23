// src/utils/bannerCookieList.js
//
// The cookie list shown inside the banner's preferences popup: under each category,
// the vendors that set cookies there, each with a privacy-policy link and its cookies
// (name, description, type, retention). Wired into handlers/cdnTest.js (/cdn-test/),
// cdnNm.js (readable source) and cdnM.js (the live script.js) - all three serve this add-on.
//
// Data = the Scan tab's list (handleCookies: latest scan + published rules + manual
// cookies). Never cookie values. Uncategorized cookies have no toggle to sit under,
// so they are left out unless a well-known name tells us the category.

import { handleCookies } from '../handlers/cookies.js';
import { vendorPrivacyLink } from '../data/vendorPrivacyLinks.js';

const MAX_COOKIES = 150;

// Scan/rule categories → the banner's four toggles.
const TOGGLE_OF = {
  necessary: 'necessary', essential: 'necessary', strictly_necessary: 'necessary',
  analytics: 'analytics', performance: 'analytics', statistics: 'analytics', behavioral: 'analytics',
  marketing: 'marketing', advertisement: 'marketing', advertising: 'marketing', targeting: 'marketing',
  functional: 'preferences', functionality: 'preferences', preferences: 'preferences',
};

// Well-known cookies: fills an empty description, and a category when the scan left
// it uncategorized. Keyed by exact name or by prefix ending in '*'. `ret` is the
// vendor's documented lifetime, used when the browser can't expose an expiry and for
// cookies listed from a detected tracker script (see TRACKER_SCRIPTS).
const KNOWN_COOKIES = {
  __cf_bm: { cat: 'necessary', vendor: 'Cloudflare', desc: 'Bot Management - identifies and mitigates automated traffic', ret: '30 minutes' },
  cf_clearance: { cat: 'necessary', vendor: 'Cloudflare', desc: 'Records that the visitor passed a Cloudflare security challenge', ret: '1 year' },
  __cfruid: { cat: 'necessary', vendor: 'Cloudflare', desc: 'Identifies trusted web traffic for rate limiting', ret: 'Session' },
  _cfuvid: { cat: 'necessary', vendor: 'Cloudflare', desc: 'Distinguishes visitors sharing an IP address for rate limiting', ret: 'Session' },
  'consentbit*': { cat: 'necessary', vendor: 'ConsentBit', desc: "Stores the visitor's cookie consent choices", ret: '' },
  _ga: { cat: 'analytics', vendor: 'Google', desc: 'Distinguishes unique visitors for Google Analytics', ret: '2 years' },
  '_ga_*': { cat: 'analytics', vendor: 'Google', desc: 'Keeps the session state for Google Analytics 4', ret: '2 years' },
  _gid: { cat: 'analytics', vendor: 'Google', desc: 'Distinguishes visitors for 24 hours in Google Analytics', ret: '1 day' },
  _gat: { cat: 'analytics', vendor: 'Google', desc: 'Throttles the Google Analytics request rate', ret: '1 minute' },
  _gcl_au: { cat: 'marketing', vendor: 'Google', desc: 'Stores ad click information for Google Ads conversion tracking', ret: '3 months' },
  _fbp: { cat: 'marketing', vendor: 'Meta', desc: 'Identifies browsers for Meta (Facebook) advertising', ret: '3 months' },
  _fbc: { cat: 'marketing', vendor: 'Meta', desc: 'Stores the last Facebook ad click', ret: '3 months' },
  'ph_*': { cat: 'analytics', vendor: 'PostHog', desc: 'Identifies the visitor and session for PostHog product analytics', ret: '1 year' },
  _clck: { cat: 'analytics', vendor: 'Microsoft', desc: 'Keeps the Microsoft Clarity user ID across visits', ret: '1 year' },
  _clsk: { cat: 'analytics', vendor: 'Microsoft', desc: 'Joins page views into one Microsoft Clarity session', ret: '1 day' },
  _uetsid: { cat: 'marketing', vendor: 'Microsoft', desc: 'Microsoft Advertising (UET) session identifier', ret: '1 day' },
  _uetvid: { cat: 'marketing', vendor: 'Microsoft', desc: 'Microsoft Advertising (UET) visitor identifier', ret: '13 months' },
  bcookie: { cat: 'marketing', vendor: 'LinkedIn', desc: 'Browser identifier used by LinkedIn', ret: '1 year' },
  lidc: { cat: 'marketing', vendor: 'LinkedIn', desc: 'Routes requests to LinkedIn data centers', ret: '1 day' },
  '_hjSession*': { cat: 'analytics', vendor: 'Hotjar', desc: 'Keeps the current Hotjar session', ret: '30 minutes' },
  _ttp: { cat: 'marketing', vendor: 'TikTok', desc: 'Measures TikTok ad performance', ret: '13 months' },
  hubspotutk: { cat: 'marketing', vendor: 'HubSpot', desc: 'Tracks the visitor for HubSpot', ret: '6 months' },
  'intercom-id-*': { cat: 'preferences', vendor: 'Intercom', desc: 'Remembers you between visits so chat conversations persist', ret: '9 months' },
  'intercom-session-*': { cat: 'preferences', vendor: 'Intercom', desc: 'Keeps the current Intercom messenger session', ret: '1 week' },
  'intercom-device-id-*': { cat: 'preferences', vendor: 'Intercom', desc: 'Identifies the device for the Intercom messenger', ret: '9 months' },
};

// Tracker scripts → the cookies they set. The runtime add-on matches these against
// every script/iframe URL on the page (including ones the blocker has parked in
// data-cb-blocked-src), so the popup can disclose a tracker's cookies BEFORE consent,
// when the browser doesn't hold them yet and the site may never have been scanned.
// Regex sources (strings) so they can be shipped to the browser as-is.
const TRACKER_SCRIPTS = [
  { match: 'google-analytics\\.com|googletagmanager\\.com/gtag/js|googletagmanager\\.com/gtm\\.js', cookies: ['_ga', '_ga_*', '_gid', '_gat'] },
  { match: 'googleadservices\\.com|doubleclick\\.net|googlesyndication\\.com', cookies: ['_gcl_au'] },
  { match: 'connect\\.facebook\\.net|facebook\\.com/tr', cookies: ['_fbp', '_fbc'] },
  { match: 'static\\.hotjar\\.com|script\\.hotjar\\.com', cookies: ['_hjSession*'] },
  { match: 'clarity\\.ms', cookies: ['_clck', '_clsk'] },
  { match: 'bat\\.bing\\.com', cookies: ['_uetsid', '_uetvid'] },
  { match: 'posthog\\.com|posthog\\.js', cookies: ['ph_*'] },
  { match: 'intercom\\.io|intercomcdn\\.com', cookies: ['intercom-id-*', 'intercom-session-*', 'intercom-device-id-*'] },
  { match: 'hs-scripts\\.com|hs-analytics\\.net|hsforms\\.net', cookies: ['hubspotutk'] },
  { match: 'snap\\.licdn\\.com|px\\.ads\\.linkedin\\.com', cookies: ['bcookie', 'lidc'] },
  { match: 'analytics\\.tiktok\\.com', cookies: ['_ttp'] },
];

function knownCookie(name) {
  const n = String(name || '');
  if (KNOWN_COOKIES[n]) return KNOWN_COOKIES[n];
  for (const key of Object.keys(KNOWN_COOKIES)) {
    if (key.endsWith('*') && n.startsWith(key.slice(0, -1))) return KNOWN_COOKIES[key];
  }
  return null;
}

function hostOf(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    .replace(/^\.+/, '').replace(/^www\./, '');
}

function parseTime(v) {
  if (!v) return NaN;
  const s = String(v);
  return Date.parse(s.includes('T') || s.endsWith('Z') ? s : `${s.replace(' ', 'T')}Z`);
}

// expires is an absolute date taken at scan time, so retention = expires - seen.
function retention(expires, seenAt) {
  const end = parseTime(expires);
  if (!Number.isFinite(end)) return expires ? String(expires).slice(0, 40) : 'Session';
  const start = Number.isFinite(parseTime(seenAt)) ? parseTime(seenAt) : Date.now();
  const mins = Math.max(0, Math.round((end - start) / 60000));
  if (mins < 1) return 'Session';
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (mins < 60) return plural(mins, 'minute');
  const hours = Math.round(mins / 60);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 30) return plural(days, 'day');
  const months = Math.round(days / 30.44);
  if (months < 12) return plural(months, 'month');
  return plural(Math.round(days / 365.25), 'year');
}

/**
 * { necessary: [vendor], analytics: [...], marketing: [...], preferences: [...] }
 * where vendor = { v: name, u: privacy URL | null, c: [{ n, d, t, r }] }.
 * Short keys keep the served script small.
 */
export async function buildBannerCookieList(env, siteId, siteDomain) {
  const res = await handleCookies(new Request(`https://internal/api/cookies?siteId=${encodeURIComponent(siteId)}`), env);
  const data = await res.json().catch(() => null);
  const rows = data?.success && Array.isArray(data.cookies) ? data.cookies : [];
  const siteHost = hostOf(siteDomain);

  const out = { necessary: [], analytics: [], marketing: [], preferences: [] };
  const vendors = {};
  const seen = new Set();
  let count = 0;

  for (const row of rows) {
    if (count >= MAX_COOKIES) break;
    const name = String(row.name || '').trim();
    if (!name) continue;
    const known = knownCookie(name);
    const rawCat = String(row.category || '').trim().toLowerCase();
    const toggle = TOGGLE_OF[rawCat] || (known ? known.cat : null);
    if (!toggle) continue;

    const link = vendorPrivacyLink(row.provider) || (known ? vendorPrivacyLink(known.vendor) : null);
    const cookieHost = hostOf(row.domain);
    const vendorName =
      (link && link.name) || String(row.provider || '').trim() || (known && known.vendor) ||
      (cookieHost && cookieHost !== siteHost && !siteHost.endsWith(`.${cookieHost}`) ? cookieHost : siteHost) ||
      'This website';

    const dedupe = `${toggle}|${vendorName}|${name}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    const vkey = `${toggle}|${vendorName}`;
    if (!vendors[vkey]) {
      vendors[vkey] = { v: vendorName, u: link ? link.url : null, c: [] };
      out[toggle].push(vendors[vkey]);
    }
    vendors[vkey].c.push({
      n: name.slice(0, 80),
      d: String(row.description || (known && known.desc) || '').trim().slice(0, 200),
      t: 'Cookie',
      r: retention(row.expires, row.lastSeenAt || row.firstSeenAt),
    });
    count++;
  }

  for (const key of Object.keys(out)) {
    out[key].sort((a, b) => a.v.localeCompare(b.v));
    for (const v of out[key]) v.c.sort((a, b) => a.n.localeCompare(b.n));
  }
  return out;
}

/** Short fingerprint for the script ETag, so a new scan busts cached copies. */
export async function cookieListSignature(list) {
  try {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(JSON.stringify(list)));
    return Array.from(new Uint8Array(buf)).slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

/**
 * Client add-on, appended after the banner runtime. Waits for the GDPR preferences
 * popup (#cb-preferences-banner), tags its existing rows so the design CSS in
 * the cdn handlers (prefsDesignCss in cdnTest.js / cdnNm.js / cdnM.js) can restyle them, and adds the vendor/cookie
 * list inside each category's expandable panel. Plain DOM + textContent only (no
 * innerHTML), so scanned names can't inject markup. Runs even when the list is
 * empty so the popup always gets the new look.
 *
 * Data, merged in this order (first source to name a cookie wins):
 *   1. window.__CONSENT_SITE__.cookieList — the site's scan (what the site sets for
 *      everyone), built server-side by buildBannerCookieList().
 *   2. The visitor's own browser cookies (cookieStore.getAll() where available, else
 *      document.cookie), for names the scan doesn't already list.
 *   3. Tracker scripts found on the page (TRACKER_SCRIPTS, incl. ones the blocker has
 *      parked in data-cb-blocked-src) → the cookies that vendor is known to set. This is
 *      what fills the list before consent, when the live runtime has purged tracking
 *      cookies and the site may never have been scanned.
 * Only names in the known-cookie table are shown for 2 and 3, because an unknown name
 * has no category to sit under. Retention: browser expiry when exposed, else the
 * vendor's documented lifetime from the table, else "-".
 *
 * Design: Claude Design "Cookie Preferences" (2026-11-05). What it changes:
 *   - title + intro move into a header strip above the scroll body (.cb-cl-hd)
 *   - category rows get a chevron, a "N cookies" pill and a pill-shaped Always Active
 *   - clicking anywhere on a row header (not the switch) expands it
 *   - vendors render as sub-accordions with Privacy Policy link + cookie cards
 *   - the footer gains an Accept All button that triggers the initial banner's
 *     accept handler (same consent path, no second implementation)
 * The CCPA opt-out panel is left untouched.
 */
export function getBannerCookieListScript() {
  // Compact tables for the browser, derived from the server tables above so there is
  // one source of truth: K = { name-or-prefix*: [toggle, vendor, desc, retention] },
  // VU = { vendor: privacy URL }, D = [[regexSource, [cookie keys]]].
  const known = {};
  const vendorUrls = {};
  for (const [key, k] of Object.entries(KNOWN_COOKIES)) {
    known[key] = [k.cat, k.vendor, k.desc, k.ret || ''];
    if (!(k.vendor in vendorUrls)) {
      const link = vendorPrivacyLink(k.vendor);
      vendorUrls[k.vendor] = link ? link.url : null;
    }
  }
  const esc = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const knownJson = esc(known);
  const vendorJson = esc(vendorUrls);
  const trackerJson = esc(TRACKER_SCRIPTS.map((t) => [t.match, t.cookies]));
  return `
(function(){try{
var S=window.__CONSENT_SITE__||{},L=S.cookieList||{};
var K=${knownJson},VU=${vendorJson},D=${trackerJson};
var T={policy:"Privacy Policy",name:"Name",desc:"Purpose",type:"Type",ret:"Retention",accept:"Accept All",one:"cookie",many:"cookies"};
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
function count(vs){var n=0;for(var i=0;i<vs.length;i++)n+=(vs[i].c||[]).length;return n;}
function knownKey(n){if(K[n])return n;for(var k in K){if(k.charAt(k.length-1)==="*"&&n.indexOf(k.slice(0,-1))===0)return k;}return null;}
function plural(n,u){return n+" "+u+(n===1?"":"s");}
function fmt(ms){if(!(ms>0))return "";var m=Math.round(ms/60000);if(m<1)return "Session";if(m<60)return plural(m,"minute");var h=Math.round(m/60);if(h<24)return plural(h,"hour");var d=Math.round(h/24);if(d<30)return plural(d,"day");var mo=Math.round(d/30.44);if(mo<12)return plural(mo,"month");return plural(Math.round(d/365.25),"year");}
function tableRet(key){if(key==="consentbit*"){var days=S.customization&&Number(S.customization.cookieExpirationDays);return fmt((days>0?days:30)*86400000);}return (K[key]&&K[key][3])||"";}
function fromDoc(){var out=[],parts=(document.cookie||"").split(";");for(var i=0;i<parts.length;i++){var n=parts[i].split("=")[0].replace(/^\\s+|\\s+$/g,"");if(n)out.push({n:n,exp:null});}return out;}
function liveCookies(cb){try{if(window.cookieStore&&window.cookieStore.getAll){window.cookieStore.getAll().then(function(cs){cb(cs.map(function(c){return {n:c.name,exp:c.expires||null};}));},function(){cb(fromDoc());});return;}}catch(e){}cb(fromDoc());}
function pageSources(){var out=[],i,s;var sc=document.scripts||[];for(i=0;i<sc.length;i++){s=sc[i].getAttribute("data-cb-blocked-src")||sc[i].getAttribute("src");if(s)out.push(s);}var fr=document.getElementsByTagName("iframe");for(i=0;i<fr.length;i++){s=fr[i].getAttribute("data-cb-blocked-src")||fr[i].getAttribute("src");if(s)out.push(s);}return out;}
function detectedKeys(){var out=[],src=pageSources();for(var i=0;i<D.length;i++){var re;try{re=new RegExp(D[i][0],"i");}catch(e){continue;}for(var j=0;j<src.length;j++){if(re.test(src[j])){for(var k=0;k<D[i][1].length;k++)out.push(D[i][1][k]);break;}}}return out;}
function merged(live){
  var out={necessary:[],analytics:[],marketing:[],preferences:[]},seenName={},seenKey={},k,i,j;
  function place(name,key,ret){var kn=K[key];var arr=out[kn[0]]||out.necessary,v=null;for(var q=0;q<arr.length;q++)if(arr[q].v===kn[1]){v=arr[q];break;}
    if(!v){v={v:kn[1],u:VU[kn[1]]||null,c:[]};arr.push(v);}v.c.push({n:name,d:kn[2]||"",t:"Cookie",r:ret||"-"});}
  for(k in out){var vs=L[k]||[];for(i=0;i<vs.length;i++){var cs=vs[i].c||[];out[k].push({v:vs[i].v,u:vs[i].u,c:cs.slice()});for(j=0;j<cs.length;j++){seenName[cs[j].n]=1;var kk=knownKey(cs[j].n);if(kk)seenKey[kk]=1;}}}
  var now=Date.now();
  for(i=0;i<live.length;i++){var n=live[i].n;if(!n||seenName[n]||n==="consentbit-consentid")continue;var key=knownKey(n);if(!key)continue;seenName[n]=1;seenKey[key]=1;
    place(n,key,(live[i].exp?fmt(live[i].exp-now):"")||tableRet(key));}
  var det=detectedKeys();
  for(i=0;i<det.length;i++){if(seenKey[det[i]]||!K[det[i]])continue;seenKey[det[i]]=1;place(det[i],det[i],tableRet(det[i]));}
  for(k in out){out[k].sort(function(a,b){return a.v<b.v?-1:a.v>b.v?1:0;});for(i=0;i<out[k].length;i++)out[k][i].c.sort(function(a,b){return a.n<b.n?-1:a.n>b.n?1:0;});}
  return out;}
function field(dl,k,v,code){dl.appendChild(el("dt",null,k));var dd=el("dd");if(code)dd.appendChild(el("code",null,v||"-"));else dd.textContent=v||"-";dl.appendChild(dd);}
function vendorBox(vd){
  var box=el("div","cb-cl-ven");
  var head=el("div","cb-cl-ven-h");head.setAttribute("role","button");head.tabIndex=0;head.setAttribute("aria-expanded","false");head.setAttribute("aria-label",vd.v+" "+T.many);
  var nm=el("span","cb-cl-ven-n");nm.appendChild(el("span",null,vd.v));
  if(vd.u){var a=el("a","cb-cl-ven-p",T.policy);a.href=vd.u;a.target="_blank";a.rel="noopener noreferrer";a.addEventListener("click",function(ev){ev.stopPropagation();});nm.appendChild(a);}
  head.appendChild(nm);head.appendChild(el("span","cb-cl-chev cb-cl-chev-s"));
  var body=el("div","cb-cl-ven-b");
  var cs=vd.c||[];
  for(var i=0;i<cs.length;i++){var c=cs[i],dl=el("dl","cb-cl-ck");field(dl,T.name,c.n,true);field(dl,T.desc,c.d);field(dl,T.type,c.t);field(dl,T.ret,c.r);body.appendChild(dl);}
  function flip(){var open=box.classList.toggle("cb-cl-open");head.setAttribute("aria-expanded",open?"true":"false");}
  head.addEventListener("click",flip);
  head.addEventListener("keydown",function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();flip();}});
  box.appendChild(head);box.appendChild(body);return box;}
function catOf(item){var cb=item.querySelector('input[type="checkbox"][id^="cb-pref-"]');return cb?cb.id.replace("cb-pref-",""):"necessary";}
function render(banner,acc,M){
  var items=acc.children;
  for(var i=0;i<items.length;i++){
    var item=items[i];item.classList.add("cb-cl-cat");
    var head=item.firstElementChild;if(!head)continue;head.classList.add("cb-cl-cat-h");
    var exp=head.querySelector("button[aria-expanded]");if(exp)exp.classList.add("cb-cl-chev");
    var label=head.querySelector(".cb-gdpr-cat-label");
    var ctrl=head.lastElementChild;
    if(ctrl&&ctrl!==label&&ctrl!==exp){ctrl.classList.add("cb-cl-ctl");var badge=ctrl.querySelector("span");if(badge&&!ctrl.querySelector(".cb-pref-toggle-track"))badge.classList.add("cb-cl-always");}
    var k=catOf(item),vendors=M[k]||[],total=count(vendors);
    if(label&&total){label.parentNode.insertBefore(el("span","cb-cl-cnt",total+" "+(total===1?T.one:T.many)),label.nextSibling);}
    if(exp)head.addEventListener("click",function(btn){return function(ev){var t=ev.target;if(t&&t.closest&&t.closest("button,a,input,.cb-cl-ctl"))return;btn.click();};}(exp));
    var panel=item.querySelector(".cb-gdpr-cat-desc > div");if(!panel)continue;panel.classList.add("cb-cl-cat-b");
    var d=el("p","cb-cl-cat-d");while(panel.firstChild)d.appendChild(panel.firstChild);panel.appendChild(d);
    if(!vendors.length)continue;
    var wrap=el("div","cb-cl-vens cb-cookie-list");
    for(var j=0;j<vendors.length;j++)wrap.appendChild(vendorBox(vendors[j]));
    panel.appendChild(wrap);}
  if(!banner.querySelector(".cb-brand-footer"))banner.classList.add("cb-cl-nobrand");}
function enhance(){
  var banner=document.getElementById("cb-preferences-banner");
  if(!banner)return false;
  if(banner.classList.contains("cb-ccpa-prefs"))return true;
  var acc=banner.querySelector(".cb-gdpr-accordion");
  if(!acc)return false;
  if(acc.getAttribute("data-cb-cookie-list"))return true;
  acc.setAttribute("data-cb-cookie-list","1");
  banner.classList.add("cb-cl-design");
  var body=banner.querySelector(".cb-banner-body");
  if(body){var hd=el("div","cb-cl-hd");var n=body.firstChild;while(n&&n!==acc){var nx=n.nextSibling;if(n.nodeType===1&&(n.tagName==="H3"||n.tagName==="P"))hd.appendChild(n);n=nx;}if(hd.firstChild)banner.insertBefore(hd,body);}
  liveCookies(function(live){try{render(banner,acc,merged(live||[]));}catch(e){try{render(banner,acc,merged([]));}catch(e2){}}});
  return true;}
if(!enhance()){var mo=new MutationObserver(function(){if(enhance())mo.disconnect();});
  mo.observe(document.documentElement,{childList:true,subtree:true});
  setTimeout(function(){mo.disconnect();},30000);}
}catch(e){}})();
`;
}
