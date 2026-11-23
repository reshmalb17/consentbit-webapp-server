// src/handlers/consentShareBridge.js
// Cross-domain consent, banner side (TEST: cdnTest.js only). Returns a small script that runs
// BEFORE the banner runtime and the consent-mode bootstrap. The runtime is untouched: the
// bridge only reads and writes the same localStorage entries the runtime already uses
//   consentbit_<siteId>        → { accepted, timestamp, expiresAt, categories? , ccpa? , gpc? }
//   consentbit_prefs_<siteId>  → base64 JSON { analytics, preferences, marketing }
// plus one shared cookie on the main domain (.example.com) that every linked site can read:
//   cb_share_<primaryId> = encodeURIComponent(JSON { c: consent, s: status, h: host, t: ms, m: 'optin'|'optout' })
// No personal data in it.
//
// Page load (before the runtime reads its own entry):
//   own choice made here                 → keep it (one_way: a local override always wins;
//                                           two_way: the newer of own and shared wins)
//   own entry came from the shared cookie → follow the shared cookie when it is newer
//   nothing here, shared cookie present  → copy it in (no banner) and log a consent record on
//                                           this site: consentMethod "shared", consent.sharedFrom
//   neither                              → nothing; the runtime shows the banner as usual
// Visitor makes a choice (runtime writes consentbit_<siteId>):
//   primary, or any site when two_way    → write the shared cookie
// Safety: an opt-out (US) choice is never reused on an opt-in (GDPR) banner; GPC is still
// applied by the runtime after this, as today; IAB/TCF banners are not served the bridge.

/** @param {{siteId:string, primaryId:string, isPrimary:boolean, root:string, direction:string, bannerType:string, apiBase:string, expiryDays:number}} cfg */
export function consentShareBridge(cfg) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return `(function(){try{
if(window.__cbShareInit)return;window.__cbShareInit=1;
var S=${json};
var host=String(location.hostname||'').toLowerCase();
if(host!==S.root&&host.slice(-(S.root.length+1))!=='.'+S.root)return;
var L='consentbit_'+S.siteId,H='consentbit_prefs_'+S.siteId,CK='cb_share_'+S.primaryId;
var model=(S.bannerType==='gdpr'||S.bannerType==='iab')?'optin':'optout';
var canWrite=S.isPrimary||S.direction==='two_way';
var ls=window.localStorage,proto=window.Storage&&Storage.prototype,origSet=proto&&proto.setItem;
if(!ls||!origSet)return;
function now(){return Date.now();}
function expired(c){var x=c&&c.expiresAt?Date.parse(c.expiresAt):0;return x>0&&x<now();}
function readOwn(){try{var v=JSON.parse(ls.getItem(L)||'null');return v&&v.accepted&&!expired(v)?v:null;}catch(e){return null;}}
function readShared(){try{var m=document.cookie.match(new RegExp('(?:^|;\\\\s*)'+CK+'=([^;]+)'));if(!m)return null;var v=JSON.parse(decodeURIComponent(m[1]));return v&&v.c&&v.c.accepted&&!expired(v.c)?v:null;}catch(e){return null;}}
function statusOf(c){if(c.ccpa&&!c.categories)return c.ccpa.doNotSell?'rejected':'given';var k=c.categories||{},n=(k.analytics?1:0)+(k.marketing?1:0)+(k.preferences?1:0);return n===3?'given':n===0?'rejected':'partial';}
function writeShared(c){try{
var t=now(),exp=c.expiresAt?Date.parse(c.expiresAt):t+(S.expiryDays||30)*864e5,age=Math.max(60,Math.floor((exp-t)/1e3));
var keep={accepted:true,timestamp:c.timestamp||new Date(t).toISOString(),expiresAt:c.expiresAt||new Date(exp).toISOString()};
if(c.categories)keep.categories=c.categories;if(c.ccpa)keep.ccpa=c.ccpa;
var v=encodeURIComponent(JSON.stringify({c:keep,s:statusOf(c),h:host,t:t,m:model}));
document.cookie=CK+'='+v+'; domain=.'+S.root+'; path=/; max-age='+age+'; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');
}catch(e){}}
function adopt(sh){
var c={accepted:true,timestamp:sh.c.timestamp||new Date(sh.t).toISOString(),expiresAt:sh.c.expiresAt,sharedFrom:sh.h,sharedAt:sh.t};
if(sh.c.categories)c.categories=sh.c.categories;
if(sh.c.ccpa)c.ccpa=sh.c.ccpa;
else if(model==='optout'&&sh.c.categories)c.ccpa={doNotSell:!sh.c.categories.marketing};
origSet.call(ls,L,JSON.stringify(c));
try{ls.removeItem(L+'_closed');}catch(e){}
if(c.categories){var k=c.categories;origSet.call(ls,H,btoa(JSON.stringify({analytics:!!k.analytics,preferences:!!k.preferences,marketing:!!k.marketing})));}
window.__cbSharedConsent={from:sh.h,at:sh.t};
if(S.apiBase){try{fetch(S.apiBase+'/api/consent',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({siteId:S.siteId,regulation:model==='optin'?'gdpr':'ccpa',bannerType:S.bannerType,consentMethod:'shared',status:sh.s||statusOf(c),expiresAt:c.expiresAt,consent:c,consentModel:model})}).catch(function(){});}catch(e){}}
}
var own=readOwn(),sh=readShared();
if(sh&&!(sh.m==='optout'&&model==='optin')){
var take=false;
if(!own)take=true;
else if(own.sharedFrom)take=sh.t>(own.sharedAt||0);
else if(S.direction==='two_way')take=sh.t>(Date.parse(own.timestamp||0)||0);
if(take)adopt(sh);
}else if(own&&!own.sharedFrom&&canWrite&&!sh){writeShared(own);}
proto.setItem=function(k,v){var r=origSet.apply(this,arguments);try{if(this===ls&&k===L&&canWrite){var c=JSON.parse(v);if(c&&c.accepted&&!c.sharedFrom)writeShared(c);}}catch(e){}return r;};
}catch(e){}})();
`;
}
