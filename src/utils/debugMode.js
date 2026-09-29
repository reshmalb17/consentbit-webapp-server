/**
 * ConsentBit Debug Mode
 *
 * Returns a browser script that is prepended to EVERY served ConsentBit script
 * (standard, Webflow, IAB, IAB+Webflow) so it runs before anything else we ship.
 *
 * Part A — snapshot (always on, a few lines): records the page as it was the moment
 *   ConsentBit started — before the consent-mode bootstrap reorders the dataLayer —
 *   so a Google tag placed above us is still visible as "late".
 * Part B — checks + panel (only when debug mode is on): after load, verifies the
 *   consent default / TCF stub loaded before Google tags and shows plain-language
 *   results in an on-page panel and the console. Every "late" finding links to the
 *   docs, whose first troubleshooting step is the Google tag gateway (GTG) check.
 *
 * Turning it on: ?consentbit_debug=1 on the page URL (remembered for the tab,
 * ?consentbit_debug=0 turns it off), or data-debug="true" on the script tag.
 *
 * Kept as a plain string, not fn.toString(): wrangler bundles with esbuild keepNames,
 * which injects __name() calls into function bodies — a helper that does not exist in
 * the browser. Nothing in the string may contain a backtick or a dollar-brace.
 */

// Published articles. `fix` jumps to the "Fixing a Google tag that loads too early"
// section, whose first step is the Google tag gateway check. Webflow rich text drops
// custom ids, so a text fragment (:~:text=) does the jump; #late-tags still wins if an
// id with that name is ever added to the heading.
const DEBUG_DOCS = {
  debug: 'https://www.consentbit.com/articles/debug-mode',
  // The heading text also appears as link text higher up the page, so the suffix
  // (",-When debug mode flags") pins the match to the heading itself.
  fix: 'https://www.consentbit.com/articles/debug-mode#late-tags:~:text=Fixing%20a%20Google%20tag%20that%20loads%20too%20early,-When%20debug%20mode%20flags',
  gtg: 'https://www.consentbit.com/articles/using-consentbit-with-google-tag-gateway',
};

const DEBUG_BODY = String.raw`
(function(){try{
var W=window,D=document;
if(W.__cbDebugSnap)return;
var T0=(W.performance&&performance.now)?performance.now():0;
var CS=D.currentScript||null;
var GOOGLE_SRC=/googletagmanager\.com\/(gtag\/js|gtm\.js)/i;
var TAG_ID=/\b(G|GTM|AW|DC|GT)-[A-Z0-9]{4,}\b/;

/* ---- Part A: snapshot ---- */
var snap={t:T0,gtmRan:!!W.google_tag_manager,gtmInstall:!!W.__cbGtmInstall,firstGoogle:-1,firstDefault:-1,queued:[],above:[],tcfAt:null,gtmAt:null};
try{var L=W.dataLayer;if(L&&L.length){for(var i=0;i<L.length;i++){var it=L[i];if(!it)continue;
  if(it[0]==='consent'&&it[1]==='default'){if(snap.firstDefault<0)snap.firstDefault=i;}
  else if(it[0]==='js'||it[0]==='config'||it.event==='gtm.js'){if(snap.firstGoogle<0)snap.firstGoogle=i;var qn=it[0]==='config'?String(it[1]):(it.event==='gtm.js'?'GTM container':'gtag.js');if(snap.queued.indexOf(qn)<0)snap.queued.push(qn);}
}}}catch(_){}
try{if(CS&&CS.compareDocumentPosition){var S=D.getElementsByTagName('script');for(var j=0;j<S.length;j++){var s=S[j];if(s===CS)break;
  var src=s.getAttribute('src')||'',txt=src?'':(s.textContent||'');
  if(GOOGLE_SRC.test(src)||/googletagmanager\.com\/gtm\.js|gtag\(\s*['"]config/.test(txt)){var m=(src+' '+txt).match(TAG_ID),lbl=m?m[0]:'Google tag';if(snap.above.indexOf(lbl)<0)snap.above.push(lbl);}
}}}catch(_){}
W.__cbDebugSnap=snap;

/* ---- Is debug mode on? ---- */
var on=false,q=null;
try{q=/[?&]consentbit_debug=([01])/.exec(location.search);}catch(_){}
try{if(q){if(q[1]==='1')sessionStorage.setItem('consentbit_debug','1');else sessionStorage.removeItem('consentbit_debug');}on=sessionStorage.getItem('consentbit_debug')==='1';}catch(_){}
if(!on&&q&&q[1]==='1')on=true;
if(!on&&CS&&CS.getAttribute&&CS.getAttribute('data-debug')==='true')on=true;
if(!on)return;

/* ---- Part B: watch when the TCF API and Google's library appear ---- */
var polls=0,poll=setInterval(function(){
  var t=performance.now();
  if(snap.tcfAt===null&&typeof W.__tcfapi==='function')snap.tcfAt=t;
  if(snap.gtmAt===null&&W.google_tag_manager)snap.gtmAt=t;
  if(++polls>400)clearInterval(poll);
},25);

var DOCS=__CB_DEBUG_DOCS__;
var REAL_ID=/^(G|GTM|AW|DC|GT)-[A-Z0-9]{4,}$/;
var REQUIRED=['ad_storage','analytics_storage','ad_user_data','ad_personalization'];

function tagIds(){var ids={};
  var L=W.dataLayer||[];for(var i=0;i<L.length;i++){var it=L[i];if(it&&it[0]==='config'&&REAL_ID.test(String(it[1])))ids[String(it[1])]=1;}
  var S=D.getElementsByTagName('script');for(var j=0;j<S.length;j++){var m=(S[j].getAttribute('src')||'').match(/[?&]id=([A-Z]+-[A-Z0-9]+)/);if(m)ids[m[1]]=1;}
  try{for(var k in (W.google_tag_manager||{})){if(/^(G|GTM|AW|DC|GT)-/.test(k))ids[k]=1;}}catch(_){}
  return Object.keys(ids);}
function kv(o){var p=[];for(var i=0;i<REQUIRED.length;i++){var k=REQUIRED[i];if(o&&o[k])p.push(k+'='+o[k]);}return p.join('  ');}
function googleHits(){var out=[];try{var E=performance.getEntriesByType('resource');for(var i=0;i<E.length;i++){var n=E[i].name;
  if(/\/g\/collect|google-analytics\.com\/(j|g)\/collect|googleadservices\.com\/pagead|doubleclick\.net\/(pagead|activity)|google\.com\/(pagead|ccm)\//.test(n)){
    var g=null;try{g=new URL(n).searchParams.get('gcs');}catch(_){}
    out.push({t:E[i].startTime,gcs:g,ga:/\/g\/collect/.test(n)});}}}catch(_){}return out;}
function tcfPing(){var r=null;try{W.__tcfapi('ping',2,function(p){r=p;});}catch(_){}return r;}
function issuesText(c){return c===1?'1 issue':c+' issues';}

/* Each result: s = pass | warn | info, title, detail, code (monospace value), fix (link to docs). */
function check(){
  var R=[],L=W.dataLayer||[],site=W.__CONSENT_SITE__||{};
  var isIab=String(site.bannerType||'').toLowerCase()==='iab';
  var def=null,defIdx=-1,googleIdx=-1,dev=false,upd=null,updCount=0;
  for(var i=0;i<L.length;i++){var it=L[i];if(!it)continue;
    if(it[0]==='consent'&&it[1]==='default'&&def===null){def=it[2]||{};defIdx=i;}
    else if(it[0]==='consent'&&it[1]==='update'){upd=it[2]||{};updCount++;}
    else if(it[0]==='set'&&it[1]==='developer_id.dN2Q3Yj')dev=true;
    else if((it[0]==='js'||it[0]==='config'||it.event==='gtm.js')&&googleIdx<0)googleIdx=i;}
  var ids=tagIds();
  function n(c,one,many){return c+' '+(c===1?one:many);}
  function add(s,title,detail,code,fix){R.push({s:s,title:title,detail:detail,code:code||'',fix:!!fix});}

  // 1. Consent default
  var T='Consent default';
  if(snap.gtmRan)add('warn',T,'A Google tag ran before ConsentBit loaded, so it started without consent settings. Load ConsentBit first in <head>, without async.','',true);
  else if(snap.firstGoogle>=0&&(snap.firstDefault<0||snap.firstDefault>snap.firstGoogle)){
    if(defIdx>=0&&(googleIdx<0||defIdx<googleIdx))add('warn',T,'Google tag commands were queued above ConsentBit. The default was moved in front of them, but the page should not rely on that. Load ConsentBit first in <head>.',snap.queued.join('  '),true);
    else add('warn',T,'Google tag commands ran before the consent default. Load ConsentBit first in <head>.',snap.queued.join('  '),true);}
  else if(def){var miss=[];for(var r=0;r<REQUIRED.length;r++)if(!def[REQUIRED[r]])miss.push(REQUIRED[r]);
    if(miss.length)add('warn',T,'Required consent types are missing from the default.',miss.join('  '));
    else add('pass',T,'Set before any Google tag.',kv(def));}
  else if(snap.gtmInstall)add('info',T,'Set by the ConsentBit GTM template on Consent Initialization. See the Consent tab in GTM Preview.');
  else add('warn',T,'No consent default found on this page.','',true);

  // 2. Script order
  if(!snap.gtmInstall){
    if(snap.above.length)add('warn','Script order','A Google tag is placed above the ConsentBit script.',snap.above.join('  '),true);
    else if(ids.length)add('pass','Script order','ConsentBit loads before your Google tags.');}

  // 3. Google requests
  var hits=googleHits(),early=0,noState=0,states={};
  for(var h=0;h<hits.length;h++){if(!snap.gtmInstall&&hits[h].t<snap.t)early++;if(hits[h].ga){if(hits[h].gcs)states[hits[h].gcs]=1;else noState++;}}
  var st=Object.keys(states),gcs=st.length?'gcs='+st.join('  gcs='):'';
  if(early)add('warn','Google requests',n(early,'request was','requests were')+' sent before the consent default was set.',gcs,true);
  if(noState)add('warn','Google requests',n(noState,'request was','requests were')+' sent without a consent state.','',true);
  if(hits.length&&!early&&!noState)add('pass','Google requests',(hits.length===1?'1 request sent with a consent state.':hits.length+' requests sent, all with a consent state.'),gcs);
  if(!hits.length)add('info','Google requests',isIab?'None sent yet. With the TCF banner, Google tags wait for consent (basic mode).':'None sent yet.');

  // 4. TCF API (IAB banner only)
  if(isIab){var p=typeof W.__tcfapi==='function'?tcfPing():null,pc=p?'cmpId='+p.cmpId+'  cmpStatus='+p.cmpStatus:'';
    if(typeof W.__tcfapi!=='function')add('warn','TCF API','__tcfapi was not found on this page.');
    else if(snap.gtmRan||(snap.gtmAt!==null&&(snap.tcfAt===null||snap.gtmAt<snap.tcfAt)))add('warn','TCF API','A Google tag started before __tcfapi was available.',pc,true);
    else add('pass','TCF API',snap.gtmAt===null?'Ready. Google tags are waiting for consent.':'Ready before Google tags started.',pc);}

  // 5. Developer ID — console only: it is ConsentBit's own identifier, nothing the
  //    customer sets or can fix, so it stays out of the panel (kept for support/reviewers).
  if(dev)add('pass','Developer ID','Set by ConsentBit.','developer_id.dN2Q3Yj');
  else if(snap.gtmInstall)add('info','Developer ID','Set by the ConsentBit GTM template.');
  else add('warn','Developer ID','The ConsentBit developer ID was not found.');
  R[R.length-1].consoleOnly=true;

  // 6. Consent update
  if(upd)add('info','Consent update',n(updCount,'update','updates')+' received. Latest:',kv(upd));
  else add('info','Consent update','None yet. Make a choice in the banner to test it.');

  // 7. Google tags found
  add('info','Google tags',ids.length?'Detected on this page.':'None found on this page.',ids.join('  '));
  return R;
}

/* ---- Output: panel + console ---- */
var host=null,list=null,status=null,foot=null,lastKey='',closed=false,mini=false;
var C={bg:'#ffffff',line:'#eaeef2',edge:'#d0d7de',text:'#1f2328',muted:'#59636e',faint:'#818b98',pass:'#1a7f37',warn:'#9a6700',info:'#818b98',link:'#0969da'};
var SANS='-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
var MONO='ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace';
var LABEL={pass:'PASS',warn:'WARN',info:'INFO'};
function el(tag,css,text){var e=D.createElement(tag);if(css)e.style.cssText=css;if(text!=null)e.textContent=text;return e;}
function a(href,text){var x=el('a','color:'+C.link+';text-decoration:none',text);x.href=href;x.target='_blank';x.rel='noopener';
  x.onmouseover=function(){x.style.textDecoration='underline';};x.onmouseout=function(){x.style.textDecoration='none';};return x;}
/* Same mark as #cb-floating-trigger: the served floating logo, then its inline SVG fallback. */
function fallbackLogo(){var NS='http://www.w3.org/2000/svg',svg=D.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 40 40');svg.setAttribute('width','16');svg.setAttribute('height','16');svg.setAttribute('aria-hidden','true');
  var c=[['20','20','18','#007aff'],['14','14','2.2','#fff'],['24','18','2.5','#fff'],['17','25','2','#fff']];
  for(var i=0;i<c.length;i++){var e=D.createElementNS(NS,'circle');e.setAttribute('cx',c[i][0]);e.setAttribute('cy',c[i][1]);e.setAttribute('r',c[i][2]);e.setAttribute('fill',c[i][3]);svg.appendChild(e);}return svg;}
function logo(){var origin='';try{origin=CS&&CS.src?new URL(CS.src).origin:'';}catch(_){}
  if(!origin)return fallbackLogo();
  var img=el('img','display:block;width:16px;height:16px;object-fit:contain');img.alt='';img.src=origin+'/embed/floating-logo.svg';
  img.onerror=function(){img.onerror=null;img.parentNode&&img.parentNode.replaceChild(fallbackLogo(),img);};return img;}
function btn(label,text){var x=el('button','all:unset;cursor:pointer;color:'+C.muted+';width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;font:14px/1 '+SANS,text);
  x.type='button';x.setAttribute('aria-label',label);x.onmouseover=function(){x.style.background=C.line;x.style.color=C.text;};x.onmouseout=function(){x.style.background='none';x.style.color=C.muted;};return x;}
function panel(){
  host=el('div','position:fixed;top:16px;right:16px;z-index:2147483647');host.id='cb-debug-host';
  var root=host.attachShadow?host.attachShadow({mode:'open'}):host;
  var box=el('div','width:380px;max-width:calc(100vw - 32px);max-height:72vh;display:flex;flex-direction:column;background:'+C.bg+';color:'+C.text+';border:1px solid '+C.edge+';border-radius:8px;box-shadow:0 8px 24px rgba(140,149,159,.2);overflow:hidden;text-align:left;font:12.5px/1.5 '+SANS+';-webkit-font-smoothing:antialiased');
  var head=el('div','display:flex;align-items:center;gap:8px;height:40px;padding:0 8px 0 12px;border-bottom:1px solid '+C.line+';flex:0 0 auto');
  head.appendChild(logo());
  head.appendChild(el('span','font-weight:600;color:'+C.text,'ConsentBit'));
  head.appendChild(el('span','color:'+C.faint+';font:11px '+MONO,'debug'));
  status=el('span','margin-left:auto;display:inline-flex;align-items:center;gap:6px;color:'+C.muted+';font:11px '+MONO);head.appendChild(status);
  var m=btn('Minimise','−'),x=btn('Close','×');
  m.onclick=function(){mini=!mini;list.style.display=foot.style.display=mini?'none':'';m.textContent=mini?'+':'−';};
  x.onclick=function(){closed=true;host.parentNode&&host.parentNode.removeChild(host);};
  head.appendChild(m);head.appendChild(x);box.appendChild(head);
  list=el('div','overflow:auto;flex:1 1 auto');box.appendChild(list);
  foot=el('div','display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid '+C.line+';color:'+C.faint+';font:11px '+MONO+';flex:0 0 auto');
  foot.appendChild(el('span',null,'?consentbit_debug=0 to turn off'));foot.appendChild(a(DOCS.debug,'Docs'));
  box.appendChild(foot);root.appendChild(box);(D.body||D.documentElement).appendChild(host);
}
function render(R){
  var key=JSON.stringify(R);if(key===lastKey)return;lastKey=key;
  W.consentbitDebug={results:R,snapshot:snap,run:run,docs:DOCS};
  var issues=0;for(var k=0;k<R.length;k++)if(R[k].s==='warn'&&!R[k].consoleOnly)issues++;
  var summary=issues?issuesText(issues):'all checks passed';
  try{console.groupCollapsed('%cConsentBit debug%c  '+summary,'font-weight:600','color:'+(issues?C.warn:C.pass));
    for(var c=0;c<R.length;c++){var r0=R[c];(r0.s==='warn'?console.warn:console.log)('%c'+LABEL[r0.s]+'%c '+r0.title+' — '+r0.detail+(r0.code?'  ['+r0.code+']':'')+(r0.fix?'  Fix: '+DOCS.fix:''),'color:'+C[r0.s]+';font-weight:600','');}
    console.groupEnd();}catch(_){}
  if(closed)return;if(!host)panel();
  status.textContent='';status.appendChild(el('span','width:6px;height:6px;border-radius:50%;background:'+(issues?C.warn:C.pass)));
  status.appendChild(D.createTextNode(summary));
  while(list.firstChild)list.removeChild(list.firstChild);
  for(var i=0,drawn=0;i<R.length;i++){var r=R[i];if(r.consoleOnly)continue;
    var row=el('div','display:grid;grid-template-columns:44px 1fr;column-gap:8px;padding:10px 12px;'+(drawn++?'border-top:1px solid '+C.line:''));
    row.appendChild(el('div','color:'+C[r.s]+';font:600 10.5px/19px '+MONO+';letter-spacing:.04em',LABEL[r.s]));
    var col=el('div','min-width:0');
    col.appendChild(el('div','color:'+C.text+';font-weight:600',r.title));
    col.appendChild(el('div','color:'+C.muted,r.detail));
    if(r.code)col.appendChild(el('div','margin-top:4px;color:'+C.text+';font:11px/1.6 '+MONO+';word-break:break-word;white-space:pre-wrap',r.code));
    if(r.fix){var f=el('div','margin-top:6px;font-size:12px');f.appendChild(a(DOCS.fix,'How to fix'));
      f.appendChild(el('span','color:'+C.faint,'  ·  '));f.appendChild(a(DOCS.gtg,'Using Google tag gateway?'));col.appendChild(f);}
    row.appendChild(col);list.appendChild(row);}
}
function run(){try{render(check());}catch(e){try{console.warn('ConsentBit Debug failed:',e);}catch(_){}}}
function start(){setTimeout(function(){run();setInterval(run,1500);},1500);}
if(D.readyState==='complete')start();else W.addEventListener('load',start);
}catch(_){}})();
`;

/** Browser script for the debug snapshot + panel. Prepend it to every served script. */
export function getDebugModeScript() {
  return DEBUG_BODY.replace('__CB_DEBUG_DOCS__', JSON.stringify(DEBUG_DOCS)) + '\n';
}
