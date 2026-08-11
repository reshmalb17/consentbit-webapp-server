/**
 * IAB Loader Script Builder
 *
 * Builds the loaderIab script string from a customization object so cdn.js
 * can inject it directly. Inner ${...} template literals in the body are
 * pre-escaped so they survive verbatim and run in the browser at runtime.
 */
export function getLoaderIabScript(customization, opts = {}, isGAC = false) {
  const c = customization || {};
  const o = opts || {};
  // Google Additional Consent (AC) layer — when true the generated banner loads
  // the ATP list and produces a Google AC string on top of the IAB TCF flow.
  const isGoogleAC = isGAC === true;

  const colorsJson = JSON.stringify({
    bannerBg: c.backgroundColor || '#FFFFFF',
    textColor: c.textColor || '#000000',
    headingColor: c.headingColor || '#000000',
    buttonColor: c.acceptButtonBg || '#FFFFFF',
    buttonTextColor: c.acceptButtonText || '#007AFF',
    SecButtonColor: c.customiseButtonBg || '#007AFF',
    SecButtonTextColor: c.customiseButtonText || '#FFFFFF',
    fontWeight: c.fontWeight || '400',
  });
  const alignmentJson = JSON.stringify(o.textAlign || c.textAlign || 'left');
  const layoutJson = JSON.stringify({
    borderRadius: c.bannerBorderRadius || '0rem',
    buttonBorderRadius: c.buttonBorderRadius || '0.375rem',
    position: o.bannerLayoutVisual || c.bannerLayoutVisual || 'box',
    alignment: o.rawPos || c.position || 'bottom-left',
  });

  // Banner entrance animation — pick keyframes + animation shorthand for the
  // dashboard-selected option ('fade-in' | 'slide-up' | 'slide-down' | 'zoom-in').
  // Baked at template-build time and injected at runtime via a <style> tag.
  // #consentBitBanner ID selector + !important wins over the class-based
  // animation rules in injectStyles(), so existing CSS isn't touched.
  const __cbAnimChoice = String(o.bannerEntranceAnimation || c.bannerEntranceAnimation || 'slide-up').toLowerCase();
  const __cbAnimPresets = {
    'fade-in':    { kf: '@keyframes consentBitFadeInAnim{from{opacity:0}to{opacity:1}}',                                                          anim: 'consentBitFadeInAnim .4s ease' },
    'slide-up':   { kf: '@keyframes consentBitSlideUpAnim{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}',     anim: 'consentBitSlideUpAnim .4s cubic-bezier(.25,.46,.45,.94)' },
    'slide-down': { kf: '@keyframes consentBitSlideDownAnim{from{transform:translateY(-100%);opacity:0}to{transform:translateY(0);opacity:1}}',  anim: 'consentBitSlideDownAnim .4s cubic-bezier(.25,.46,.45,.94)' },
    'zoom-in':    { kf: '@keyframes consentBitZoomInAnim{from{transform:scale(.85);opacity:0}to{transform:scale(1);opacity:1}}',                 anim: 'consentBitZoomInAnim .4s cubic-bezier(.25,.46,.45,.94)' },
  };
  // Center/popup variant (.consentBit-type-popup) is centered with translateX(-50%);
  // its keyframes must keep that translate or the banner slides in from the side and
  // snaps to center. Higher-specificity selector (#id.class) overrides the base rule
  // for this variant only — box/banner variants keep the base keyframes above.
  const __cbAnimPresetsCenter = {
    'fade-in':    { kf: '@keyframes consentBitFadeInAnimC{from{opacity:0}to{opacity:1}}',                                                                                           anim: 'consentBitFadeInAnimC .4s ease' },
    'slide-up':   { kf: '@keyframes consentBitSlideUpAnimC{from{transform:translateX(-50%) translateY(100%);opacity:0}to{transform:translateX(-50%) translateY(0);opacity:1}}',     anim: 'consentBitSlideUpAnimC .4s cubic-bezier(.25,.46,.45,.94)' },
    'slide-down': { kf: '@keyframes consentBitSlideDownAnimC{from{transform:translateX(-50%) translateY(-100%);opacity:0}to{transform:translateX(-50%) translateY(0);opacity:1}}',  anim: 'consentBitSlideDownAnimC .4s cubic-bezier(.25,.46,.45,.94)' },
    'zoom-in':    { kf: '@keyframes consentBitZoomInAnimC{from{transform:translateX(-50%) scale(.85);opacity:0}to{transform:translateX(-50%) scale(1);opacity:1}}',                 anim: 'consentBitZoomInAnimC .4s cubic-bezier(.25,.46,.45,.94)' },
  };
  const __cbAnimPreset = __cbAnimPresets[__cbAnimChoice] || __cbAnimPresets['slide-up'];
  const __cbAnimPresetC = __cbAnimPresetsCenter[__cbAnimChoice] || __cbAnimPresetsCenter['slide-up'];
  const animCssLiteral = JSON.stringify(
    __cbAnimPreset.kf + ' #consentBitBanner{animation:' + __cbAnimPreset.anim + ' !important}'
    + ' ' + __cbAnimPresetC.kf + ' #consentBitBanner.consentBit-type-popup{animation:' + __cbAnimPresetC.anim + ' !important}'
  );

  return `
/**
 * Cookie Consent UI Integration
 * Works with TCFManager for proper consent handling
 */
const BASE_URL = "https://api.consentbit.com/";

// Google Additional Consent (AC) toggle — baked from the isGAC build argument.
const IS_GAC = ${isGoogleAC};
window.__cbIsGAC = IS_GAC;

/**
 * ConsentBit wordmark for the "Powered by" strip on the preference modal. Inlined
 * rather than fetched: a publisher's Content-Security-Policy can block an external
 * image, and an extra request for a 13px mark is not worth it. Every fill is a fixed
 * brand grey — the mark must render identically on every site, independent of whatever
 * banner colours the publisher has configured.
 */
const CB_WORDMARK_SVG = '<svg viewBox="0 0 735 90" role="img" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">'
  + '<g fill="#98A2B3">'
  + '<path d="M234.357 89.2656C227.796 89.2656 222.045 87.925 217.107 85.2439C212.238 82.4923 208.464 78.647 205.782 73.7081C203.101 68.7692 201.761 62.9484 201.761 56.2456C201.761 49.5428 203.101 43.722 205.782 38.7831C208.464 33.8442 212.238 30.0342 217.107 27.3531C222.045 24.6014 227.796 23.2256 234.357 23.2256C241.131 23.2256 246.916 24.5661 251.714 27.2472C256.582 29.9284 260.322 33.7384 262.932 38.6772C265.614 43.6161 266.954 49.4722 266.954 56.2456C266.954 62.9484 265.614 68.8045 262.932 73.8139C260.322 78.7528 256.582 82.5628 251.714 85.2439C246.846 87.925 241.06 89.2656 234.357 89.2656ZM234.357 78.8939C240.919 78.8939 245.999 76.9184 249.597 72.9672C253.266 68.9456 255.101 63.3717 255.101 56.2456C255.101 49.0489 253.266 43.475 249.597 39.5239C245.999 35.5728 240.919 33.5972 234.357 33.5972C227.866 33.5972 222.786 35.6081 219.117 39.6298C215.449 43.5809 213.614 49.1195 213.614 56.2456C213.614 63.3717 215.449 68.9456 219.117 72.9672C222.786 76.9184 227.866 78.8939 234.357 78.8939Z"/>'
  + '<path d="M158.471 89.3708C149.793 89.3708 142.208 87.5717 135.717 83.9733C129.297 80.3044 124.322 75.1539 120.795 68.5217C117.267 61.8894 115.503 54.0931 115.503 45.1325C115.503 36.1719 117.267 28.4108 120.795 21.8492C124.322 15.2169 129.297 10.1017 135.717 6.50333C142.208 2.83444 149.793 1 158.471 1C165.103 1 170.96 2.09361 176.04 4.28083C181.19 6.3975 185.423 9.53722 188.74 13.7C192.056 17.7922 194.313 22.7664 195.513 28.6225H183.236C181.966 23.1897 179.179 18.9917 174.875 16.0283C170.642 13.065 165.174 11.5833 158.471 11.5833C148.805 11.5833 141.22 14.5819 135.717 20.5792C130.214 26.5764 127.462 34.7608 127.462 45.1325C127.462 55.5747 130.214 63.7944 135.717 69.7917C141.22 75.7183 148.805 78.6817 158.471 78.6817C165.174 78.6817 170.642 77.2353 174.875 74.3425C179.179 71.3792 181.966 67.1811 183.236 61.7483H195.513C194.313 67.5339 192.056 72.5081 188.74 76.6708C185.423 80.7631 181.19 83.9028 176.04 86.09C170.96 88.2772 165.103 89.3708 158.471 89.3708Z"/>'
  + '<path d="M372.231 89.2656C363.412 89.2656 356.462 87.4311 351.382 83.7623C346.302 80.0934 343.515 74.9781 343.021 68.4164H354.769C355.263 72.297 356.956 75.1545 359.849 76.9889C362.742 78.8234 367.01 79.7406 372.655 79.7406C382.533 79.7406 387.471 76.6361 387.471 70.4272C387.471 67.8872 386.695 65.947 385.143 64.6064C383.661 63.1953 381.121 62.1722 377.523 61.5372L363.659 58.9973C351.876 56.81 345.985 51.2009 345.985 42.1697C345.985 36.3136 348.207 31.6923 352.652 28.3056C357.097 24.9189 363.165 23.2256 370.856 23.2256C378.828 23.2256 385.143 24.9542 389.8 28.4114C394.527 31.8686 397.208 36.737 397.843 43.0164H386.307C385.602 39.4886 383.944 36.8781 381.333 35.1847C378.793 33.4914 375.195 32.6448 370.538 32.6448C366.234 32.6448 362.883 33.3856 360.484 34.8673C358.156 36.3489 356.991 38.5009 356.991 41.3231C356.991 43.5103 357.732 45.2389 359.214 46.5089C360.766 47.7084 363.236 48.6256 366.622 49.2606L380.486 51.9064C386.695 53.0353 391.246 55.0461 394.139 57.9389C397.032 60.8317 398.478 64.7122 398.478 69.5806C398.478 75.7895 396.22 80.6225 391.705 84.0798C387.189 87.537 380.698 89.2656 372.231 89.2656Z"/>'
  + '<path d="M437.465 89.2656C430.833 89.2656 425.083 87.925 420.215 85.2439C415.346 82.4923 411.572 78.6117 408.89 73.6022C406.28 68.5928 404.975 62.7367 404.975 56.0339C404.975 49.3311 406.28 43.5456 408.89 38.6772C411.572 33.7384 415.311 29.9284 420.109 27.2472C424.907 24.5661 430.516 23.2256 436.936 23.2256C443.075 23.2256 448.366 24.4603 452.811 26.9297C457.327 29.3992 460.819 32.8917 463.289 37.4073C465.758 41.9228 466.993 47.285 466.993 53.4939V58.2564H416.405C416.757 64.8886 418.768 70.0745 422.437 73.8139C426.177 77.4828 431.151 79.3172 437.36 79.3172C441.663 79.3172 445.297 78.4353 448.26 76.6714C451.224 74.837 453.27 72.1559 454.399 68.6281H466.464C464.912 75.1897 461.56 80.2697 456.41 83.8681C451.33 87.4664 445.015 89.2656 437.465 89.2656ZM416.828 49.5781H455.563C454.998 44.357 453.058 40.3 449.742 37.4073C446.497 34.5145 442.193 33.0681 436.83 33.0681C431.539 33.0681 427.129 34.5145 423.601 37.4073C420.073 40.3 417.816 44.357 416.828 49.5781Z"/>'
  + '<path d="M564.448 87.9953C561.061 87.9953 558.415 87.1486 556.51 85.4553C554.676 83.6914 553.759 81.0809 553.759 77.6236V33.597H541.905V24.4953H553.864V7.99512H565.506V24.4953H582.122V33.597H565.612V78.682H583.815V87.9953H564.448Z"/>'
  + '<path d="M672 88V35H687V88H672Z"/>'
  + '<path d="M671 23V8H687V23H671Z"/>'
  + '<path d="M716.594 87.9955C712.693 87.9955 709.652 87.0038 707.47 85.0205C705.355 83.0372 704.297 80.0291 704.297 75.9963L704.297 35.4985H693.785V23.9951H704.396L704.53 7.99512L718.875 7.99512L718.874 23.9951H735V35.4985H719.073L719.073 76.393H734.642V87.9955H716.594Z"/>'
  + '<path d="M283.197 33.4209H287.594C289.814 29.8402 292.857 27.1189 296.725 25.2568C300.592 23.3231 305.14 22.3565 310.368 22.3564C318.676 22.3564 325.229 24.7554 330.027 29.5537C334.826 34.2805 337.226 40.6188 337.226 48.5684V87.9951H325.193V50.6104C325.193 44.8093 323.618 40.4045 320.467 37.3965C317.387 34.3885 312.839 32.8838 306.823 32.8838C300.879 32.8838 296.331 34.3885 293.18 37.3965C290.029 40.4045 288.453 44.8093 288.453 50.6104V87.9951H276.421V36.2266H267.972V21H283.197V33.4209Z"/>'
  + '<path d="M486 34.2314H489.33C491.517 30.7038 494.516 28.0229 498.326 26.1885C502.136 24.2835 506.617 23.3311 511.768 23.3311C519.952 23.3311 526.408 25.6947 531.135 30.4219C535.862 35.0785 538.226 41.3227 538.226 49.1543V87.9951H526.372V51.165C526.372 45.4501 524.82 41.1108 521.716 38.1475C518.682 35.1841 514.201 33.7031 508.274 33.7031C502.419 33.7032 497.938 35.1843 494.834 38.1475C491.73 41.1108 490.177 45.4501 490.177 51.165V87.9951H478.324V36.9951H470V20.9951H486V34.2314Z"/>'
  + '<path d="M631.386 7.66992C636.211 7.66997 640.376 8.52936 643.88 10.248C647.45 11.9008 650.26 14.2815 652.31 17.3887C654.359 20.4297 655.384 23.9999 655.384 28.0986C655.384 32.2635 653.684 36.2398 652 38.9951C649.075 43.7811 645.5 44.7578 645.627 44.7578L648.988 45.1553C651.963 45.8164 654.673 47.0394 657.119 48.8242C659.631 50.6092 661.615 52.8569 663.069 55.5674C664.59 58.2779 665.351 61.4843 665.351 65.1865C665.351 69.7482 664.226 73.7478 661.979 77.1855C659.797 80.5572 656.723 83.2019 652.756 85.1191C648.855 87.0363 644.326 87.9951 639.17 87.9951H596.826V21H611.999V40.2959H629.303C632.807 40.2959 635.484 39.4691 637.335 37.8164C639.252 36.0975 640.211 33.6844 640.211 30.5771C640.211 27.3378 639.252 24.892 637.335 23.2393C635.484 21.5866 632.807 20.7598 629.303 20.7598H612V7.66992H631.386ZM611.999 74.9053H636.394C640.823 74.9053 644.227 73.9463 646.607 72.0293C648.987 70.046 650.178 67.2031 650.178 63.501C650.178 59.8649 648.987 57.1206 646.607 55.2695C644.228 53.3526 640.856 52.3946 636.493 52.3945H611.999V74.9053Z"/>'
  + '</g>'
  + '<path d="M32.7604 87.4506C32.0233 88.1831 30.8281 88.1831 30.0909 87.4506L8.45288 65.9485C-2.81763 54.7488 -2.81763 36.5904 8.45288 25.3907C8.97709 24.8698 9.827 24.8698 10.3512 25.3907L51.4471 66.2285C52.1843 66.961 52.1843 68.1487 51.4471 68.8813L32.7604 87.4506Z" fill="#B4BCC8"/>'
  + '<path d="M35.3829 43.3719C34.8671 42.8423 34.8732 41.9897 35.3966 41.4677L76.4272 0.544909C77.1632 -0.189157 78.3479 -0.180458 79.0733 0.564338L97.4615 19.4444C98.1869 20.1891 98.1783 21.388 97.4423 22.1221L75.8387 43.669C64.5861 54.892 46.4734 54.759 35.3829 43.3719Z" fill="#8C95A3"/>'
  + '</svg>';

function loadScriptOnce(src, onload) {
  const existing = document.querySelector('script[src="' + src + '"]');
  if (existing) {
    if (onload) {
      if (existing.dataset.cbLoaded === 'true') {
        onload();
      } else {
        existing.addEventListener('load', onload, { once: true });
      }
    }
    return;
  }

  const script = document.createElement('script');
  script.src = src;
  script.async = false;
  script.onload = function() {
    script.dataset.cbLoaded = 'true';
    if (onload) onload();
  };
  document.head.appendChild(script);
}

function initConsentDependencies() {
  loadScriptOnce(BASE_URL + 'tcf.bundle.js', function() {
    loadScriptOnce(BASE_URL + 'Tcfmanager.js');
  });
}

const colors = ${colorsJson};
const alignment = ${alignmentJson};
const initialLayout = ${layoutJson};

const styleConfig = {
  bannerBg: colors.bannerBg || '#FFFFFF',
  textColor: colors.textColor || '#000000',
  headingColor: colors.headingColor || '#000000',
  buttonColor: colors.buttonColor || '#FFFFFF',
  buttonTextColor: colors.buttonTextColor || '#007AFF',
  SecButtonColor: colors.SecButtonColor || '#007AFF',
  SecButtonTextColor: colors.SecButtonTextColor || '#FFFFFF',
  textAlign: alignment || 'left',
  fontWeight: colors.fontWeight || '400',
  borderRadius: initialLayout?.borderRadius || '12',
  buttonBorderRadius: initialLayout?.buttonBorderRadius || '0.375rem',
  bannerType: initialLayout?.position || 'box',
  boxAlignment: initialLayout?.alignment || 'bottom-left'
};

function injectStyles() {
  if (document.getElementById('consentbit-inline-styles')) return;
  const s = styleConfig;
  // borderRadius arrives as a string with its own unit (e.g. "1.5rem" or "12px").
  // Use it as-is for br; derive sm/pill caps by parsing the number and re-attaching
  // whichever unit the input already had. Numeric input (no unit) is treated as px.
  const brRaw = String(s.borderRadius ?? '0').trim();
  const brNum = parseFloat(brRaw) || 0;
  const brUnit = brRaw.endsWith('rem') ? 'rem' : (brRaw.endsWith('px') ? 'px' : 'px');
  const br = /rem|px|%|em/.test(brRaw) ? brRaw : (brNum + 'px');
  const _smCap = brUnit === 'rem' ? 0.5 : 8;
  const _pillCap = brUnit === 'rem' ? 62 : 999;
  const brSm = Math.min(brNum, _smCap) + brUnit;
  const brPill = Math.min(brNum, _pillCap) + brUnit;
  // Button border-radius — pass through as-is (already a unit-suffixed string).
  const brBtnRaw = String(s.buttonBorderRadius ?? '').trim();
  const brBtn = brBtnRaw
    ? (/rem|px|%|em/.test(brBtnRaw) ? brBtnRaw : (parseFloat(brBtnRaw) || 0) + 'px')
    : brSm;
  const css = \`
.consentBit-vendors-search-wrapper{max-height:500px;overflow-y:auto;padding:20px}
.consentBit-search-container{position:relative;margin-bottom:20px}
.consentBit-search-input{width:100%;padding:12px 16px 12px 44px;border:2px solid #e0e0e0;border-radius:\${brSm};font-size:14px;transition:border-color .2s ease;background:#fff;box-sizing:border-box}
.consentBit-search-input:focus{outline:none;border-color:\${s.SecButtonColor};box-shadow:0 0 0 3px \${s.SecButtonColor}22}
.consentBit-search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:16px;color:\${s.textColor};pointer-events:none}
.consentBit-vendors-list{display:flex;flex-direction:column;gap:18px;padding-bottom:8px}
.consentBit-vendor-item{margin-bottom:6px}
.consentBit-vendor-item{padding:16px;border:1px solid #f0f0f0;border-radius:\${brSm};background:#fafafa;transition:all .2s ease;animation:consentBit-fadeIn .3s ease}
.consentBit-vendor-item:hover{border-color:\${s.SecButtonColor};background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.1)}
.consentBit-vendor-item.consentBit-hidden{display:none!important}
.consentBit-vendor-header{display:flex;justify-content:space-between;align-items:center;gap:16px}
.consentBit-vendor-info{flex:1}
.consentBit-vendor-name{font-weight:600;font-size:15px;color:\${s.headingColor};margin-bottom:4px}
.consentBit-vendor-id{font-size:12px;color:\${s.textColor};font-family:monospace}
.consentBit-switch-wrapper{flex-shrink:0}
.consentBit-consent-switch-wrapper{display:flex;align-items:center;gap:8px}
.consentBit-switch-label{font-size:13px;font-weight:500;color:\${s.textColor}}
.consentBit-switch-sm{position:relative;width:36px;height:20px}
.consentBit-switch-sm input{opacity:0;width:0;height:0}
.consentBit-switch-sm input:checked+.consentBit-slider{background-color:#007AFF}
.consentBit-switch-sm input:focus+.consentBit-slider{box-shadow:0 0 1px #007AFF}
.consentBit-switch-sm input:checked+.consentBit-slider:before{transform:translateX(16px)}
.consentBit-slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background-color:#ccc;transition:.2s;border-radius:20px}
.consentBit-slider:before{position:absolute;content:"";height:16px;width:16px;left:2px;top:2px;background-color:#fff;transition:.2s;border-radius:50%}
.consentBit-no-results{text-align:center;padding:40px 20px;color:\${s.textColor}}
.consentBit-no-results p{margin:0 0 4px 0;font-size:16px}
.consentBit-empty-vendors-text{text-align:center;color:\${s.textColor};padding:40px;font-style:italic}
.consentBit-loading{text-align:center;padding:40px;color:\${s.textColor}}
@keyframes consentBit-fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.consentBit-consent-container{position:fixed;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;border-radius:\${br};box-shadow:0 20px 60px rgba(0,0,0,.15);backdrop-filter:blur(10px);animation:consentBit-slideUp .4s cubic-bezier(.25,.46,.45,.94)}
.consentBit-type-banner{bottom:0;left:0;right:0;border-radius:0;max-width:100%}
.consentBit-type-box-bottom-left{bottom:20px;left:20px;right:auto;max-width:600px}
.consentBit-type-box-bottom-right{bottom:20px;right:20px;left:auto;max-width:600px}
.consentBit-type-popup{bottom:20px;left:50%;transform:translateX(-50%);right:auto;max-width:600px;width:calc(100% - 40px);animation:consentBit-slideUp .4s cubic-bezier(.25,.46,.45,.94)}
.consentBit-popup-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999998}
@keyframes consentBit-slideUp{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}
.consentBit-consent-bar{border:1px solid #f4f4f4;background:\${s.bannerBg};border-radius:\${br};padding:24px}
.consentBit-type-banner .consentBit-consent-bar{border-radius:0;padding:16px 24px}
.consentBit-type-banner .consentBit-notice{gap:4px}
.consentBit-type-banner .consentBit-notice-group{display:flex;flex-direction:row;align-items:center;gap:20px;flex:1}
.consentBit-type-banner .consentBit-notice-btn-wrapper{flex-direction:row;padding-top:0;border-top:none;flex-shrink:0}
.consentBit-notice{display:flex;flex-direction:column;gap:16px}
.consentBit-title{font-size:20px;font-weight:700;line-height:1.3;margin:0 0 12px 0;color:\${s.headingColor};text-align:\${s.textAlign}}
.consentBit-notice-group{display:flex;flex-direction:column;gap:20px}
.consentBit-notice-des{flex:1;color:\${s.textColor};line-height:1.6;font-size:14px;font-weight:\${s.fontWeight};text-align:\${s.textAlign}}
.consentBit-notice-des p{margin:0 0 12px 0}
.consentBit-notice-des p:last-child{margin-bottom:0}
.consentBit-notice-btn-wrapper{display:flex;gap:8px;padding-top:16px;border-top:1px solid #f0f0f0;justify-content:\${s.textAlign === 'center' ? 'center' : s.textAlign === 'right' ? 'flex-end' : 'flex-start'}}
.consentBit-btn{padding:11px 20px;border-radius:\${brBtn};font-size:14px;font-weight:\${s.fontWeight};cursor:pointer;transition:opacity .2s ease;border:2px solid transparent;text-align:center;min-height:44px;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}
.consentBit-btn:hover,.cb-btn:hover{opacity:.85}
.consentBit-btn-customize{color:\${s.SecButtonTextColor};background:\${s.SecButtonColor};border-color:\${s.SecButtonColor}}
.consentBit-vendors-link{color:#007AFF;text-decoration:underline;cursor:pointer;font-weight:600}
.consentBit-vendors-link:hover{opacity:.8}
.consentBit-scope-note{font-size:12px;opacity:.85;margin-top:8px}
.consentBit-purposes-line{font-size:14px;line-height:1.5;opacity:.85;margin-top:8px}
.consentBit-purposes-line strong{color:\${s.headingColor};font-weight:600}
.cb-cmp-disclosure{margin-top:12px;font-size:12px;color:\${s.textColor};background:#f7f7f7;border:1px solid #ebebeb;border-radius:\${brSm};padding:10px 12px}
.cb-cmp-disclosure summary{cursor:pointer;font-weight:600;color:\${s.headingColor}}
.cb-cmp-disclosure[open] summary{margin-bottom:6px}
.cb-cmp-disclosure code{background:#fff;padding:1px 5px;border-radius:3px;font-size:11px;border:1px solid #e0e0e0}
.consentBit-vendor-section{margin-top:14px}
.consentBit-vendor-section:first-child{margin-top:0}
.consentBit-vendor-section-title{display:block;font-weight:600;color:\${s.headingColor};font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px;opacity:.85}
.consentBit-vendor-tag-list{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.consentBit-vendor-tag-list li{background:#fff;border:1px solid #e0e0e0;border-radius:\${brPill};padding:3px 10px;font-size:11.5px;color:\${s.textColor};line-height:1.4}
.consentBit-vendor-empty{font-size:12px;color:\${s.textColor};opacity:.55;font-style:italic}
.consentBit-data-cat-list{display:flex;flex-direction:column;gap:6px}
.consentBit-data-cat{border:1px solid #e0e0e0;border-radius:\${brSm};background:#fff;overflow:hidden}
.consentBit-data-cat summary{cursor:pointer;padding:8px 12px;font-size:12.5px;font-weight:600;color:\${s.headingColor};list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;user-select:none;transition:background .15s ease}
.consentBit-data-cat summary::-webkit-details-marker{display:none}
.consentBit-data-cat summary::after{content:"▾";font-size:11px;color:\${s.SecButtonColor};transition:transform .15s ease}
.consentBit-data-cat[open] summary::after{transform:rotate(180deg)}
.consentBit-data-cat summary:hover{background:#fafafa}
.consentBit-data-cat p{margin:0;padding:8px 12px 12px;font-size:12px;color:\${s.textColor};line-height:1.55;border-top:1px solid #f0f0f0;background:#fafafa}
.consentBit-vendor-meta{margin:0;font-size:12.5px;color:\${s.textColor};line-height:1.55;border:1px solid #ebebeb;border-radius:\${brSm};overflow:hidden;background:#fff}
.consentBit-vendor-meta-row{display:grid;grid-template-columns:minmax(150px,40%) 1fr;gap:0;border-bottom:1px solid #f0f0f0}
.consentBit-vendor-meta-row:last-child{border-bottom:none}
.consentBit-vendor-meta-row dt{margin:0;padding:8px 12px;font-weight:600;color:\${s.headingColor};background:#fafafa;border-right:1px solid #f0f0f0}
.consentBit-vendor-meta-row dd{margin:0;padding:8px 12px;color:\${s.textColor}}
.consentBit-vendor-retention{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.consentBit-vendor-retention li{font-size:12px;color:\${s.textColor};padding:6px 10px;background:#fafafa;border:1px solid #f0f0f0;border-radius:\${brSm};display:flex;justify-content:space-between;gap:10px}
.consentBit-vendor-retention li strong{font-weight:600;color:\${s.headingColor}}
.consentBit-vendor-object-note{margin:0;padding:10px 12px;background:#fff8e6;border:1px solid #f4d97a;border-radius:\${brSm};font-size:12px;color:\${s.textColor};line-height:1.5}
.consentBit-vendor-object-note strong{color:\${s.headingColor}}
.consentBit-vendor-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.consentBit-vendor-inline-links{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px}
.consentBit-vendor-inline-links a{color:#007AFF;text-decoration:none;font-weight:500}
.consentBit-vendor-inline-links a:hover{text-decoration:underline}
.consentBit-vendor-section-first{margin-top:0;padding-bottom:8px;border-bottom:1px solid #f0f0f0;margin-bottom:6px}
.consentBit-vendor-expand{background:\${s.SecButtonColor};border:2px solid \${s.SecButtonColor};color:\${s.SecButtonTextColor};cursor:pointer;font-size:12px;font-weight:600;padding:7px 12px;border-radius:\${brBtn};margin-top:10px;text-align:left;transition:opacity .2s ease}
.consentBit-vendor-expand:hover{opacity:.85}
.consentBit-vendor-details{display:none;margin-top:12px;border-top:1px solid #ebebeb;padding-top:14px;display:none;flex-direction:column;gap:0}
.consentBit-vendor-details.is-open{display:flex}
.consentBit-li-switch-wrapper{display:flex;align-items:center;gap:6px}
.consentBit-li-switch-wrapper .consentBit-switch-label{font-size:11px}
.consentBit-btn-reject,.consentBit-btn-accept,.cb-btn-accept{color:\${s.buttonTextColor};background:\${s.buttonColor};border-color:\${s.buttonColor}}
.cb-modal{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000000;padding:20px;box-sizing:border-box}
.cb-modal.cb-modal-hidden{display:none!important}
.cb-preference-center{background-color:\${s.bannerBg};border:1px solid #f4f4f4;border-radius:\${br};max-width:720px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,.15)}
.cb-preference-header{padding:20px 24px;border-bottom:1px solid #f4f4f4;display:flex;justify-content:space-between;align-items:center}
.cb-preference-title{font-size:18px;font-weight:600;color:\${s.headingColor}}
.cb-btn-close{background:none;border:none;cursor:pointer;padding:4px;opacity:.5;transition:opacity .2s}
.cb-btn-close:hover{opacity:1}
.cb-btn-close img{width:20px;height:20px}
.cb-iab-detail-wrapper{flex:1;overflow-y:auto;padding:0 24px 24px}
.cb-iab-preference-des,.cb-preference-content-wrapper,.cb-accordion-header-des,.cb-iab-ad-settings-details-des{color:\${s.textColor};font-size:13px;line-height:1.6;font-weight:\${s.fontWeight};text-align:\${s.textAlign}}
.cb-iab-navbar-wrapper{margin-bottom:24px;border-bottom:2px solid #f4f4f4}
.cb-iab-navbar{display:flex;list-style:none;gap:0;padding:0;margin:0}
.cb-iab-nav-item{flex:1}
.cb-iab-nav-btn{width:100%;padding:12px 16px;background:none;border:none;border-bottom:3px solid transparent;cursor:pointer;font-size:13px;font-weight:\${s.fontWeight};color:\${s.textColor};transition:all .2s}
.cb-iab-nav-item-active .cb-iab-nav-btn{color:\${s.textColor};border-bottom-color:\${s.buttonColor};opacity:1;font-weight:700}
.cb-iab-nav-btn:hover{background-color:#f9f9f9}
.cb-preference-body-wrapper{display:none}
.cb-preference-body-wrapper.active{display:block}
.cb-iab-detail-title{font-size:16px;font-weight:600;color:\${s.headingColor};margin-bottom:14px;text-align:\${s.textAlign}}
.cb-horizontal-separator{height:1px;background-color:#ebebeb;margin:20px 0}
.cb-accordion-wrapper{display:flex;flex-direction:column;gap:10px}
.cb-accordion{border:1px solid #ebebeb;border-radius:\${brSm};overflow:hidden;background:\${s.bannerBg}}
.cb-accordion-item,.cb-accordion-iab-item{display:flex;gap:12px;padding:14px 16px;cursor:pointer;transition:background-color .2s}
.cb-accordion-item:hover,.cb-accordion-iab-item:hover,.cb-child-accordion-item:hover{}
.cb-accordion-chevron,.cb-child-accordion-chevron{flex-shrink:0;display:flex;align-items:center;justify-content:center}
.cb-accordion-chevron{width:20px;height:20px}
.cb-child-accordion-chevron{width:16px;height:16px}
.cb-chevron-right{width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:6px solid #999;transition:transform .2s;display:inline-block}
.cb-accordion.active .cb-chevron-right,.cb-child-accordion.active .cb-chevron-right{transform:rotate(90deg)}
.cb-accordion-header-wrapper{flex:1}
.cb-accordion-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:10px}
.cb-accordion-btn,.cb-child-accordion-btn{background:none;border:none;font-size:14px;font-weight:600;color:\${s.headingColor};cursor:pointer;text-align:\${s.textAlign};padding:0}
.cb-always-active{padding:3px 10px;background-color:#DCFCE7;color:#166534;border-radius:\${brPill};font-size:11px;font-weight:500}
.cb-switch{position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0}
.cb-switch input{opacity:0;width:0;height:0}
.cb-switch input[type="checkbox"],.cb-switch-sm input[type="checkbox"]{appearance:none;position:relative;cursor:pointer;transition:background-color .2s}
.cb-switch input[type="checkbox"]{width:44px;height:24px;background-color:#d0d5d2;border-radius:12px}
.cb-switch input[type="checkbox"]:checked,.cb-switch-sm input[type="checkbox"]:checked{background-color:#007AFF}
.cb-switch input[type="checkbox"]::before,.cb-switch-sm input[type="checkbox"]::before{content:'';position:absolute;border-radius:50%;background-color:#fff;top:3px;left:3px;transition:transform .2s}
.cb-switch input[type="checkbox"]::before{width:18px;height:18px}
.cb-switch input[type="checkbox"]:checked::before{transform:translateX(20px)}
.cb-accordion-body,.cb-child-accordion-body{max-height:0;overflow:hidden;transition:max-height .3s ease}
.cb-accordion.active .cb-accordion-body,.cb-child-accordion.active .cb-child-accordion-body{max-height:2000px}
.cb-audit-table{border:1px solid #ebebeb;border-radius:\${brSm};padding:14px}
.cb-child-accordion{border-top:1px solid #ebebeb}
.cb-child-accordion:first-child{border-top:none}
.cb-child-accordion-item{display:flex;gap:12px;padding:12px 16px;cursor:pointer;transition:background-color .2s}
.cb-child-accordion-header-wrapper{flex:1;display:flex;justify-content:space-between;align-items:center;gap:16px}
.cb-child-accordion-btn{font-size:13px;font-weight:500;text-align:left;flex:1}
.cb-iab-ad-settings-details{padding:14px;background-color:#f9f9f9;margin:0 14px 14px;border-radius:\${brSm}}
.cb-iab-illustrations-title{font-weight:600;color:\${s.headingColor};margin-bottom:6px;font-size:13px}
.cb-iab-illustrations-des{list-style:none;padding-left:0}
.cb-iab-illustrations-des li{padding-left:18px;position:relative;margin-bottom:10px;color:\${s.textColor};font-size:12px;line-height:1.6;font-weight:\${s.fontWeight}}
.cb-iab-illustrations-des li::before{content:'•';position:absolute;left:0;color:\${s.SecButtonColor}}
.cb-iab-vendors-count-wrapper{margin-top:12px;font-size:12px;color:\${s.textColor};opacity:.6;font-weight:500}
.cb-switch-wrapper{display:flex;gap:12px;align-items:center;flex-shrink:0}
.cb-switch-separator{padding-right:12px;border-right:1px solid #ddd}
.cb-legitimate-switch-wrapper,.cb-consent-switch-wrapper{display:flex;align-items:center;gap:6px}
.cb-switch-label{font-size:11px;color:\${s.textColor};opacity:.6;font-weight:500;white-space:nowrap}
.cb-switch-sm{position:relative;display:inline-block}
.cb-switch-sm input[type="checkbox"]{width:36px;height:20px;background-color:#d0d5d2;border-radius:10px}
.cb-switch-sm input[type="checkbox"]::before{width:14px;height:14px}
.cb-switch-sm input[type="checkbox"]:checked::before{transform:translateX(16px)}
.cb-switch-sm input[type="checkbox"]:disabled{cursor:not-allowed}
.cb-switch-sm input[type="checkbox"]:disabled:checked{opacity:.7}
.cb-footer-wrapper{border-top:1px solid #f4f4f4;flex-shrink:0}
.cb-footer-shadow{display:block;height:20px;margin-top:-20px;background:linear-gradient(180deg,rgba(255,255,255,0) 0%,\${s.bannerBg} 100%)}
.cb-prefrence-btn-wrapper{padding:14px 22px;display:flex;gap:10px;justify-content:\${s.textAlign === 'center' ? 'center' : s.textAlign === 'right' ? 'flex-start' : 'flex-end'};flex-wrap:wrap}
.cb-btn{padding:9px 20px;border-radius:\${brBtn};font-size:13px;font-weight:\${s.fontWeight};cursor:pointer;transition:opacity .2s;border:2px solid;white-space:nowrap}
.cb-btn-reject{background-color:\${s.buttonColor};color:\${s.buttonTextColor};border-color:\${s.buttonColor}}
.cb-btn-preferences{background-color:\${s.SecButtonColor};color:\${s.SecButtonTextColor};border-color:\${s.SecButtonColor}}
.cb-brand-footer{box-sizing:border-box;height:44px;max-height:50px;padding:0 22px;display:flex;align-items:center;justify-content:flex-end;gap:8px;background:#F7F8FA!important;background-color:#F7F8FA!important;border-top:1px solid #EFF1F4!important;border-radius:0 0 \${br} \${br}}
.cb-brand-footer a{display:inline-flex;align-items:center;gap:7px;text-decoration:none!important;background:transparent!important;color:#A2ABBA!important;border-radius:6px;padding:4px 6px;margin-right:-6px;transition:opacity .15s ease}
.cb-brand-footer a:hover{opacity:.7}
.cb-brand-credit{font-size:11px!important;font-weight:500!important;letter-spacing:.02em;line-height:1;white-space:nowrap;color:#A2ABBA!important}
.cb-brand-mark{display:flex;align-items:center;opacity:.85}
.cb-brand-mark svg{display:block;height:9.75px;width:auto}
@media(max-width:768px){.consentBit-type-box-bottom-left,.consentBit-type-box-bottom-right{left:10px;right:10px;max-width:calc(100% - 20px)}.consentBit-type-box-bottom-left,.consentBit-type-box-bottom-right{bottom:10px}.consentBit-consent-bar{padding:18px}.consentBit-title{font-size:16px}.consentBit-notice-btn-wrapper,.cb-prefrence-btn-wrapper{flex-direction:column}.consentBit-btn,.cb-btn{width:100%}.consentBit-type-banner .consentBit-notice,.consentBit-type-banner .consentBit-notice-group{flex-direction:column}.cb-iab-navbar{flex-direction:column}.cb-switch-wrapper{flex-direction:column;align-items:flex-start;gap:6px}.cb-switch-separator{border-right:none;padding-right:0;padding-bottom:6px;border-bottom:1px solid #ddd}}
@media(max-width:768px){.cb-brand-footer{padding:0 16px}}
/* max-height twice is deliberate: vh is the fallback for browsers without dvh */
@media(max-width:768px){.consentBit-consent-container{max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}}
\`;
  const style = document.createElement('style');
  style.id = 'consentbit-inline-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

function injectHTML() {
  if (document.getElementById('consentBitBanner') && document.getElementById('cbPreferenceModal')) return true;
  const s = styleConfig;
  let bannerPositionClass = '';
  if (s.bannerType === 'banner') {
    bannerPositionClass = 'consentBit-type-banner';
  } else if (s.bannerType === 'bottom-center' || s.bannerType === 'popup') {
    bannerPositionClass = 'consentBit-type-popup';
  } else {
    bannerPositionClass = s.boxAlignment === 'bottom-right' ? 'consentBit-type-box-bottom-right' : 'consentBit-type-box-bottom-left';
  }
  const popupOverlay = s.bannerType === 'popup' ? '<div class="consentBit-popup-overlay" id="consentBitPopupOverlay"></div>' : '';
  const bannerHTML = \`
\${popupOverlay}
<div class="consentBit-consent-container \${bannerPositionClass}" id="consentBitBanner" tabindex="-1" aria-label="We value your privacy" role="region">
  <div class="consentBit-consent-bar" data-consentBit-tag="notice">
    <div class="consentBit-notice">
      <p class="consentBit-title" aria-level="2" data-consentBit-tag="title" role="heading">Your privacy matters to us</p>
      <div class="consentBit-notice-group">
        <div class="consentBit-notice-des" data-consentBit-tag="iab-description">
          <p>With your permission, we and <a href="#" id="consentBitVendorsLink" class="consentBit-vendors-link" data-consentBit-tag="vendors-link" aria-label="View the list of third-party vendors and the purposes, special features and stacks they use"><span id="consentBitVendorCountText">third-party vendors</span></a> store and/or access information on your device (such as cookies and device identifiers) and process your personal data (including unique identifiers, IP address, browsing activity and approximate location) for the purposes below. Some processing relies on legitimate interest, which you can object to. Choices apply to this website only and can be updated any time via the cookie icon at the bottom-left.</p>
          <p class="consentBit-purposes-line"><strong>Our partners collect your information for the following purposes:</strong> <span id="consentBitPurposesText" data-consentBit-tag="purposes-list">Store and/or access information on a device, Use limited data to select advertising, Create profiles for personalised advertising, Use profiles to select personalised advertising, Create profiles to personalise content, Use profiles to select personalised content, Measure advertising performance, Measure content performance, Understand audiences through statistics or combinations of data from different sources, Develop and improve services, Use limited data to select content</span>.<br/> <strong>They also use the following special features:</strong> <span id="consentBitSpecialFeaturesText" data-consentBit-tag="special-features-list">Use precise geolocation data, Actively scan device characteristics for identification</span>.</p>
        </div>
        <div class="consentBit-notice-btn-wrapper" data-consentBit-tag="notice-buttons">
          <button class="consentBit-btn consentBit-btn-customize" id="consentBitCustomiseBtn" aria-label="Customise" aria-haspopup="dialog" aria-controls="cbPreferenceModal" data-consentBit-tag="settings-button">Customise</button>
          <button class="consentBit-btn consentBit-btn-reject" id="consentBitRejectAllBanner" aria-label="Reject All" data-consentBit-tag="reject-button">Reject All</button>
          <button class="consentBit-btn consentBit-btn-accept" id="consentBitAcceptAllBanner" aria-label="Accept All" data-consentBit-tag="accept-button">Accept All</button>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="cb-modal cb-modal-hidden" id="cbPreferenceModal" tabindex="-1">
  <div class="cb-preference-center" role="dialog" aria-modal="true" aria-label="Customise Consent Preferences">
    <div class="cb-preference-header">
      <span class="cb-preference-title" role="heading" aria-level="2">Customise Consent Preferences</span>
      <button aria-label="Close" class="cb-btn-close" id="cbCloseBtn"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cline x1='18' y1='6' x2='6' y2='18'%3E%3C/line%3E%3Cline x1='6' y1='6' x2='18' y2='18'%3E%3C/line%3E%3C/svg%3E" alt="Close"></button>
    </div>
    <div class="cb-iab-detail-wrapper">
      <div class="cb-iab-preference-des"><p>Customise your consent preferences for Cookie Categories and advertising tracking preferences for Purposes &amp; Features and Vendors below. You can give granular consent for each Third Party Vendor. Most vendors require explicit consent for personal data processing, while some rely on legitimate interest. However, you have the right to object to their use of legitimate interest.</p>
        <details class="cb-cmp-disclosure" data-consentBit-tag="cmp-storage-disclosure">
          <summary>How this Consent Management Platform stores your choices</summary>
          <p>To remember the choices you make here, this CMP (cmpId 200) stores a TCF v2.2 consent string in the <code>euconsent-v2</code> cookie and in your browser's <code>localStorage</code> (keys <code>TCF_TC_STRING</code> and <code>cookieConsentPrefs</code>) for up to 365 days. The cookie is refreshed when you update your choices. No personal data is processed by the CMP itself; the consent string is shared with vendors so they can respect your choices.</p>
        </details>
      </div>
      <div class="cb-iab-navbar-wrapper">
        <ul class="cb-iab-navbar">
          <li class="cb-iab-nav-item cb-iab-nav-item-active" data-tab="cookie"><button aria-label="Cookie Categories" class="cb-iab-nav-btn">Cookie Categories</button></li>
          <li class="cb-iab-nav-item" data-tab="purpose"><button aria-label="Purposes &amp; Features" class="cb-iab-nav-btn">Purposes &amp; Features</button></li>
          <li class="cb-iab-nav-item" data-tab="vendor"><button aria-label="Vendors" class="cb-iab-nav-btn">Vendors</button></li>
        </ul>
      </div>
      <div class="cb-iab-detail-sub-wrapper">
        <div class="cb-preference-body-wrapper active" id="cbIABSectionCookie">
          <p class="cb-iab-detail-title">Cookie Categories</p>
          <div class="cb-preference-content-wrapper">
            <p>We use cookies to help you navigate efficiently and perform certain functions. You will find detailed information about all cookies under each consent category below.</p>
            <p>The cookies that are categorised as "Necessary" are stored on your browser as they are essential for enabling the basic functionalities of the site.</p>
          </div>
          <div class="cb-horizontal-separator"></div>
          <div class="cb-accordion-wrapper" id="cookieAccordions"></div>
        </div>
        <div class="cb-preference-body-wrapper" id="cbIABSectionPurpose">
          <p class="cb-iab-detail-title">Purposes &amp; Features</p>
          <div class="cb-accordion-wrapper" id="purposeAccordions"></div>
        </div>
        <div class="cb-preference-body-wrapper" id="cbIABSectionVendor">
          <p class="cb-iab-detail-title">Vendors</p>
          <div class="consentBit-vendors-search-wrapper">
            <div class="consentBit-search-container">
              <input type="text" id="vendorsSearch" class="consentBit-search-input" placeholder="Search vendors by name or ID..." autocomplete="off">
              <div class="consentBit-search-icon">🔍</div>
            </div>
            <div id="vendorsLoading" class="consentBit-loading">Loading vendors...</div>
            <div id="vendorsList" class="consentBit-vendors-list" style="display:none;"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="cb-footer-wrapper">
      <span class="cb-footer-shadow"></span>
      <div class="cb-prefrence-btn-wrapper">
        <button aria-label="Reject All" class="cb-btn cb-btn-reject" id="cbRejectBtn">Reject All</button>
        <button aria-label="Accept All" class="cb-btn cb-btn-accept" id="cbAcceptBtn">Accept All</button>
          <button aria-label="Save My Preferences" class="cb-btn cb-btn-preferences" id="cbSaveBtn">Save My Preferences</button>

        </div>
      <div class="cb-brand-footer">
        <a href="https://consentbit.com" target="_blank" rel="noopener noreferrer" aria-label="Powered by ConsentBit">
          <span class="cb-brand-credit">Powered by</span>
          <span class="cb-brand-mark">\${CB_WORDMARK_SVG}</span>
        </a>
      </div>
    </div>
  </div>
</div>\`;
  const wrapper = document.createElement('div');
  wrapper.classList.add('main-iab-wrapper');
  wrapper.innerHTML = bannerHTML;
  document.body.appendChild(wrapper);
  return true;
}

function ensureConsentUiShell() {
  if (!document.body) return false;
  return injectHTML();
}

function hideBanner() {
  const banner = document.getElementById('consentBitBanner');
  if (banner) banner.style.display = 'none';
}
function waitForTCF() {
    return new Promise((resolve) => {
        const check = () => {
            if (window.tcfManager && window.tcfManager.isInitialized) {
                resolve();
            } else {
                setTimeout(check, 50);
            }
        };
        check();
    });
}
  function ensureGtagInitialization() { 
    window.dataLayer = window.dataLayer || []; 
     
    if (typeof window.gtag === 'undefined') { 
      window.gtag = function() {  
        window.dataLayer.push(arguments);  
      }; 
    } 
     
    const gtmScripts = document.querySelectorAll('script[src*="googletagmanager"]'); 
    if (gtmScripts.length > 0) { 
      if (typeof window.gtag === 'function') { 
        try { 
          window.gtag('event', 'consent_scripts_enabled', { 
            'event_category': 'consent', 
            'event_label': 'scripts_re_enabled' 
          }); 
           
          setTimeout(function() { 
            try { 
              window.gtag('config', 'GA_MEASUREMENT_ID', { 
                'page_title': document.title, 
                'page_location': window.location.href 
              }); 
            } catch (e) { 
            } 
          }, 500); 
        } catch (e) { 
        } 
      } 
    } 
     
    const analyticsScripts = document.querySelectorAll('script[src*="analytics"], script[src*="gtag"], script[src*="googletagmanager"]'); 
    if (analyticsScripts.length > 0) { 
    } 
  } 
 
  function updateGtagConsent(preferences) { 
    if (typeof gtag === "function") { 
      gtag('consent', 'update', { 
        'analytics_storage': preferences.analytics ? 'granted' : 'denied', 
        'functionality_storage': 'granted', 
        'ad_storage': preferences.marketing ? 'granted' : 'denied', 
        'ad_personalization': preferences.marketing ? 'granted' : 'denied', 
        'ad_user_data': preferences.marketing ? 'granted' : 'denied', 
        'personalization_storage': preferences.personalization ? 'granted' : 'denied', 
        'security_storage': 'granted' 
      }); 
    } 
 
    // Push consent update event to dataLayer 
    if (typeof window.dataLayer !== 'undefined') { 
      window.dataLayer.push({ 
        'event': 'consent_update', 
        'consent_analytics': preferences.analytics, 
        'consent_marketing': preferences.marketing, 
        'consent_personalization': preferences.personalization 
      }); 
    } 
  }

// ─── Script Block Providers ──────────────────────────────────────────────────
// URL pattern → category mapping (mirrors consent-manager/src/data/scriptBlockProviders.js).
// Keep this in sync with the server-side list.
window.SCRIPT_BLOCK_PROVIDERS = [
  // Google Analytics / Tag Manager
  { pattern: 'google-analytics\\\\.com|googletagmanager\\\\.com/gtag/js|googletagmanager\\\\.com/gtm\\\\.js|region1\\\\.google-analytics\\\\.com', categories: ['analytics'] },
  // Google Ads / Display
  { pattern: 'googleadservices\\\\.com|googlesyndication\\\\.com|pagead/|google\\\\.com/pagead/|doubleclick\\\\.net|googleads\\\\.g\\\\.doubleclick\\\\.net', categories: ['marketing'] },
  // Facebook / Meta
  { pattern: 'connect\\\\.facebook\\\\.net|facebook\\\\.com/tr|pixel\\\\.facebook\\\\.com|fbevents\\\\.js', categories: ['marketing'] },
  // Microsoft / LinkedIn ads
  { pattern: 'bing\\\\.com|bat\\\\.bing\\\\.com|linkedin\\\\.com/px|snap\\\\.licdn\\\\.com', categories: ['marketing'] },
  // TikTok
  { pattern: 'analytics\\\\.tiktok\\\\.com|tiktok\\\\.com/i18n/pixel', categories: ['marketing'] },
  // Twitter / X
  { pattern: 'platform\\\\.twitter\\\\.com|twimg\\\\.com|t\\\\.co/1/i/adsct', categories: ['marketing'] },
  // Pinterest
  { pattern: 'pintrk\\\\.js|ct\\\\.pinterest\\\\.com', categories: ['marketing'] },
  // Snapchat
  { pattern: 'sc-static\\\\.net/scevent|tr\\\\.snapchat\\\\.com', categories: ['marketing'] },
  // Reddit
  { pattern: 'redditstatic\\\\.com/ads|reddit\\\\.com/api/v1/pixel', categories: ['marketing'] },
  // Amazon / Criteo / Taboola / Outbrain
  { pattern: 'amazon-adsystem\\\\.com|media\\\\.amazon\\\\.com|dsp\\\\.amazon|criteo\\\\.com|taboola\\\\.com|outbrain\\\\.com|widgets\\\\.outbrain\\\\.com', categories: ['marketing'] },
  // AdRoll
  { pattern: 'adroll\\\\.com|adroll_adv_id|adroll_pix_id|__adroll_loaded|roundtrip\\\\.js', categories: ['marketing'] },
  // Hotjar / Clarity / FullStory / Heap / Mixpanel / Amplitude / Segment / PostHog
  { pattern: 'hotjar\\\\.com|clarity\\\\.ms|fullstory\\\\.com|heap-analytics\\\\.com|cdn\\\\.heap|mixpanel\\\\.com|amplitude\\\\.com|segment\\\\.com|segment\\\\.io|cdn\\\\.segment|posthog\\\\.com|app\\\\.posthog', categories: ['analytics', 'behavioral'] },
  // Intercom / Drift / Zendesk
  { pattern: 'intercom\\\\.io|intercomcdn\\\\.com|drift\\\\.com|js\\\\.driftt\\\\.com|zendesk\\\\.com/embeddable|zdassets\\\\.com', categories: ['marketing', 'preferences'] },
  // HubSpot / Marketo / Pardot / Mailchimp / Klaviyo
  { pattern: 'hubspot\\\\.com|hs-scripts\\\\.com|hsforms\\\\.com|marketo\\\\.com|mktoresp\\\\.com|pardot\\\\.com|go\\\\.pardot|list-manage\\\\.com|klaviyo\\\\.com|static\\\\.klaviyo', categories: ['marketing'] },
  // Vimeo / Wistia
  { pattern: 'player\\\\.vimeo\\\\.com|vimeo\\\\.com/api/player|wistia\\\\.com|fast\\\\.wistia', categories: ['marketing'] },
  // Spotify / SoundCloud
  { pattern: 'spotify\\\\.com/embed|soundcloud\\\\.com/player', categories: ['marketing'] },
  // Yahoo / Verizon Media
  { pattern: 'yahoo\\\\.com|yimg\\\\.com|advertising\\\\.com|gemini\\\\.yahoo\\\\.com', categories: ['marketing'] },
  // Yandex / VK
  { pattern: 'yandex\\\\.ru/metrika|mc\\\\.yandex|vk\\\\.com/js|top-fwz1\\\\.mail\\\\.ru', categories: ['analytics', 'marketing'] },
  // Adobe Analytics / Target
  { pattern: 'omniture\\\\.com|adobedtm\\\\.com|demdex\\\\.net|tt.omtrdc\\\\.net|mbox\\\\.js', categories: ['analytics', 'marketing'] },
  // Quantcast / LiveRamp / Trade Desk
  { pattern: 'quantcast\\\\.com|quantserve\\\\.com|liveramp\\\\.com|rlcdn\\\\.com|thetradedesk\\\\.com|adsrvr\\\\.org', categories: ['marketing'] },
  // Braze / Iterable
  { pattern: 'braze\\\\.com|sdk\\\\.braze|iterable\\\\.com|api\\\\.iterable', categories: ['marketing'] },
  // New Relic / Datadog RUM
  { pattern: 'newrelic\\\\.com|nr-data\\\\.net|datadoghq-browser-agent|datadoghq\\\\.com', categories: ['analytics'] },
  // Sentry
  { pattern: 'sentry\\\\.io|browser.sentry-cdn', categories: ['analytics'] },
  // Matomo / Plausible / Fathom
  { pattern: 'matomo\\\\.php|plausible\\\\.io|usefathom\\\\.com|cdn\\\\.usefathom', categories: ['analytics'] },
  // Cloudflare Web Analytics
  { pattern: 'static\\\\.cloudflareinsights\\\\.com|cloudflareinsights\\\\.com', categories: ['analytics'] },
  // Mouseflow / Lucky Orange / Crazy Egg / Inspectlet
  { pattern: 'mouseflow\\\\.com|cdn\\\\.mouseflow|luckyorange\\\\.com|cdn\\\\.luckyorange|crazyegg\\\\.com|cdn\\\\.crazyegg|inspectlet\\\\.com|cdn\\\\.inspectlet', categories: ['analytics', 'behavioral'] },
  // Chartbeat / Parse.ly / Piano / Tealium / Ensighten
  { pattern: 'chartbeat\\\\.com|static\\\\.chartbeat|parsely\\\\.com|cdn\\\\.parsely|piano\\\\.io|tealiumiq\\\\.com|tags\\\\.tiqcdn|ensighten\\\\.com', categories: ['analytics', 'marketing'] },
  // Shopify analytics
  { pattern: 'shopify\\\\.com/s/javascripts|monorail-edge\\\\.shopifysvc\\\\.com', categories: ['marketing', 'analytics'] },
  // Calendly / Typeform / Tally
  { pattern: 'calendly\\\\.com/assets|assets\\\\.calendly|typeform\\\\.com|tally\\\\.so', categories: ['preferences', 'marketing'] },
  // Google Maps JS API
  { pattern: 'maps\\\\.googleapis\\\\.com/maps/api/js', categories: ['preferences'] },
];
// ─────────────────────────────────────────────────────────────────────────────

// ─── CDN-style Script Blocking ───────────────────────────────────────────────
// Mirrors the blocking mechanism in cdn.js (iabloader):
//   - document.createElement hook catches dynamically injected scripts
//   - MutationObserver catches scripts inserted directly into DOM
//   - blockNonEssentialScripts() sweeps existing scripts at DOMContentLoaded
//   - releaseBlockedScripts() re-injects scripts after consent is granted
// Blocked scripts: type="javascript/blocked", src moved to data-cb-blocked-src
// ─────────────────────────────────────────────────────────────────────────────

var __cbInternalCreate = false;
var __cbCreateElementBackup = null;

/**
 * Resolve consent categories for a script.
 * Priority: data-category attr → data-cookieyes attr → URL pattern matching.
 * Returns [] if the script is not managed (allow freely).
 */
function resolveScriptCategories(url, el) {
  if (el && el.getAttribute) {
    var dataCat = el.getAttribute('data-category');
    if (dataCat) {
      return dataCat.split(',').map(function(c) { return c.trim().toLowerCase(); });
    }
    var cky = el.getAttribute('data-cookieyes');
    if (cky) {
      var m = cky.match(/categories:([^|]+)/);
      if (m) return m[1].split(',').map(function(c) { return c.trim().toLowerCase(); });
    }
  }
  var providers = (window.siteConfig && window.siteConfig.scriptBlockProviders) || window.SCRIPT_BLOCK_PROVIDERS || [];
  var matchTarget = '';
  if (url && typeof url === 'string') matchTarget += url + ' ';
  if (el && typeof el.textContent === 'string') matchTarget += el.textContent;
  if (matchTarget && providers.length) {
    for (var pi = 0; pi < providers.length; pi++) {
      var p = providers[pi];
      if (!p || !p.pattern) continue;
      try {
        if (new RegExp(p.pattern, 'i').test(matchTarget)) {
          return p.categories && p.categories.length ? p.categories.slice() : ['analytics'];
        }
      } catch(e) {}
    }
  }
  return [];
}

/**
 * Check if a given category is currently consented to.
 * Falls back to blocking when no stored consent exists.
 */
function isCategoryAllowed(category) {
  var cat = String(category).toLowerCase();
  if (cat === 'necessary' || cat === 'essential') return true;

  var categoryMap = {
    'analytics': 'analytics',
    'functional': 'functional',
    'performance': 'performance',
    'advertisement': 'advertisement',
    'advertising': 'advertisement',
    'marketing': 'advertisement'
  };
  var key = categoryMap[cat] || cat;

  // 1. Check in-memory state first — set synchronously by acceptAll/rejectAll/savePreferences
  //    so it is always up-to-date during the same page session.
  if (window.__cbConsentState) {
    if (window.__cbConsentState.allGranted) return true;
    if (window.__cbConsentState.allDenied) return false;
    if (window.__cbConsentState.categories) {
      var memCat = window.__cbConsentState.categories;
      if (memCat[key] !== undefined) return !!memCat[key];
      if (memCat[cat] !== undefined) return !!memCat[cat];
    }
  }

  // 2. Try Tcfmanager.js loadStoredConsent (cookieCategories format)
  var prefs = null;
  try {
    if (window.tcfManager && typeof window.tcfManager.loadStoredConsent === 'function') {
      prefs = window.tcfManager.loadStoredConsent();
    }
  } catch(e) {}

  // 3. Fallback: scan localStorage for consentbit_* keys (cdn.js flat-categories format)
  if (!prefs) {
    try {
      for (var lsi = 0; lsi < localStorage.length; lsi++) {
        var lsKey = localStorage.key(lsi);
        if (lsKey && lsKey.indexOf('consentbit_') === 0) {
          var lsRaw = localStorage.getItem(lsKey);
          if (lsRaw) {
            var lsData = JSON.parse(lsRaw);
            if (lsData && lsData.accepted) { prefs = lsData; break; }
          }
        }
      }
    } catch(e) {}
  }

  if (!prefs) return false; // no consent recorded → block

  // cookieCategories format: { cookieCategories: { analytics: { enabled: true } } }
  if (prefs.cookieCategories && prefs.cookieCategories[key]) {
    return !!prefs.cookieCategories[key].enabled;
  }

  // cdn.js flat format: { accepted: true, categories: { analytics: true, marketing: true, ... } }
  if (prefs.categories) {
    var cdnMap = {
      'analytics': 'analytics',
      'functional': 'preferences',
      'performance': 'preferences',
      'advertisement': 'marketing',
      'advertising': 'marketing',
      'marketing': 'marketing'
    };
    var cdnKey = cdnMap[cat] || cat;
    if (prefs.categories[cdnKey] !== undefined) return !!prefs.categories[cdnKey];
    if (prefs.accepted) return true; // acceptAll: everything granted
  }

  return false;
}

/**
 * Microsoft Clarity tag hosts. Clarity is governed by a consent SIGNAL, not by this
 * blocker: Microsoft's CMP integration guide requires the tag to load regardless of
 * consent status, and with consent denied Clarity runs cookieless on its own (no
 * _clck / _clsk / MUID). Hard-blocking it would leave it with no signal at all.
 */
function cbIsClarityUrl(u) {
  var s = typeof u === 'string' ? u.toLowerCase() : '';
  if (!s) return false;
  var cfg = (typeof window !== 'undefined' && window.__CONSENT_SITE__) || {};
  if (cfg.clarityConsentMode === false) return false;
  return s.indexOf('clarity.ms') !== -1 || s.indexOf('clarity.microsoft.com') !== -1;
}

/**
 * Signal the visitor's decision to Microsoft Clarity's Consent API v2.
 *   analytics_Storage — analytics purposes; gates _clck / _clsk
 *   ad_Storage        — advertising purposes; gates MUID
 * Key names are case-sensitive (capital S); values must be lowercase. Granular choices
 * are respected — analytics-only consent must not grant ad_Storage. Deduped on
 * __cbClaritySignal because Microsoft asks CMPs to avoid redundant state changes.
 */
function cbClarityConsent(categories) {
  try {
    var cfg = (typeof window !== 'undefined' && window.__CONSENT_SITE__) || {};
    if (cfg.clarityConsentMode === false) return;
    var cats = categories || {};
    var ad = cats.marketing ? 'granted' : 'denied';
    var an = cats.analytics ? 'granted' : 'denied';
    var sg = ad + '|' + an;
    if (window.__cbClaritySignal === sg) return;
    window.__cbClaritySignal = sg;
    window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
    window.clarity('consentv2', { source: (cfg.clarityCmpId || 'consentbit'), ad_Storage: ad, analytics_Storage: an });
  } catch (e) {}
}

/**
 * Decide whether a script URL should be blocked given current consent state.
 */
function shouldBlockScript(url, el) {
  if (__cbInternalCreate) return false;
  var u = typeof url === 'string' ? url.toLowerCase() : '';
  if (u && (u.indexOf('consentbit') !== -1 || u.indexOf('consentv2') !== -1 || u.indexOf('tcfmanager') !== -1)) return false;
  if (cbIsClarityUrl(u)) return false;

  var cats = resolveScriptCategories(url, el);
  if (!cats || cats.length === 0) return false; // unmanaged → allow

  for (var i = 0; i < cats.length; i++) {
    if (cats[i] === 'necessary' || cats[i] === 'essential') return false;
  }
  for (var j = 0; j < cats.length; j++) {
    if (isCategoryAllowed(cats[j])) return false; // at least one category consented → allow
  }
  return true; // all categories denied → block
}

/**
 * Patch a dynamically-created script element's src setter so blocking
 * happens the moment a src is assigned (before the browser starts loading).
 */
function patchDynamicScriptElement(el) {
  if (!el || el.__cbPatched) return;
  el.__cbPatched = true;
  var proto = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  if (!proto) return;
  Object.defineProperty(el, 'src', {
    set: function(value) {
      if (shouldBlockScript(value, el)) {
        el.setAttribute('data-cb-blocked-src', value);
        el.setAttribute('type', 'javascript/blocked');
        // console.log('[ConsentBit][Setter] BLOCKED:', value);
        return;
      }
      proto.set.call(el, value);
    },
    get: function() {
      return el.getAttribute('data-cb-blocked-src') || proto.get.call(el);
    },
    configurable: true
  });
}

/**
 * Block a script node that was inserted directly into the DOM.
 */
function applyBlockToScriptNode(node) {
  if (!node || node.nodeName !== 'SCRIPT') return;
  if (node.getAttribute && node.getAttribute('type') === 'javascript/blocked') return;
  var src = (node.getAttribute && node.getAttribute('src')) || node.src || '';
  if (!shouldBlockScript(src, node)) return;
  try {
    if (src) {
      node.setAttribute('data-cb-blocked-src', src);
      node.removeAttribute('src');
    } else {
      node.setAttribute('data-cb-blocked-inline', 'true');
    }
    node.setAttribute('type', 'javascript/blocked');
    // console.log('[ConsentBit][Dynamic] BLOCKED:', src || '[inline-script]');
  } catch(e) {}
}

/**
 * Install the document.createElement hook + MutationObserver.
 * Call this as early as possible — before any tracking scripts run.
 */
function installConsentScriptBlocker() {
  if (window.__cbCreateElementHookInstalled) return;
  window.__cbCreateElementHookInstalled = true;
  try {
    __cbCreateElementBackup = document.createElement.bind(document);
  } catch(e) {
    __cbCreateElementBackup = document.createElement;
  }
  document.createElement = function(tagName) {
    var el = __cbCreateElementBackup(tagName);
    if (String(tagName || '').toLowerCase() === 'script') {
      patchDynamicScriptElement(el);
    }
    return el;
  };
  var obs = new MutationObserver(function(mutations) {
    for (var mi = 0; mi < mutations.length; mi++) {
      var adds = mutations[mi].addedNodes;
      for (var ai = 0; ai < adds.length; ai++) {
        applyBlockToScriptNode(adds[ai]);
      }
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  /** @type {any} */ (window).__cbMutationObserver = obs;
  // console.log('[ConsentBit] ✅ Script blocker installed — createElement hook + MutationObserver active');
  // console.log('[ConsentBit] Script block providers:', (window.siteConfig && window.siteConfig.scriptBlockProviders) || window.SCRIPT_BLOCK_PROVIDERS || []);
}

/**
 * Sweep the DOM at DOMContentLoaded and block any unblocked non-essential scripts.
 * Scripts parsed before consentv2.js loaded cannot be retroactively blocked —
 * place <script src="consentv2.js"> as the FIRST script in <head> for full coverage.
 */
function blockNonEssentialScripts() {
  var scripts = Array.from(document.querySelectorAll('script'));
  // console.log('[ConsentBit][Block] 🔍 Sweeping', scripts.length, 'scripts — consent state:', JSON.stringify(window.__cbConsentState || null));
  var blocked = 0;
  var skipped = 0;
  scripts.forEach(function(s) {
    var src = s.getAttribute('src') || s.src || '';
    if (!shouldBlockScript(src, s)) {
      skipped++;
      return;
    }
    try {
      if (src) {
        s.setAttribute('data-cb-blocked-src', src);
        s.removeAttribute('src');
      } else {
        s.setAttribute('data-cb-blocked-inline', 'true');
      }
      s.setAttribute('type', 'javascript/blocked');
      blocked++;
      // console.log('[ConsentBit][Block] 🚫 BLOCKED:', src, '| categories:', resolveScriptCategories(src, s));
    } catch(e) { console.warn('[ConsentBit][Block] Failed to block:', src, e); }
  });
  // console.log('[ConsentBit][Block] ✅ Done — blocked:', blocked, '| allowed/skipped:', skipped);
}

/**
 * Re-inject all blocked scripts whose categories are now consented to.
 * Call this after acceptAll() or savePreferences().
 */
function releaseBlockedScripts() {
  var list = Array.from(document.querySelectorAll('script[type="javascript/blocked"]'));
  // console.log('[ConsentBit][Release] 🔍 Found', list.length, 'blocked scripts — consent state:', JSON.stringify(window.__cbConsentState || null));
  var released = 0;
  var stillBlocked = 0;

  list.forEach(function(el) {
    var src = el.getAttribute('data-cb-blocked-src');
    if (shouldBlockScript(src, el)) {
      stillBlocked++;
      // console.log('[ConsentBit][Release] ⛔ Still blocked (denied):', src, '| categories:', resolveScriptCategories(src, el));
      return; // still denied
    }

    __cbInternalCreate = true;
    try {
      var ns = document.createElement('script');
      ns.async = el.hasAttribute('async');
      ns.defer = el.hasAttribute('defer');
      if (el.crossOrigin) ns.crossOrigin = el.crossOrigin;
      if (el.integrity) ns.integrity = el.integrity;
      Array.from(el.attributes).forEach(function(attr) {
        if (attr.name !== 'type' && attr.name !== 'data-cb-blocked-src' && attr.name !== 'data-cb-blocked-inline' && attr.name !== 'src') {
          ns.setAttribute(attr.name, attr.value);
        }
      });
      ns.type = 'text/javascript';
      if (src) {
        ns.src = src;
        ns.onload = function() { ensureGtagInitialization(); };
      } else if (el.textContent) {
        ns.text = el.textContent;
      }
      (el.parentNode || document.head).insertBefore(ns, el);
      el.remove();
      released++;
      // console.log('[ConsentBit][Release] Released:', src);
    } catch(e) {
      console.warn('[ConsentBit][Release] Failed:', src, e);
    } finally {
      __cbInternalCreate = false;
    }
  });

  // Also release legacy text/plain blocked scripts (blockScriptsByCategory format)
  var legacy = Array.from(document.querySelectorAll('script[type="text/plain"][data-category]'));
  legacy.forEach(function(el) {
    var src = el.getAttribute('src') || '';
    var cats = resolveScriptCategories(src, el);
    if (!cats.length) return;
    var anyAllowed = cats.some(function(c) { return isCategoryAllowed(c); });
    if (!anyAllowed) return;
    __cbInternalCreate = true;
    try {
      if (src) {
        var ns = document.createElement('script');
        Array.from(el.attributes).forEach(function(attr) {
          if (attr.name !== 'type' && attr.name !== 'data-blocked-by-consent' && attr.name !== 'data-blocked-by-ccpa') {
            ns.setAttribute(attr.name, attr.value);
          }
        });
        ns.type = 'text/javascript';
        ns.onload = function() { ensureGtagInitialization(); };
        el.parentNode.insertBefore(ns, el);
        el.remove();
      } else {
        el.type = 'text/javascript';
        el.removeAttribute('data-blocked-by-consent');
        if (el.innerHTML) { try { eval(el.innerHTML); } catch(e) {} }
      }
      released++;
    } catch(e) {} finally {
      __cbInternalCreate = false;
    }
  });

  // console.log('[ConsentBit][Release] ✅ Done — released:', released, '| still blocked:', stillBlocked);
  setTimeout(ensureGtagInitialization, 100);
}

// Install blocker immediately — don't wait for DOMContentLoaded
installConsentScriptBlocker();
initConsentDependencies();

// Signal the stored decision (or default-denied) to Microsoft Clarity as early as
// possible, queueing it if clarity.js has not loaded yet. isCategoryAllowed() already
// understands every storage format we support, so one call covers first visits,
// returning visitors, and the accept-all shortcut alike.
cbClarityConsent({ analytics: isCategoryAllowed('analytics'), marketing: isCategoryAllowed('advertisement') });

// ─── Banner Entrance Animation (server-baked override) ───────────────────────
// Injects a <style> with the chosen entrance animation (fade-in / slide-up /
// slide-down / zoom-in). #consentBitBanner ID selector + !important overrides
// the hardcoded .consentBit-consent-container and .consentBit-type-popup rules.
(function __cbInjectBannerEntranceAnimation() {
  if (document.getElementById('consentbit-anim-styles')) return;
  var s = document.createElement('style');
  s.id = 'consentbit-anim-styles';
  s.textContent = ${animCssLiteral};
  (document.head || document.documentElement).appendChild(s);
})();
// ─────────────────────────────────────────────────────────────────────────────

// Cookie Categories Data
const cookieCategories = [
    {
        id: 'necessary',
        name: 'Necessary',
        description: 'Necessary cookies are required to enable the basic features of this site, such as providing secure log-in or adjusting your consent preferences. These cookies do not store any personally identifiable data.',
        alwaysActive: true,
        cookies: [
            {
                name: '_cfuvid',
                duration: 'session',
                description: 'Calendly sets this cookie to track users across sessions to optimize user experience by maintaining session consistency and providing personalized services'
            },
            {
                name: 'cookieyes-consent',
                duration: '1 year',
                description: 'CookieYes sets this cookie to remember users\\' consent preferences so that their preferences are respected on subsequent visits to this site. It does not collect or store any personal information about the site visitors.'
            }
        ]
    },
    {
        id: 'functional',
        name: 'Functional',
        description: 'Functional cookies help perform certain functionalities like sharing the content of the website on social media platforms, collecting feedback, and other third-party features.',
        alwaysActive: false,
        cookies: []
    },
    {
        id: 'analytics',
        name: 'Analytics',
        description: 'Analytical cookies are used to understand how visitors interact with the website. These cookies help provide information on metrics such as the number of visitors, bounce rate, traffic source, etc.',
        alwaysActive: false,
        cookies: [
            {
                name: '_hjSessionUser_*',
                duration: '1 year',
                description: 'Hotjar sets this cookie to ensure data from subsequent visits to the same site is attributed to the same user ID, which persists in the Hotjar User ID, which is unique to that site.'
            },
            {
                name: '_hjSession_*',
                duration: '1 hour',
                description: 'Hotjar sets this cookie to ensure data from subsequent visits to the same site is attributed to the same user ID, which persists in the Hotjar User ID, which is unique to that site.'
            }
        ]
    },
    {
        id: 'performance',
        name: 'Performance',
        description: 'Performance cookies are used to understand and analyse the key performance indexes of the website which helps in delivering a better user experience for the visitors.',
        alwaysActive: false,
        cookies: [
            {
                name: 'SRM_B',
                duration: '1 year 24 days',
                description: 'Used by Microsoft Advertising as a unique ID for visitors.'
            }
        ]
    },
    {
        id: 'advertisement',
        name: 'Advertisement',
        description: 'Advertisement cookies are used to provide visitors with customised advertisements based on the pages you visited previously and to analyse the effectiveness of the ad campaigns.',
        alwaysActive: false,
        cookies: [
            {
                name: 'MUID',
                duration: '1 year 24 days',
                description: 'Bing sets this cookie to recognise unique web browsers visiting Microsoft sites. This cookie is used for advertising, site analytics, and other operations.'
            },
            {
                name: 'ANONCHK',
                duration: '10 minutes',
                description: 'The ANONCHK cookie, set by Bing, is used to store a user\\'s session ID and verify ads\\' clicks on the Bing search engine. The cookie helps in reporting and personalization as well.'
            }
        ]
    }
];

// Purposes Data (TCF v2.2)
const purposesData = [
    {
        id: 'purposes',
        title: 'Purposes (11)',
        hasToggle: true,
        items: [
            {
                id: 'purpose1',
                title: 'Store and/or access information on a device',
                description: 'Cookies, device or similar online identifiers (e.g. login-based identifiers, randomly assigned identifiers, network based identifiers) together with other information (e.g. browser type and information, language, screen size, supported technologies etc.) can be stored or read on your device to recognise it each time it connects to an app or to a website, for one or several of the purposes presented here.',
                illustrations: [
                    'Most purposes explained in this notice rely on the storage or accessing of information from your device when you use an app or visit a website. For example, a vendor or publisher might need to store a cookie on your device during your first visit on a website, to be able to recognise your device during your next visits (by accessing this cookie each time).'
                ],
                vendorCount: 777,
                hasConsent: true,
                hasLegitimate: false
            },
            {
                id: 'purpose2',
                title: 'Use limited data to select advertising',
                description: 'Advertising presented to you on this service can be based on limited data, such as the website or app you are using, your non-precise location, your device type or which content you are (or have been) interacting with (for example, to limit the number of times an ad is presented to you).',
                illustrations: [
                    'A car manufacturer wants to promote its electric vehicles to environmentally conscious users living in the city after office hours. The advertising is presented on a page with related content (such as an article on climate change actions) after 6:30 p.m. to users whose non-precise location suggests that they are in an urban zone.',
                    'A large producer of watercolour paints wants to carry out an online advertising campaign for its latest watercolour range, diversifying its audience to reach as many amateur and professional artists as possible and avoiding showing the ad next to mismatched content (for instance, articles about how to paint your house). The number of times that the ad has been presented to you is detected and limited, to avoid presenting it too often.'
                ],
                vendorCount: 734,
                hasConsent: true,
                hasLegitimate: true
            },
            {
                id: 'purpose3',
                title: 'Create profiles for personalised advertising',
                description: 'Information about your activity on this service (such as forms you submit, content you look at) can be stored and combined with other information about you (for example, information from your previous activity on this service and other websites or apps) or similar users. This is then used to build or improve a profile about you (that might include possible interests and personal aspects). Your profile can be used (also later) to present advertising that appears more relevant based on your possible interests by this and other entities.',
                illustrations: [
                    'If you read several articles about the best bike accessories to buy, this information could be used to create a profile about your interest in bike accessories.',
                    'An apparel company wishes to promote its new line of high-end baby clothes by building profiles of wealthy young parents.'
                ],
                vendorCount: 594,
                hasConsent: true,
                hasLegitimate: false
            },
            {
                id: 'purpose4',
                title: 'Use profiles to select personalised advertising',
                description: 'Advertising presented to you on this service can be based on your advertising profiles, which can reflect your activity on this service or other websites or apps, possible interests and personal aspects.',
                illustrations: [
                    'An online retailer targets users who previously looked at running shoes.',
                    'A profile created on one site is used on another app to show relevant ads.'
                ],
                vendorCount: 596,
                hasConsent: true,
                hasLegitimate: false
            },
            {
                id: 'purpose5',
                title: 'Create profiles to personalise content',
                description: 'Information about your activity on this service can be stored and combined with other information to build or improve a profile which is then used to present more relevant content.',
                illustrations: [
                    'Reading DIY articles leads to more DIY content recommendations.',
                    'Viewing space videos creates interest profile for space content.'
                ],
                vendorCount: 267,
                hasConsent: true,
                hasLegitimate: false
            },
            {
                id: 'purpose6',
                title: 'Use profiles to select personalised content',
                description: 'Content presented to you can be based on your content personalisation profiles and interests.',
                illustrations: [
                    'Vegetarian recipes shown based on reading habits.',
                    'Rowing videos recommended based on viewing history.'
                ],
                vendorCount: 238,
                hasConsent: true,
                hasLegitimate: false
            },
            {
                id: 'purpose7',
                title: 'Measure advertising performance',
                description: 'Information regarding which advertising is presented to you and how you interact with it can be used to determine how well an advert has worked.',
                illustrations: [
                    'Clicks and purchases tracked for ad performance.',
                    'Ad placement optimisation based on interaction data.'
                ],
                vendorCount: 847,
                hasConsent: true,
                hasLegitimate: true
            },
            {
                id: 'purpose8',
                title: 'Measure content performance',
                description: 'Information regarding which content is presented to you and how you interact with it can be used to determine content effectiveness.',
                illustrations: [
                    'Blog engagement tracked for content planning.',
                    'Video watch time used to optimise length.'
                ],
                vendorCount: 404,
                hasConsent: true,
                hasLegitimate: true
            },
            {
                id: 'purpose9',
                title: 'Understand audiences through statistics or combinations of data from different sources',
                description: 'Reports can be generated based on the combination of data sets regarding interactions to identify common characteristics.',
                illustrations: [
                    'Online bookstore audience analytics.',
                    'Advertiser audience comparison study.'
                ],
                vendorCount: 548,
                hasConsent: true,
                hasLegitimate: true
            },
            {
                id: 'purpose10',
                title: 'Develop and improve services',
                description: 'Information about your activity can be used to improve products and services and build new services.',
                illustrations: [
                    'Optimising ads for mobile devices.',
                    'Developing new ad formats for new devices.'
                ],
                vendorCount: 633,
                hasConsent: true,
                hasLegitimate: true
            },
            {
                id: 'purpose11',
                title: 'Use limited data to select content',
                description: 'Content can be based on limited data such as website/app used, non-precise location, device type, or interactions.',
                illustrations: [
                    'Travel content selected by location.',
                    'Shorter videos selected based on fast-forward behaviour.'
                ],
                vendorCount: 174,
                hasConsent: true,
                hasLegitimate: true
            }
        ]
    },
    {
        id: 'special_purposes',
        title: 'Special Purposes (3)',
        hasToggle: false,
        items: [
            {
                id: 'specialPurpose1',
                title: 'Ensure security, prevent and detect fraud, and fix errors',
                description: 'Your data can be used to monitor for and prevent unusual and possibly fraudulent activity (for example, regarding advertising, ad clicks by bots), and ensure systems and processes work properly and securely. It can also be used to correct any problems you, the publisher or the advertiser may encounter in the delivery of content and ads and in your interaction with them.',
                illustrations: [
                    'An advertising intermediary delivers ads from various advertisers to its network of partnering websites. It notices a large increase in clicks on ads relating to one advertiser, and uses data regarding the source of the clicks to determine that 80% of the clicks come from bots rather than humans.'
                ],
                vendorCount: 595,
                hasConsent: false,
                hasLegitimate: false
            },
            {
                id: 'specialPurpose2',
                title: 'Deliver and present advertising and content',
                description: 'Certain information (like an IP address or device capabilities) is used to ensure the technical compatibility of the content or advertising, and to facilitate the transmission of the content or ad to your device.',
                illustrations: [
                    'Clicking on a link in an article might normally send you to another page or part of the article. To achieve this, your browser sends a request to a server linked to the website, and the server answers back using technical information automatically included in the request sent by your device, to properly display the information/images that are part of the article you asked for.'
                ],
                vendorCount: 594,
                hasConsent: false,
                hasLegitimate: false
            },
            {
                id: 'specialPurpose3',
                title: 'Save and communicate privacy choices',
                description: 'The choices you make regarding the purposes and entities listed in this notice are saved and made available to those entities in the form of digital signals (such as a string of characters). This is necessary in order to enable both this service and those entities to respect such choices.',
                illustrations: [
                    'When you visit a website and are offered a choice between consenting to the use of profiles for personalised advertising or not consenting, the choice you make is saved and made available to advertising providers, so that advertising presented to you respects that choice.'
                ],
                vendorCount: 445,
                hasConsent: false,
                hasLegitimate: false
            }
        ]
    },
    {
        id: 'features',
        title: 'Features (3)',
        hasToggle: false,
        items: [
            {
                id: 'feature1',
                title: 'Match and combine data from other data sources',
                description: 'Information about your activity on this service may be matched and combined with other information relating to you and originating from various sources (for instance your activity on a separate online service, your use of a loyalty card in-store, or your answers to a survey), in support of the purposes explained in this notice.',
                vendorCount: 436,
                hasConsent: false,
                hasLegitimate: false
            },
            {
                id: 'feature2',
                title: 'Link different devices',
                description: 'In support of the purposes explained in this notice, your device might be considered as likely linked to other devices that belong to you or your household (for instance because you are logged in to the same service on both your phone and your computer, or because you may use the same Internet connection on both devices).',
                vendorCount: 369,
                hasConsent: false,
                hasLegitimate: false
            },
            {
                id: 'feature3',
                title: 'Identify devices based on information transmitted automatically',
                description: 'Your device might be distinguished from other devices based on information it automatically sends when accessing the Internet (for instance, the IP address of your Internet connection or the type of browser you are using) in support of the purposes exposed in this notice.',
                vendorCount: 558,
                hasConsent: false,
                hasLegitimate: false
            }
        ]
    },
    {
        id: 'special-features',
        title: 'Special Features (2)',
        hasToggle: true,
        items: [
            {
                id: 'special-feature1',
                title: 'Use precise geolocation data',
                description: 'With your acceptance, your precise location (within a radius of less than 500 metres) may be used in support of the purposes explained in this notice.',
                vendorCount: 280,
                hasConsent: true,
                hasLegitimate: false
            },
            {
                id: 'special-feature2',
                title: 'Actively scan device characteristics for identification',
                description: 'With your acceptance, certain characteristics specific to your device might be requested and used to distinguish it from other devices (such as the installed fonts or plugins, the resolution of your screen) in support of the purposes explained in this notice.',
                vendorCount: 157,
                hasConsent: true,
                hasLegitimate: false
            }
        ]
    }
];

// Initialize Cookie Accordions
function initCookieAccordions() {
    const container = document.getElementById('cookieAccordions');
    if (!container || container.children.length > 0) return;
    
    cookieCategories.forEach((category) => {
        const hasData = category.cookies.length > 0;
        
        const accordion = document.createElement('div');
        accordion.className = 'cb-accordion';
        accordion.id = \`cbDetailCategory\${category.id}\`;
        
        let toggleSection = '';
        if (hasData) {
            const isAlwaysActive = category.alwaysActive;
            const switchAttrs = isAlwaysActive
                ? \`type="checkbox" id="cbSwitch\${category.id}" checked disabled aria-label="\${category.name} (Always Active)" autocomplete="off"\`
                : \`type="checkbox" id="cbSwitch\${category.id}" aria-label="Enable \${category.name}" autocomplete="off"\`;
            
            const badge = isAlwaysActive ? '<span class="cb-always-active">Always Active</span>' : '';
            
            toggleSection = \`
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div class="cb-switch-sm">
                        <input \${switchAttrs} style="\${isAlwaysActive ? 'background-color: #2e7d32;' : ''}">
                    </div>
                    \${badge}
                </div>\`;
        }
        
        accordion.innerHTML = \`
            <div class="cb-accordion-item">
                <div class="cb-accordion-chevron">
                    <i class="cb-chevron-right"></i>
                </div>
                <div class="cb-accordion-header-wrapper">
                    <div class="cb-accordion-header" style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
                        <button class="cb-accordion-btn" aria-expanded="false" aria-controls="cbDetailCategory\${category.id}Body">
                            \${category.name}
                        </button>
                        \${toggleSection}
                    </div>
                    <div class="cb-accordion-header-des">
                       
                    </div>
                </div>
            </div>
            <div class="cb-accordion-body" id="cbDetailCategory\${category.id}Body">
                <div class="cb-audit-table">
                 \${category.description}
                </div>
            </div>
        \`;
        
        container.appendChild(accordion);
    });
}

// Initialize Purpose Accordions
function initPurposeAccordions() {
    const container = document.getElementById('purposeAccordions');
    if (!container || container.children.length > 0) return;
    
    purposesData.forEach(section => {
        const accordion = document.createElement('div');
        accordion.className = 'cb-accordion';
        accordion.id = \`cbIABPNFSection\${section.id}\`;
        
        const toggleHtml = section.hasToggle ? \`
            <div style="display: flex; align-items: center; gap: 8px;">
                <div class="cb-switch-sm">
                    <input type="checkbox" id="cbIABPNFSection\${section.id}Toggle" aria-label="Enable \${section.title}" autocomplete="off">
                </div>
            </div>
        \` : '';
        
        accordion.innerHTML = \`
            <div class="cb-accordion-iab-item">
                <div class="cb-accordion-chevron">
                    <i class="cb-chevron-right"></i>
                </div>
                <div class="cb-accordion-header-wrapper">
                    <div class="cb-accordion-header" style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
                        <button class="cb-accordion-btn" aria-expanded="false" aria-controls="cbIABPNFSection\${section.id}Body" aria-label="\${section.title}">
                            \${section.title}
                        </button>
                        \${toggleHtml}
                    </div>
                    <div class="cb-accordion-header-des">
                        <p>\${section.description || ''}</p>
                    </div>
                </div>
            </div>
            <div class="cb-accordion-body" id="cbIABPNFSection\${section.id}Body">
                \${section.items.map(item => \`
                    <div class="cb-child-accordion" id="cbIABPNFSection\${item.id}">
                        <div class="cb-child-accordion-item">
                            <div class="cb-child-accordion-chevron">
                                <i class="cb-chevron-right"></i>
                            </div>
                            <div class="cb-child-accordion-header-wrapper">
                                <button class="cb-child-accordion-btn" aria-expanded="false" aria-controls="cbIABPNFSection\${item.id}Body" aria-label="\${item.title}">
                                    \${item.title}
                                </button>
                                \${(item.hasLegitimate || item.hasConsent) ? \`
                                    <div class="cb-switch-wrapper">
                                        \${item.hasLegitimate ? \`
                                            <div class="cb-legitimate-switch-wrapper \${item.hasConsent ? 'cb-switch-separator' : ''}">
                                                <div class="cb-switch-label">Legitimate Interest</div>
                                                <div class="cb-switch-sm">
                                                    <input type="checkbox" id="cbIABPNFSection\${item.id}ToggleLegitimate" aria-label="Disable \${item.title} Legitimate Interest" autocomplete="off" checked>
                                                </div>
                                            </div>
                                        \` : ''}
                                        \${item.hasConsent ? \`
                                            <div class="cb-consent-switch-wrapper">
                                                <div class="cb-switch-label">Consent</div>
                                                <div class="cb-switch-sm">
                                                    <input type="checkbox" id="cbIABPNFSection\${item.id}ToggleConsent" aria-label="Enable \${item.title} Consent" autocomplete="off">
                                                </div>
                                            </div>
                                        \` : ''}
                                    </div>
                                \` : ''}
                            </div>
                        </div>
                        <div class="cb-child-accordion-body" id="cbIABPNFSection\${item.id}Body">
                            <div class="cb-iab-ad-settings-details">
                                <p class="cb-iab-ad-settings-details-des">\${item.description}</p>
                                \${item.illustrations ? \`
                                    <div class="cb-iab-illustrations">
                                        <p class="cb-iab-illustrations-title">Illustrations</p>
                                        <ul class="cb-iab-illustrations-des">
                                            \${item.illustrations.map(ill => \`<li>\${ill}</li>\`).join('')}
                                        </ul>
                                    </div>
                                \` : ''}
                                <p class="cb-iab-vendors-count-wrapper">Number of Vendors seeking consent: \${item.vendorCount}</p>
                            </div>
                        </div>
                    </div>
                \`).join('')}
            </div>
        \`;
        
        container.appendChild(accordion);
    });
}

// Fetch and display vendors

// async function  loadVendors() {
//     const loading = document.getElementById('vendorsLoading');
//     const vendorsList = document.getElementById('vendorsList');
//     const searchInput = document.getElementById('vendorsSearch');
    
//     try {
//         const response = await fetch('https://ancient-wind-15ae.narendra-3c5.workers.dev/gvl/vendor-list.json');
//         const data = await response.json();
        
//         loading.style.display = 'none';
//         vendorsList.style.display = 'block';
        
//         if (data.vendors && Object.keys(data.vendors).length > 0) {
//             const vendorsArray = Object.values(data.vendors);
//             let allVendors = [];
            
//             vendorsArray.forEach((vendor, index) => {
//                 const vendorId = Object.keys(data.vendors)[Object.values(data.vendors).indexOf(vendor)];
//                 const uniqueId = \`consentBitVendorSection_\${vendorId}\`;
                
//                 const vendorItem = document.createElement('div');
//                 vendorItem.className = 'consentBit-vendor-item';
//                 vendorItem.dataset.vendorId = vendorId;
//                 vendorItem.dataset.vendorName = vendor.name.toLowerCase();
//              console.log("check data-sharkid")
//                 vendorItem.innerHTML = \`
//                     <div class="consentBit-vendor-header">
//                         <div class="consentBit-vendor-info">
//                             <div class="consentBit-vendor-name">\${vendor.name}</div>
//                             <div class="consentBit-vendor-id">ID: \${vendorId}</div>
//                         </div>
//                         <div class="consentBit-switch-wrapper">
//                             <div class="consentBit-consent-switch-wrapper">
//                                 <div class="consentBit-switch-label">Consent</div>
//                                 <div class="cky-switch-sm">
//                                     <input type="checkbox" 
//                                            id="\${uniqueId}ToggleConsent" 
//                                            aria-label="Disable \${vendor.name} Consent" 
//                                            autocomplete="off" 
//                                            data-sharkid="__\${vendorId}">
//                                 </div>
//                             </div>
//                         </div>
//                     </div>
//                 \`;
                
//                 allVendors.push(vendorItem);
//             });
            
//             vendorsList.vendorsData = allVendors;
//             vendorsList.innerHTML = '';
//             vendorsList.append(...allVendors);
//             if (window.vendorPreferences) {
//   Object.entries(window.vendorPreferences).forEach(([vendorId, data]) => {
//     const checkbox = document.querySelector(\`input[data-sharkid="\${vendorId}"]\`);
    
//     console.log("Applying vendor preference:", checkbox, vendorId, data);
//     if (checkbox) {
//       checkbox.checked = data.consent;
//     }
//   });
// }
//             initVendorSearch(vendorsList, searchInput);
            
//         } else {
//             vendorsList.innerHTML = '<p class="consentBit-empty-vendors-text">No vendors to display.</p>';
//         }
//     } catch (error) {
//         console.error('Error loading vendors:', error);
//         loading.textContent = 'Failed to load vendors. Please try again.';
//     }
// }
// async function loadVendors() {
//     const loading = document.getElementById('vendorsLoading');
//     const vendorsList = document.getElementById('vendorsList');
//     const searchInput = document.getElementById('vendorsSearch');
    
//     try {
//         const response = await fetch('https://ancient-wind-15ae.narendra-3c5.workers.dev/gvl/vendor-list.json');
//         const data = await response.json();
        
//         loading.style.display = 'none';
//         vendorsList.style.display = 'block';
        
//         if (data.vendors && Object.keys(data.vendors).length > 0) {
//             const vendorsArray = Object.values(data.vendors);
//             let allVendors = [];
            
//             vendorsArray.forEach((vendor) => {
//                 const vendorId = Object.keys(data.vendors)[Object.values(data.vendors).indexOf(vendor)];
//                 const uniqueId = \`consentBitVendorSection_\${vendorId}\`;
                
//                 const vendorItem = document.createElement('div');
//                 vendorItem.className = 'consentBit-vendor-item';
//                 vendorItem.dataset.vendorId = vendorId;
//                 vendorItem.dataset.vendorName = vendor.name.toLowerCase();

//                 const header = document.createElement('div');
//                 header.className = 'consentBit-vendor-header';

//                 const info = document.createElement('div');
//                 info.className = 'consentBit-vendor-info';

//                 const nameDiv = document.createElement('div');
//                 nameDiv.className = 'consentBit-vendor-name';
//                 nameDiv.textContent = vendor.name;

//                 const idDiv = document.createElement('div');
//                 idDiv.className = 'consentBit-vendor-id';
//                 idDiv.textContent = \`ID: \${vendorId}\`;

//                 info.appendChild(nameDiv);
//                 info.appendChild(idDiv);
//                 const switchWrapper = document.createElement('div');
//                 switchWrapper.className = 'consentBit-switch-wrapper';

//                 const consentWrapper = document.createElement('div');
//                 consentWrapper.className = 'consentBit-consent-switch-wrapper';

//                 const label = document.createElement('div');
//                 label.className = 'consentBit-switch-label';
//                 label.textContent = 'Consent';

//                 const switchSm = document.createElement('div');
//                 switchSm.className = 'cky-switch-sm';

//                 // Create checkbox manually (important fix)
//                 const checkbox = document.createElement('input');
//                 checkbox.type = 'checkbox';
//                 checkbox.id = \`\${uniqueId}ToggleConsent\`;
//                 checkbox.setAttribute('aria-label', \`Disable \${vendor.name} Consent\`);
//                 checkbox.setAttribute('autocomplete', 'off');
//                 checkbox.setAttribute('data-sharkid', \`__\${vendorId}\`);

//                 switchSm.appendChild(checkbox);
//                 consentWrapper.appendChild(label);
//                 consentWrapper.appendChild(switchSm);
//                 switchWrapper.appendChild(consentWrapper);

//                 header.appendChild(info);
//                 header.appendChild(switchWrapper);

//                 vendorItem.appendChild(header);

//                 allVendors.push(vendorItem);
//             });
            
//             vendorsList.vendorsData = allVendors;
//             vendorsList.innerHTML = '';
//             vendorsList.append(...allVendors);
//              if (window.vendorPreferences) {
//                         Object.entries(window.vendorPreferences).forEach(([vendorId, data]) => {
//                                const checkbox = document.querySelector(\`input[data-sharkid="\${vendorId}"]\`);
//                          console.log(checkbox,data)
//                                 if (checkbox) {
//                                     checkbox.checked = data.consent;
//                                 }
//                             });
//                         }
//             initVendorSearch(vendorsList, searchInput);

//         } else {
//             vendorsList.innerHTML = '<p class="consentBit-empty-vendors-text">No vendors to display.</p>';
//         }
//     } catch (error) {
//         console.error('Error loading vendors:', error);
//         loading.textContent = 'Failed to load vendors. Please try again.';
//     }
// }

// TCF Appendix A standard data category names (used when the GVL JSON in use
// doesn't expose dataCategories — the bundled GVL loader strips this field).
const TCF_DATA_CATEGORIES = {
    1:  { name: 'IP addresses',
          description: 'Your IP address is a number assigned by your Internet Service Provider to any Internet connection. It is used to route information on the Internet and display online content (including ads) on your connected device.' },
    2:  { name: 'Device characteristics',
          description: 'Technical characteristics about the device you are using that are not unique to you, such as the language, the time zone or the operating system.' },
    3:  { name: 'Device identifiers',
          description: 'A unique string of characters assigned to your device or browser by means of a cookie or other storage technologies, used to recognise your device across sites or apps.' },
    4:  { name: 'Probabilistic identifiers',
          description: 'An identifier created by combining device characteristics (browser, OS) and the IP address. Probabilistic because several devices can share the same characteristics and Internet connection.' },
    5:  { name: 'Authentication-derived identifiers',
          description: 'An identifier created from authentication data — such as contact details associated with online accounts (email, phone number) or customer identifiers — used to recognise you across websites, apps and devices when logged in.' },
    6:  { name: 'Browsing and interaction data',
          description: 'Your online activity such as the websites you visit, apps you use, content you search for, or interactions with content or ads (e.g. number of times you have seen an ad or whether you clicked on it).' },
    7:  { name: 'User-provided data',
          description: 'Information provided via a form (feedback, comments) or when creating an account (age, occupation, etc.).' },
    8:  { name: 'Non-precise location data',
          description: 'An approximation of your location, expressed as an area with a radius of at least 500 metres. Can be deduced from e.g. the IP address of your connection.' },
    9:  { name: 'Precise location data',
          description: 'Your precise location within a radius of less than 500 metres based on GPS coordinates. May be used only with your acceptance.' },
    10: { name: "Users' profiles",
          description: 'Characteristics (interests, purchase intentions, consumer profile) inferred or modelled from your previous online activity or information you have provided.' },
    11: { name: 'Privacy choices',
          description: 'Your preferences regarding the processing of your data, based on the information you have received.' }
};

function getGvlMaps() {
    const gvl = window.tcfManager && window.tcfManager.gvl;
    const gvlDataCategories = (gvl && gvl.dataCategories) || {};
    const dataCategories = Object.keys(gvlDataCategories).length > 0
        ? gvlDataCategories
        : TCF_DATA_CATEGORIES;
    return {
        purposes: (gvl && gvl.purposes) || {},
        specialPurposes: (gvl && gvl.specialPurposes) || {},
        features: (gvl && gvl.features) || {},
        specialFeatures: (gvl && gvl.specialFeatures) || {},
        dataCategories: dataCategories
    };
}

// GVL v3 stores per-language vendor URLs in a \`urls\` array
// ([{ langId, privacy, legIntClaim }, ...]). Older GVL revisions used flat
// \`policyUrl\` / \`legIntClaim\` fields. Pick the user's language if available,
// otherwise the first entry, then fall back to the flat fields.
function pickVendorUrls(vendor) {
    if (!vendor) return {};
    const lang = ((window.tcfManager && window.tcfManager.config && window.tcfManager.config.consentLanguage) || 'en').toLowerCase();
    let entry = null;
    if (Array.isArray(vendor.urls) && vendor.urls.length) {
        entry = vendor.urls.find((u) => u && u.langId && String(u.langId).toLowerCase() === lang) || vendor.urls[0];
    }
    return {
        privacy: (entry && entry.privacy) || vendor.policyUrl || '',
        legIntClaim: (entry && entry.legIntClaim) || vendor.legIntClaim || ''
    };
}

function lookupNames(map, ids) {
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => {
        const entry = map[String(id)];
        return entry && entry.name ? entry.name : \`#\${id}\`;
    });
}

function buildDataCategoryList(map, ids) {
    if (!Array.isArray(ids) || !ids.length) {
        return '<span class="consentBit-vendor-empty">None declared</span>';
    }
    const items = ids.map((id) => {
        const entry = map[String(id)] || {};
        const name = entry.name ? String(entry.name) : \`Data category \${id}\`;
        const description = entry.description ? String(entry.description) : '';
        return \`<details class="consentBit-data-cat">
            <summary>\${escapeHtml(name)}</summary>
            \${description ? \`<p>\${escapeHtml(description)}</p>\` : ''}
        </details>\`;
    });
    return \`<div class="consentBit-data-cat-list">\${items.join('')}</div>\`;
}

function formatDuration(seconds) {
    if (seconds === undefined || seconds === null) return null;
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return 'Session-only';
    if (n === 0) return 'Session-only';
    const days = Math.round(n / 86400);
    if (days >= 365) {
        const years = (days / 365).toFixed(1).replace(/\\.0$/, '');
        return \`\${years} year\${years === '1' ? '' : 's'}\`;
    }
    if (days >= 1) return \`\${days} day\${days === 1 ? '' : 's'}\`;
    const hours = Math.round(n / 3600);
    if (hours >= 1) return \`\${hours} hour\${hours === 1 ? '' : 's'}\`;
    return \`\${n} second\${n === 1 ? '' : 's'}\`;
}

function buildTagList(items) {
    if (!items || !items.length) return '<span class="consentBit-vendor-empty">None declared</span>';
    return \`<ul class="consentBit-vendor-tag-list">\${items.map((t) => \`<li>\${escapeHtml(String(t))}</li>\`).join('')}</ul>\`;
}

function buildSection(title, body) {
    return \`<div class="consentBit-vendor-section"><span class="consentBit-vendor-section-title">\${escapeHtml(title)}</span>\${body}</div>\`;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function buildPerPurposeRetention(vendor, purposesMap) {
    const dr = vendor && vendor.dataRetention;
    if (!dr || !dr.purposes || !Object.keys(dr.purposes).length) return '';
    const rows = Object.entries(dr.purposes).map(([pid, days]) => {
        const name = purposesMap[String(pid)] && purposesMap[String(pid)].name ? purposesMap[String(pid)].name : \`Purpose \${pid}\`;
        const dayLabel = \`\${days} day\${Number(days) === 1 ? '' : 's'}\`;
        return \`<li><strong>\${escapeHtml(name)}</strong><span>\${escapeHtml(dayLabel)}</span></li>\`;
    });
    return \`<ul class="consentBit-vendor-retention">\${rows.join('')}</ul>\`;
}

async function loadVendors() {
    const loading = document.getElementById('vendorsLoading');
    const vendorsList = document.getElementById('vendorsList');
    const searchInput = document.getElementById('vendorsSearch');

    try {
        await waitForTCF();

        const vendors = window.tcfManager.getVendors();
        const maps = getGvlMaps();

        loading.style.display = 'none';
        vendorsList.style.display = 'block';

        if (!vendors || Object.keys(vendors).length === 0) {
            vendorsList.innerHTML = '<p class="consentBit-empty-vendors-text">No vendors to display.</p>';
            return;
        }

        const allVendors = [];

        Object.entries(vendors).forEach(([vendorId, vendor]) => {
            if (!vendor || vendor.deletedDate) return;

            const uniqueId = \`consentBitVendorSection_\${vendorId}\`;
            const supportsConsent = (vendor.purposes && vendor.purposes.length) || (vendor.flexiblePurposes && vendor.flexiblePurposes.length);
            const supportsLI = (vendor.legIntPurposes && vendor.legIntPurposes.length) || (vendor.flexiblePurposes && vendor.flexiblePurposes.length);

            const vendorItem = document.createElement('div');
            vendorItem.className = 'consentBit-vendor-item';
            vendorItem.dataset.vendorId = vendorId;
            vendorItem.dataset.vendorName = (vendor.name || '').toLowerCase();

            const consentPurposes = lookupNames(maps.purposes, vendor.purposes);
            const liPurposes = lookupNames(maps.purposes, vendor.legIntPurposes);
            const flexPurposes = lookupNames(maps.purposes, vendor.flexiblePurposes);
            const specialPurposes = lookupNames(maps.specialPurposes, vendor.specialPurposes);
            const featureNames = lookupNames(maps.features, vendor.features);
            const specialFeatureNames = lookupNames(maps.specialFeatures, vendor.specialFeatures);
            const dataCategoryIds = Array.isArray(vendor.dataDeclaration) ? vendor.dataDeclaration : [];
            const stdRetention = vendor.dataRetention && vendor.dataRetention.stdRetention;
            const cookieMaxAge = formatDuration(vendor.cookieMaxAgeSeconds);
            const cookieRefresh = vendor.cookieRefresh === true ? 'Yes' : 'No';
            const usesCookies = vendor.usesCookies === true ? 'Yes' : 'No';
            const usesNonCookieAccess = vendor.usesNonCookieAccess === true ? 'Yes' : 'No';
            const vendorUrls = pickVendorUrls(vendor);
            const policyUrl = vendorUrls.privacy || '';
            const legIntClaimUrl = vendorUrls.legIntClaim || '';

            vendorItem.innerHTML = \`
                <div class="consentBit-vendor-header">
                    <div class="consentBit-vendor-info">
                        <div class="consentBit-vendor-name">\${escapeHtml(vendor.name || 'Unknown vendor')}</div>
                        <div class="consentBit-vendor-id">ID: \${escapeHtml(String(vendorId))}</div>
                    </div>
                    <div class="consentBit-switch-wrapper">
                        \${supportsLI ? \`
                            <div class="consentBit-li-switch-wrapper cb-switch-separator">
                                <div class="consentBit-switch-label">Legitimate Interest</div>
                                <div class="cb-switch-sm">
                                    <input type="checkbox"
                                           id="\${uniqueId}ToggleLI"
                                           aria-label="Object to \${escapeHtml(vendor.name || '')} processing on legitimate interest"
                                           autocomplete="off"
                                           data-sharkid-li="__\${vendorId}"
                                           checked>
                                </div>
                            </div>
                        \` : ''}
                        \${supportsConsent ? \`
                            <div class="consentBit-consent-switch-wrapper">
                                <div class="consentBit-switch-label">Consent</div>
                                <div class="cb-switch-sm">
                                    <input type="checkbox"
                                           id="\${uniqueId}ToggleConsent"
                                           aria-label="Enable \${escapeHtml(vendor.name || '')} consent"
                                           autocomplete="off"
                                           data-sharkid="__\${vendorId}">
                                </div>
                            </div>
                        \` : ''}
                    </div>
                </div>
                <button type="button" class="consentBit-vendor-expand" aria-expanded="false" aria-controls="\${uniqueId}Details">Show details ▾</button>
                <div class="consentBit-vendor-details" id="\${uniqueId}Details">
                    \${(policyUrl || (legIntClaimUrl && supportsLI)) ? \`<div class="consentBit-vendor-section consentBit-vendor-section-first"><div class="consentBit-vendor-inline-links">
                        \${policyUrl ? \`<a href="\${escapeHtml(policyUrl)}" target="_blank" rel="noopener noreferrer">Privacy policy</a>\` : ''}
                        \${legIntClaimUrl && supportsLI ? \`<a href="\${escapeHtml(legIntClaimUrl)}" target="_blank" rel="noopener noreferrer">Legitimate interest claim</a>\` : ''}
                    </div></div>\` : ''}
                    \${buildSection('Purposes (consent required)', buildTagList(consentPurposes))}
                    \${buildSection('Purposes (legitimate interest)', buildTagList(liPurposes))}
                    \${flexPurposes.length ? buildSection('Flexible purposes', buildTagList(flexPurposes)) : ''}
                    \${buildSection('Special purposes', buildTagList(specialPurposes))}
                    \${buildSection('Features', buildTagList(featureNames))}
                    \${buildSection('Special features', buildTagList(specialFeatureNames))}
                    \${buildSection('Categories of data collected', buildDataCategoryList(maps.dataCategories, dataCategoryIds))}
                    \${buildSection('Storage & retention', \`
                        <dl class="consentBit-vendor-meta">
                            <div class="consentBit-vendor-meta-row"><dt>Uses cookies</dt><dd>\${usesCookies}</dd></div>
                            <div class="consentBit-vendor-meta-row"><dt>Cookie max duration</dt><dd>\${escapeHtml(cookieMaxAge || 'Not declared')}</dd></div>
                            <div class="consentBit-vendor-meta-row"><dt>Cookie refreshed</dt><dd>\${cookieRefresh}</dd></div>
                            <div class="consentBit-vendor-meta-row"><dt>Uses non-cookie storage</dt><dd>\${usesNonCookieAccess}</dd></div>
                            <div class="consentBit-vendor-meta-row"><dt>Standard retention</dt><dd>\${escapeHtml(stdRetention !== undefined && stdRetention !== null ? \`\${stdRetention} day\${Number(stdRetention) === 1 ? '' : 's'}\` : 'Not declared')}</dd></div>
                        </dl>
                    \`)}
                    \${buildPerPurposeRetention(vendor, maps.purposes) ? buildSection('Retention by purpose', buildPerPurposeRetention(vendor, maps.purposes)) : ''}
                    \${supportsLI ? \`<div class="consentBit-vendor-section"><p class="consentBit-vendor-object-note"><strong>Right to object:</strong> Toggle "Legitimate Interest" off above to object to this vendor processing your personal data on the legal basis of legitimate interest.</p></div>\` : ''}
                </div>
            \`;

            allVendors.push(vendorItem);
        });

        vendorsList.vendorsData = allVendors;
        vendorsList.innerHTML = '';
        vendorsList.append(...allVendors);

        if (window.vendorPreferences) {
            Object.entries(window.vendorPreferences).forEach(([vendorId, data]) => {
                const consentCb = document.querySelector(\`input[data-sharkid="\${vendorId}"]\`);
                if (consentCb && data && data.consent !== undefined) consentCb.checked = !!data.consent;
                const liCb = document.querySelector(\`input[data-sharkid-li="\${vendorId}"]\`);
                if (liCb && data && data.legitimateInterest !== undefined) liCb.checked = !!data.legitimateInterest;
            });
        }

        vendorsList.addEventListener('click', (e) => {
            const btn = e.target.closest('.consentBit-vendor-expand');
            if (!btn) return;
            const details = document.getElementById(btn.getAttribute('aria-controls'));
            if (!details) return;
            const open = details.classList.toggle('is-open');
            btn.setAttribute('aria-expanded', String(open));
            btn.textContent = open ? 'Hide details ▴' : 'Show details ▾';
        }, { once: false });

        initVendorSearch(vendorsList, searchInput);
    } catch (error) {
        console.error('Error loading vendors:', error);
        if (loading) loading.textContent = 'Failed to load vendors. Please try again.';
    }
}
// Search function remains the same
function initVendorSearch(vendorsList, searchInput) {
    if (!searchInput) return;
    
    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase().trim();
        const allVendors = vendorsList.vendorsData || [];
        
        allVendors.forEach(vendorItem => {
            const vendorName = vendorItem.dataset.vendorName;
            const vendorId = vendorItem.dataset.vendorId;
            
            if (searchTerm === '' || 
                vendorName.includes(searchTerm) || 
                vendorId.includes(searchTerm)) {
                vendorItem.style.display = 'block';
                vendorItem.classList.remove('consentBit-hidden');
            } else {
                vendorItem.style.display = 'none';
                vendorItem.classList.add('consentBit-hidden');
            }
        });
        
        updateNoResultsMessage(vendorsList, searchTerm, allVendors);
    });
}

function updateNoResultsMessage(vendorsList, searchTerm, allVendors) {
    const visibleCount = allVendors.filter(v => 
        v.style.display !== 'none' && !v.classList.contains('consentBit-hidden')
    ).length;
    
    let noResultsMsg = vendorsList.querySelector('.consentBit-no-results');
    if (visibleCount === 0 && searchTerm !== '') {
        if (!noResultsMsg) {
            noResultsMsg = document.createElement('div');
            noResultsMsg.className = 'consentBit-no-results';
            noResultsMsg.innerHTML = \`
                <p>No vendors found for "\${searchTerm}"</p>
                <small>Try searching by vendor name or ID</small>
            \`;
            vendorsList.prepend(noResultsMsg);
        }
    } else if (noResultsMsg) {
        noResultsMsg.remove();
    }
}

// Load existing preferences into UI
function loadExistingPreferences() {
    if (!window.tcfManager) {
        console.warn('TCF Manager not initialized yet');
        return;
    }

    const preferences = window.tcfManager.loadStoredConsent();
    if (!preferences) {
        // console.log('[ConsentBit][LoadPrefs] ℹ️ No stored consent — first-time visitor, scripts remain blocked');
        return;
    }

    // console.log('[ConsentBit][LoadPrefs] 📂 Stored consent found:', JSON.stringify(preferences.cookieCategories || {}));

    // Load cookie categories
    if (preferences.cookieCategories) {
        Object.entries(preferences.cookieCategories).forEach(([categoryId, data]) => {
            const checkbox = document.getElementById(\`cbSwitch\${categoryId}\`);
            if (checkbox && !checkbox.disabled) {
                checkbox.checked = data.enabled;
            }
        });
    }

    // Load purposes
    if (preferences.purposes) {
        Object.entries(preferences.purposes).forEach(([purposeId, data]) => {
            const consentCheckbox = document.getElementById(\`cbIABPNFSection\${purposeId}ToggleConsent\`);
            const legitimateCheckbox = document.getElementById(\`cbIABPNFSection\${purposeId}ToggleLegitimate\`);
            
            if (consentCheckbox && data.consent !== undefined) {
                consentCheckbox.checked = data.consent;
            }
            
            if (legitimateCheckbox && data.legitimate !== undefined) {
                legitimateCheckbox.checked = data.legitimate;
            }
        });
    }

    // Load special features
    if (preferences.specialFeatures) {
        Object.entries(preferences.specialFeatures).forEach(([featureId, data]) => {
            const checkbox = document.getElementById(\`cbIABPNFSection\${featureId}ToggleConsent\`);
            if (checkbox && data.consent !== undefined) {
                checkbox.checked = data.consent;
            }
        });
    }

// Restore in-memory consent state for this page session
window.__cbConsentState = {
  categories: {
    analytics:     !!(preferences.cookieCategories && preferences.cookieCategories.analytics     && preferences.cookieCategories.analytics.enabled),
    functional:    !!(preferences.cookieCategories && preferences.cookieCategories.functional    && preferences.cookieCategories.functional.enabled),
    performance:   !!(preferences.cookieCategories && preferences.cookieCategories.performance   && preferences.cookieCategories.performance.enabled),
    advertisement: !!(preferences.cookieCategories && preferences.cookieCategories.advertisement && preferences.cookieCategories.advertisement.enabled),
  }
};
// console.log('[ConsentBit][LoadPrefs] __cbConsentState restored:', JSON.stringify(window.__cbConsentState));

// Returning visitor: replay their stored decision to Clarity. Deduped, so this is a
// no-op when the install-time signal above already sent the same values.
cbClarityConsent({
  analytics: !!(preferences.cookieCategories && preferences.cookieCategories.analytics && preferences.cookieCategories.analytics.enabled),
  marketing: !!(preferences.cookieCategories && preferences.cookieCategories.advertisement && preferences.cookieCategories.advertisement.enabled)
});

// Release scripts whose categories are now consented to (CDN-style)
releaseBlockedScripts();
    // Load vendors (will be loaded when vendor tab is opened)
    // Store vendor preferences for later
    window.vendorPreferences = preferences.vendors || {};
// console.log(preferences.vendors)
 if (window.vendorPreferences) {
                        Object.entries(window.vendorPreferences).forEach(([vendorId, data]) => {
                               const checkbox = document.querySelector(\`input[data-sharkid="\${vendorId}"]\`);
                         // console.log(checkbox,data)
                                if (checkbox) {
                                    checkbox.checked = data.consent;
                                }
                            });
                        }

  // Consent was previously given — suppress the banner on reload.
  hideBanner();
}

// Tab switching
function initTabs() {
    const tabs = document.querySelectorAll('.cb-iab-nav-item');
    const sections = document.querySelectorAll('.cb-preference-body-wrapper');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;
            
            tabs.forEach(t => t.classList.remove('cb-iab-nav-item-active'));
            tab.classList.add('cb-iab-nav-item-active');
            
            sections.forEach(section => section.classList.remove('active'));
            
            if (targetTab === 'cookie') {
                document.getElementById('cbIABSectionCookie').classList.add('active');
            } else if (targetTab === 'purpose') {
                document.getElementById('cbIABSectionPurpose').classList.add('active');
            } else if (targetTab === 'vendor') {
                document.getElementById('cbIABSectionVendor').classList.add('active');
                // if (document.getElementById('vendorsList').children.length === 0) {
                //     loadVendors().then(() => {
                //         // Apply vendor preferences after vendors are loaded
                //         if (window.vendorPreferences) {
                //             Object.entries(window.vendorPreferences).forEach(([vendorId, data]) => {
                //                 const checkbox = document.querySelector(\`input[data-sharkid="\${vendorId}"]\`);
                //                 if (checkbox) {
                //                     checkbox.checked = data.consent;
                //                 }
                //             });
                //         }

 
                  
                        // Apply vendor preferences after vendors are loaded
                      
            }
        });
    });
}

// Accordion functionality
function initAccordions() {
    document.addEventListener('click', (e) => {
        const accordionItem = e.target.closest('.cb-accordion-item, .cb-accordion-iab-item');
        if (accordionItem && !e.target.closest('input, .cb-switch')) {
            const accordion = accordionItem.closest('.cb-accordion');
            accordion.classList.toggle('active');
            
            const btn = accordionItem.querySelector('.cb-accordion-btn');
            if (btn) {
                const isExpanded = accordion.classList.contains('active');
                btn.setAttribute('aria-expanded', isExpanded);
            }
        }
        
        const childAccordionItem = e.target.closest('.cb-child-accordion-item');
        if (childAccordionItem && !e.target.closest('input, .cb-switch, .cb-switch-wrapper')) {
            const childAccordion = childAccordionItem.closest('.cb-child-accordion');
            childAccordion.classList.toggle('active');
            
            const btn = childAccordionItem.querySelector('.cb-child-accordion-btn');
            if (btn) {
                const isExpanded = childAccordion.classList.contains('active');
                btn.setAttribute('aria-expanded', isExpanded);
            }
        }
    });
}

// Button handlers
function initButtons() {
    document.getElementById('cbCloseBtn').addEventListener('click', closeModal);
    document.getElementById('cbRejectBtn').addEventListener('click', rejectAll);
  document.querySelector('.consentBit-btn-reject').addEventListener('click', rejectAll);
    document.getElementById('cbSaveBtn').addEventListener('click', savePreferences);
    document.getElementById('cbAcceptBtn').addEventListener('click', acceptAll);
  document.querySelector('.consentBit-btn-accept').addEventListener('click', acceptAll);

  const customizeBtn = document.querySelector(".consentBit-btn-customize");
    const modal = document.querySelector(".cb-modal");
const modal2 = document.querySelector(".consentBit-consent-container");
    if (customizeBtn && modal) {
      customizeBtn.addEventListener("click", function () {
       // modal.style.setProperty("display", "flex", "important");
          openModal();
       modal2.style.display = "none";
      });
    }

    const vendorsLink = document.getElementById("consentBitVendorsLink");
    if (vendorsLink && modal) {
      vendorsLink.addEventListener("click", function (e) {
        e.preventDefault();
        openModal();
        switchToTab('vendor');
        if (modal2) modal2.style.display = "none";
      });
    }
}

function switchToTab(targetTab) {
  const tabs = document.querySelectorAll('.cb-iab-nav-item');
  const sections = document.querySelectorAll('.cb-preference-body-wrapper');
  tabs.forEach(t => {
    if (t.dataset.tab === targetTab) t.classList.add('cb-iab-nav-item-active');
    else t.classList.remove('cb-iab-nav-item-active');
  });
  sections.forEach(s => s.classList.remove('active'));
  const sectionId = targetTab === 'cookie' ? 'cbIABSectionCookie'
                  : targetTab === 'purpose' ? 'cbIABSectionPurpose'
                  : 'cbIABSectionVendor';
  const section = document.getElementById(sectionId);
  if (section) section.classList.add('active');
}

function closeModal() {
    document.getElementById('cbPreferenceModal').classList.add('cb-modal-hidden');
}
function openModal() {
    document.getElementById('cbPreferenceModal').classList.remove('cb-modal-hidden');
}
// Record IAB/TCF consent to the backend. The external TCF manager (Tcfmanager.js)
// only writes to localStorage + gtag + fires TCF events; it never POSTs, so without
// this the IAB banner creates no Consent row. status: 'given' (accept) |
// 'rejected' (reject) | 'partial' (save preferences). Mirrors the standard loader re().
function cbRecordIabConsent(status, categories) {
  // Signal Clarity first: this is the single funnel every accept / reject / save passes
  // through, and it must not depend on the backend POST below (which returns early when
  // the site is unconfigured).
  cbClarityConsent(categories);
  try {
    var cfg = (typeof window !== 'undefined' && window.__CONSENT_SITE__) || {};
    var siteId = cfg.id || null;
    var apiBase = cfg.apiBase;
    if (!siteId || !apiBase) return;

    var tcf = {};
    try {
      if (window.tcfManager && typeof window.tcfManager.getTCData === 'function') {
        var d = window.tcfManager.getTCData();
        tcf = {
          version: 2,
          cmpId: d && d.cmpId,
          cmpVersion: d && d.cmpVersion,
          consentScreen: 1,
          publisherCc: d && d.publisherCC,
          purposesConsent: d && d.purpose && d.purpose.consents,
          purposesLI: d && d.purpose && d.purpose.legitimateInterests,
          specialFeatures: d && d.specialFeatureOptins,
          vendorsConsent: d && d.vendor && d.vendor.consents,
          vendorsLI: d && d.vendor && d.vendor.legitimateInterests
        };
      }
    } catch (e) {}

    var body = {
      siteId: siteId,
      regulation: 'gdpr',
      // Persist IAB/TCF consent as a plain GDPR record, not as bannerType 'iab'.
      bannerType: 'gdpr',
      consentMethod: status === 'partial' ? 'preferences' : 'banner',
      status: status,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      consent: {
        accepted: status !== 'rejected',
        timestamp: new Date().toISOString(),
        categories: categories || { essential: true, analytics: false, marketing: false, preferences: false }
      },
      tcf: tcf
    };

    fetch(apiBase + '/api/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(function () {});
  } catch (e) {}
}

async function rejectAll() {
  // console.log('[ConsentBit][RejectAll] 🚫 User rejected all — blocking all non-essential scripts');
  if (!window.tcfManager) { return; }
  await window.tcfManager.rejectAll();
  window.__cbConsentState = { allDenied: true };
  // console.log('[ConsentBit][RejectAll] __cbConsentState set:', window.__cbConsentState);
  cbRecordIabConsent('rejected', { essential: true, analytics: false, marketing: false, preferences: false });
  blockNonEssentialScripts();

    const wrapper = document.querySelector('.main-iab-wrapper');
  if (wrapper) {
    wrapper.querySelectorAll('input[type="checkbox"]:not([disabled])')
      .forEach(cb => cb.checked = false);
  }
  hideBanner();
  
  closeModal();
}

async function savePreferences() {
    if (!window.tcfManager) {
      
        return;
    }

    const preferences = {
        cookieCategories: {},
        purposes: {},
        vendors: {},
        specialFeatures: {}
    };

    // Collect cookie categories
    document.querySelectorAll('input[id^="cbSwitch"]:not([id*="IAB"])').forEach(checkbox => {
        const categoryId = checkbox.id.replace('cbSwitch', '');
        preferences.cookieCategories[categoryId] = {
            enabled: checkbox.checked,
            alwaysActive: checkbox.disabled
        };
    });

    // Collect purpose items
    document.querySelectorAll('input[id$="ToggleLegitimate"], input[id$="ToggleConsent"]').forEach(checkbox => {
        const match = checkbox.id.match(/cbIABPNFSection([^T]+)Toggle(Legitimate|Consent)/);
        if (match) {
            const itemId = match[1];
            const type = match[2].toLowerCase();
            preferences.purposes[itemId] = preferences.purposes[itemId] || {};
            preferences.purposes[itemId][type] = checkbox.checked;
        }
    });

    // Collect special features
    purposesData.forEach(section => {
        if (section.id === 'special-features') {
            section.items.forEach(item => {
                const consentCheckbox = document.getElementById(\`cbIABPNFSection\${item.id}ToggleConsent\`);
                if (consentCheckbox) {
                    preferences.specialFeatures[item.id] = {
                        consent: consentCheckbox.checked
                    };
                }
            });
        }
    });

    // Collect vendors (consent + legitimate interest)
    document.querySelectorAll('input[data-sharkid]').forEach(checkbox => {
        const vendorId = checkbox.getAttribute('data-sharkid');
        if (vendorId) {
            preferences.vendors[vendorId] = preferences.vendors[vendorId] || {};
            preferences.vendors[vendorId].consent = checkbox.checked;
        }
    });
    document.querySelectorAll('input[data-sharkid-li]').forEach(checkbox => {
        const vendorId = checkbox.getAttribute('data-sharkid-li');
        if (vendorId) {
            preferences.vendors[vendorId] = preferences.vendors[vendorId] || {};
            preferences.vendors[vendorId].legitimateInterest = checkbox.checked;
        }
    });
 
    // Save through TCF Manager
    await window.tcfManager.saveConsent(preferences);

    // Set in-memory state so isCategoryAllowed reads it immediately
    window.__cbConsentState = {
      categories: {
        analytics:     !!(preferences.cookieCategories.analytics     && preferences.cookieCategories.analytics.enabled),
        functional:    !!(preferences.cookieCategories.functional    && preferences.cookieCategories.functional.enabled),
        performance:   !!(preferences.cookieCategories.performance   && preferences.cookieCategories.performance.enabled),
        advertisement: !!(preferences.cookieCategories.advertisement && preferences.cookieCategories.advertisement.enabled),
      }
    };
    // console.log('[ConsentBit][SavePrefs] 💾 Preferences saved — __cbConsentState:', JSON.stringify(window.__cbConsentState));
    // console.log('[ConsentBit][SavePrefs] cookieCategories:', JSON.stringify(preferences.cookieCategories));

    cbRecordIabConsent('partial', {
      essential: true,
      analytics:    !!(preferences.cookieCategories.analytics     && preferences.cookieCategories.analytics.enabled),
      marketing:    !!(preferences.cookieCategories.advertisement && preferences.cookieCategories.advertisement.enabled),
      preferences:  !!(preferences.cookieCategories.functional    && preferences.cookieCategories.functional.enabled)
    });

    // Re-block any scripts whose category was just denied, then release those now allowed
    blockNonEssentialScripts();
    releaseBlockedScripts();
   
    closeModal();
}

async function acceptAll() {
  // console.log('[ConsentBit][AcceptAll] ✅ User accepted all — releasing all blocked scripts');
  if (!window.tcfManager) {  return; }
  await window.tcfManager.acceptAll();
  window.__cbConsentState = { allGranted: true };
  // console.log('[ConsentBit][AcceptAll] __cbConsentState set:', window.__cbConsentState);
  cbRecordIabConsent('given', { essential: true, analytics: true, marketing: true, preferences: true });
  releaseBlockedScripts();
 const wrapper = document.querySelector('.main-iab-wrapper');
  if (wrapper) {
    wrapper.querySelectorAll('input[type="checkbox"]:not([disabled])')
      .forEach(cb => cb.checked = true);
  }
  hideBanner();
 
  closeModal();
}
function injectFloatingTrigger() {
  if (document.getElementById('cb-floating-trigger')) return; // prevent duplicates

  const btn = document.createElement('button');
  btn.id = 'cb-floating-trigger';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Cookie Preferences');
  btn.style.cssText = [
    'position: fixed',
    'bottom: 16px',
    'left: 16px',
    'z-index: 99999',
    'width: 40px',
    'height: 40px',
    'border: 1px solid rgb(226, 232, 240)',
    'border-radius: 9999px',
    'background: rgb(255, 255, 255)',
    'cursor: pointer',
    'padding: 0',
    'box-shadow: rgba(15, 23, 42, 0.12) 0px 4px 14px'
  ].join(';');

  const img = document.createElement('img');
  img.alt = '';
  img.src = 'https://consent-webapp-manager.web-8fb.workers.dev/embed/floating-logo.svg';
  img.width = 28;
  img.height = 28;
  img.draggable = false;
  img.style.cssText = 'display:block;width:28px;height:28px;object-fit:contain;margin:auto;pointer-events:none';

  btn.appendChild(img);
  document.body.appendChild(btn);

  btn.addEventListener('click', () => {
    // If the consent banner is currently visible, ignore the floating trigger —
    // user must dismiss the banner first. Only after the banner is hidden does
    // the floating trigger open the preference modal.
    const banner = document.getElementById('consentBitBanner');
    if (banner && getComputedStyle(banner).display !== 'none') return;
    openModal();
    // If the banner was hidden, keep it hidden — only open the preference modal
  });
}
// Initialize everything on load
// document.addEventListener('DOMContentLoaded', async() => {
//     initCookieAccordions();
//     initPurposeAccordions();
//     initTabs();
//     initAccordions();
//     initButtons();
//  await loadVendors();
    
//     // Wait for TCF Manager to initialize, then load preferences
//     const waitForTCFManager = setInterval(() => {
//         if (window.tcfManager && window.tcfManager.isInitialized) {
//             clearInterval(waitForTCFManager);
//             loadExistingPreferences();
//         }
//     }, 100);
// });

function initGroupToggles() {
  if (window.__cbGroupTogglesInstalled) return;
  window.__cbGroupTogglesInstalled = true;
  // Map: section toggle id → child consent checkbox selector pattern
  const groups = [
    {
      sectionId: 'purposes',
      toggleId: 'cbIABPNFSectionpurposesToggle',
      childSelector: '[id^="cbIABPNFSectionpurpose"][id$="ToggleConsent"]:not([id="cbIABPNFSectionpurposesToggle"])'
    },
    {
      sectionId: 'special-features',
      toggleId: 'cbIABPNFSectionspecial-featuresToggle',
      childSelector: '[id^="cbIABPNFSectionspecial-feature"][id$="ToggleConsent"]:not([id="cbIABPNFSectionspecial-featuresToggle"])'
    }
  ];

  groups.forEach(({ toggleId, childSelector }) => {
    const groupToggle = document.getElementById(toggleId);
    if (!groupToggle) return;

    const getChildren = () => Array.from(document.querySelectorAll(childSelector));

    // Sync group toggle state from children
    function syncGroupToggle() {
      const children = getChildren();
      if (!children.length) return;
      groupToggle.checked = children.every(cb => cb.checked);
    }

    // When group toggle changes → update all children
    groupToggle.addEventListener('change', () => {
      getChildren().forEach(cb => { cb.checked = groupToggle.checked; });
    });

    // When any child changes → re-evaluate group toggle
    document.addEventListener('change', (e) => {
      const children = getChildren();
      if (children.includes(e.target)) syncGroupToggle();
    });

    // Initial sync after DOM is ready
    syncGroupToggle();
  });
}
async function initAll() {
    injectStyles();
    if (!ensureConsentUiShell()) return;
    // Hide banner immediately if consent was already stored — avoids visible flash
    // while waiting for tcfManager to initialize (~100 ms poll in waitForTCFManager).
    try {
      if (localStorage.getItem('cookieConsentPrefs')) {
        hideBanner();
      }
    } catch(e) {}
    blockNonEssentialScripts();
    initCookieAccordions();
    initPurposeAccordions();
    initTabs();
    initAccordions();
    initButtons();
    injectFloatingTrigger();
    await loadVendors();

    const waitForTCFManager = setInterval(() => {
        if (window.tcfManager && window.tcfManager.isInitialized) {
            clearInterval(waitForTCFManager);
            rebuildPurposeAccordionsFromGvl();
            initGroupToggles();
            loadExistingPreferences();
            updateDynamicCounts();
        }
    }, 100);
}

function updateDynamicCounts() {
    const gvl = window.tcfManager && window.tcfManager.gvl;
    if (!gvl) return;

    // 1st-layer vendor count (#12) — when the AC layer is active, fold the Google
    // additional partners (ATP) into the disclosed total so they're surfaced here.
    const vendorCount = gvl.vendors ? Object.keys(gvl.vendors).length : 0;
    const countEl = document.getElementById('consentBitVendorCountText');
    if (countEl && vendorCount > 0) {
        const atpCount = (window.__cbIsGAC && Array.isArray(window.__cbAtpProviders)) ? window.__cbAtpProviders.length : 0;
        countEl.textContent = atpCount > 0
            ? \`\${vendorCount + atpCount} third-party partners (\${vendorCount} IAB + \${atpCount} Google)\`
            : \`\${vendorCount} third-party partner\${vendorCount === 1 ? '' : 's'}\`;
    }

    // 1st-layer purpose names (#7) — pull verbatim from GVL
    const purposeNames = Object.values(gvl.purposes || {})
        .map((p) => p && p.name)
        .filter(Boolean);
    const purposesEl = document.getElementById('consentBitPurposesText');
    if (purposesEl && purposeNames.length) {
        purposesEl.textContent = purposeNames.join(', ');
    }

    // 1st-layer special features (#7)
    const sfNames = Object.values(gvl.specialFeatures || {})
        .map((sf) => sf && sf.name)
        .filter(Boolean);
    const sfEl = document.getElementById('consentBitSpecialFeaturesText');
    if (sfEl && sfNames.length) {
        sfEl.textContent = sfNames.join(', ');
    }

    // 2nd-layer per-purpose vendor counts (#25)
    const purposeMap = gvl.purposes || {};
    Object.keys(purposeMap).forEach((pid) => {
        const consentVendors = typeof gvl.getVendorsWithConsentPurpose === 'function' ? gvl.getVendorsWithConsentPurpose(Number(pid)) : null;
        const liVendors = typeof gvl.getVendorsWithLegIntPurpose === 'function' ? gvl.getVendorsWithLegIntPurpose(Number(pid)) : null;
        const consentCount = consentVendors ? Object.keys(consentVendors).length : 0;
        const liCount = liVendors ? Object.keys(liVendors).length : 0;
        const total = consentCount + liCount;
        document.querySelectorAll(\`#cbIABPNFSectionpurpose\${pid}Body .cb-iab-vendors-count-wrapper\`).forEach((el) => {
            el.textContent = \`Number of Vendors seeking consent: \${consentCount} • Relying on legitimate interest: \${liCount} • Total: \${total}\`;
        });
    });

    const sfMap = gvl.specialFeatures || {};
    Object.keys(sfMap).forEach((fid) => {
        const sfVendors = typeof gvl.getVendorsWithSpecialFeature === 'function' ? gvl.getVendorsWithSpecialFeature(Number(fid)) : null;
        const count = sfVendors ? Object.keys(sfVendors).length : 0;
        document.querySelectorAll(\`#cbIABPNFSectionspecial-feature\${fid}Body .cb-iab-vendors-count-wrapper\`).forEach((el) => {
            el.textContent = \`Number of Vendors seeking consent: \${count}\`;
        });
    });

    const featMap = gvl.features || {};
    Object.keys(featMap).forEach((fid) => {
        const fVendors = typeof gvl.getVendorsWithFeature === 'function' ? gvl.getVendorsWithFeature(Number(fid)) : null;
        const count = fVendors ? Object.keys(fVendors).length : 0;
        document.querySelectorAll(\`#cbIABPNFSectionfeature\${fid}Body .cb-iab-vendors-count-wrapper\`).forEach((el) => {
            el.textContent = \`Number of Vendors using this feature: \${count}\`;
        });
    });

    const spMap = gvl.specialPurposes || {};
    Object.keys(spMap).forEach((pid) => {
        const spVendors = typeof gvl.getVendorsWithSpecialPurpose === 'function' ? gvl.getVendorsWithSpecialPurpose(Number(pid)) : null;
        const count = spVendors ? Object.keys(spVendors).length : 0;
        document.querySelectorAll(\`#cbIABPNFSectionspecialPurpose\${pid}Body .cb-iab-vendors-count-wrapper\`).forEach((el) => {
            el.textContent = \`Number of Vendors using this special purpose: \${count}\`;
        });
    });
}

function rebuildPurposeAccordionsFromGvl() {
    const gvl = window.tcfManager && window.tcfManager.gvl;
    const container = document.getElementById('purposeAccordions');
    if (!gvl || !container) return;

    const purposes = gvl.purposes || {};
    const specialPurposes = gvl.specialPurposes || {};
    const features = gvl.features || {};
    const specialFeatures = gvl.specialFeatures || {};

    const sortedKeys = (m) => Object.keys(m || {}).map((k) => Number(k)).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);

    const purposeIds = sortedKeys(purposes);
    const specialPurposeIds = sortedKeys(specialPurposes);
    const featureIds = sortedKeys(features);
    const specialFeatureIds = sortedKeys(specialFeatures);

    const countConsentVendors = (id) => {
        const v = typeof gvl.getVendorsWithConsentPurpose === 'function' ? gvl.getVendorsWithConsentPurpose(id) : null;
        return v ? Object.keys(v).length : 0;
    };
    const countLiVendors = (id) => {
        const v = typeof gvl.getVendorsWithLegIntPurpose === 'function' ? gvl.getVendorsWithLegIntPurpose(id) : null;
        return v ? Object.keys(v).length : 0;
    };
    const countSpVendors = (id) => {
        const v = typeof gvl.getVendorsWithSpecialPurpose === 'function' ? gvl.getVendorsWithSpecialPurpose(id) : null;
        return v ? Object.keys(v).length : 0;
    };
    const countFeatureVendors = (id) => {
        const v = typeof gvl.getVendorsWithFeature === 'function' ? gvl.getVendorsWithFeature(id) : null;
        return v ? Object.keys(v).length : 0;
    };
    const countSfVendors = (id) => {
        const v = typeof gvl.getVendorsWithSpecialFeature === 'function' ? gvl.getVendorsWithSpecialFeature(id) : null;
        return v ? Object.keys(v).length : 0;
    };

    const purposeSupportsLi = (id) => countLiVendors(id) > 0;

    const renderItem = (kind, id, item, opts) => {
        const consentCount = opts.consentCount || 0;
        const liCount = opts.liCount || 0;
        const showConsent = !!opts.showConsent;
        const showLi = !!opts.showLi;
        const idAttr = \`\${kind}\${id}\`;
        const name = escapeHtml(item.name || '');
        const description = escapeHtml(item.description || '');
        const illustrations = Array.isArray(item.illustrations) ? item.illustrations : [];
        const descLegal = item.descriptionLegal ? \`<p class="cb-iab-ad-settings-details-des" style="margin-top:8px;font-style:italic;opacity:.85">\${escapeHtml(item.descriptionLegal)}</p>\` : '';
        // TCF v2.4 / policy 5.0.b: Features must display the standard feature
        // explanation text alongside the name + full description. Read from the GVL
        // (standardTexts.features); fall back to the fixed standard string since the
        // bundled @iabtcf may not expose the new field.
        const FEATURE_STANDARD_TEXT = 'These means of processing can be used solely in pursuit of one or several purposes for which you are given a choice in this notice.';
        const featureStdHtml = (kind === 'feature')
            ? \`<p class="cb-iab-ad-settings-details-des" style="margin-top:8px;margin-bottom: 8px;">\${escapeHtml((gvl.standardTexts && gvl.standardTexts.features) || FEATURE_STANDARD_TEXT)}</p>\`
            : '';

        let toggles = '';
        if (showLi || showConsent) {
            toggles = \`<div class="cb-switch-wrapper">
                \${showLi ? \`<div class="cb-legitimate-switch-wrapper \${showConsent ? 'cb-switch-separator' : ''}">
                    <div class="cb-switch-label">Legitimate Interest</div>
                    <div class="cb-switch-sm">
                        <input type="checkbox" id="cbIABPNFSection\${idAttr}ToggleLegitimate" aria-label="Object to \${name} (legitimate interest)" autocomplete="off" checked>
                    </div>
                </div>\` : ''}
                \${showConsent ? \`<div class="cb-consent-switch-wrapper">
                    <div class="cb-switch-label">Consent</div>
                    <div class="cb-switch-sm">
                        <input type="checkbox" id="cbIABPNFSection\${idAttr}ToggleConsent" aria-label="Enable \${name} consent" autocomplete="off">
                    </div>
                </div>\` : ''}
            </div>\`;
        }

        let countLine = '';
        if (kind === 'purpose') {
            countLine = \`Number of Vendors seeking consent: \${consentCount} • Relying on legitimate interest: \${liCount} • Total: \${consentCount + liCount}\`;
        } else if (kind === 'special-feature') {
            countLine = \`Number of Vendors seeking consent: \${consentCount}\`;
        } else if (kind === 'specialPurpose') {
            countLine = \`Number of Vendors using this special purpose: \${consentCount}\`;
        } else if (kind === 'feature') {
            countLine = \`Number of Vendors using this feature: \${consentCount}\`;
        }

        return \`<div class="cb-child-accordion" id="cbIABPNFSection\${idAttr}">
            <div class="cb-child-accordion-item">
                <div class="cb-child-accordion-chevron"><i class="cb-chevron-right"></i></div>
                <div class="cb-child-accordion-header-wrapper">
                    <button class="cb-child-accordion-btn" aria-expanded="false" aria-controls="cbIABPNFSection\${idAttr}Body" aria-label="\${name}">\${name}</button>
                    \${toggles}
                </div>
            </div>
            <div class="cb-child-accordion-body" id="cbIABPNFSection\${idAttr}Body">
                <div class="cb-iab-ad-settings-details">
                    <p class="cb-iab-ad-settings-details-des">\${description}</p>
                    \${featureStdHtml}
                    \${illustrations.length ? \`<div class="cb-iab-illustrations">
                        <p class="cb-iab-illustrations-title">Illustrations</p>
                        <ul class="cb-iab-illustrations-des">
                            \${illustrations.map((ill) => \`<li>\${escapeHtml(ill)}</li>\`).join('')}
                        </ul>
                    </div>\` : ''}
                    \${descLegal}
                    <p class="cb-iab-vendors-count-wrapper">\${countLine}</p>
                </div>
            </div>
        </div>\`;
    };

    const renderSection = (sectionId, title, ids, kind, getItem, opts) => {
        if (!ids.length) return '';
        const sectionTitle = \`\${title} (\${ids.length})\`;
        const childrenHtml = ids.map((id) => {
            const item = getItem(id) || {};
            const showConsent = opts.showConsent ? opts.showConsent(id, item) : false;
            const showLi = opts.showLi ? opts.showLi(id, item) : false;
            const consentCount = opts.consentCount ? opts.consentCount(id, item) : 0;
            const liCount = opts.liCount ? opts.liCount(id, item) : 0;
            return renderItem(kind, id, item, { consentCount, liCount, showConsent, showLi });
        }).join('');
        const sectionToggle = opts.sectionToggle ? \`<div style="display:flex;align-items:center;gap:8px;">
            <div class="cb-switch-sm">
                <input type="checkbox" id="cbIABPNFSection\${sectionId}Toggle" aria-label="Enable all \${title}" autocomplete="off">
            </div>
        </div>\` : '';
        return \`<div class="cb-accordion" id="cbIABPNFSection\${sectionId}">
            <div class="cb-accordion-iab-item">
                <div class="cb-accordion-chevron"><i class="cb-chevron-right"></i></div>
                <div class="cb-accordion-header-wrapper">
                    <div class="cb-accordion-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
                        <button class="cb-accordion-btn" aria-expanded="false" aria-controls="cbIABPNFSection\${sectionId}Body" aria-label="\${title}">\${escapeHtml(sectionTitle)}</button>
                        \${sectionToggle}
                    </div>
                </div>
            </div>
            <div class="cb-accordion-body" id="cbIABPNFSection\${sectionId}Body">\${childrenHtml}</div>
        </div>\`;
    };

    const html = [
        renderSection('purposes', 'Purposes', purposeIds, 'purpose',
            (id) => purposes[String(id)],
            {
                sectionToggle: true,
                showConsent: () => true,
                showLi: (id) => purposeSupportsLi(id),
                consentCount: (id) => countConsentVendors(id),
                liCount: (id) => countLiVendors(id)
            }
        ),
        renderSection('special_purposes', 'Special Purposes', specialPurposeIds, 'specialPurpose',
            (id) => specialPurposes[String(id)],
            {
                showConsent: () => false,
                showLi: () => false,
                consentCount: (id) => countSpVendors(id)
            }
        ),
        renderSection('features', 'Features', featureIds, 'feature',
            (id) => features[String(id)],
            {
                showConsent: () => false,
                showLi: () => false,
                consentCount: (id) => countFeatureVendors(id)
            }
        ),
        renderSection('special-features', 'Special Features', specialFeatureIds, 'special-feature',
            (id) => specialFeatures[String(id)],
            {
                sectionToggle: true,
                showConsent: () => true,
                showLi: () => false,
                consentCount: (id) => countSfVendors(id)
            }
        )
    ].join('');

    container.innerHTML = html;
}

// ─── Google Additional Consent (AC) layer ────────────────────────────────────
// Fully gated on IS_GAC. When false, nothing here runs and the IAB flow is
// untouched. When true: fetch Google's ATP list, render an "Additional
// advertising partners" section in the Vendors tab, and build + store the AC
// string (addtl_consent) alongside the TCF string. Self-contained: it only adds
// DOM nodes and event listeners — it does not modify any existing function.
(function initGoogleAC() {
  if (!window.__cbIsGAC) return;

  var ATP_LIST_URL = 'https://ancient-wind-15ae.narendra-3c5.workers.dev/gac/atp-list.json';
  var AC_COOKIE = 'addtl_consent';
  var AC_LS_KEY = 'cb_addtl_consent';
  var atpProviders = [];

  function allIds() {
    return atpProviders.map(function (p) { return Number(p.id); }).filter(function (n) { return n > 0; });
  }

  function loadAtpProviders() {
    return fetch(ATP_LIST_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
      return r.json();
    }).then(function (data) {
      atpProviders = (data && data.providers) || [];
      window.__cbAtpProviders = atpProviders;
      return atpProviders;
    }).catch(function (e) {
      console.error('[ConsentBit][AC] Failed to load ATP list:', e);
      atpProviders = [];
      return [];
    });
  }

  function parseAcString(ac) {
    var set = {};
    if (!ac || typeof ac !== 'string') return set;
    var core = ac.split('~')[1] || '';
    core.split('.').forEach(function (id) {
      var n = Number(id);
      if (n > 0) set[n] = true;
    });
    return set;
  }

  function getStoredAc() {
    try {
      var ls = localStorage.getItem(AC_LS_KEY);
      if (ls) return ls;
    } catch (e) {}
    var m = document.cookie.match(/(?:^|;\\s*)addtl_consent=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function buildAcString(consentedIds) {
    var consentedSet = {};
    (consentedIds || []).forEach(function (id) { consentedSet[Number(id)] = true; });
    var consented = (consentedIds || []).map(Number).slice().sort(function (a, b) { return a - b; });
    // Part 5 (dv.) = disclosed MINUS consented — consented IDs must NOT appear in
    // the disclosed list (ACv2 spec, to keep the string short).
    var disclosed = allIds().filter(function (id) { return !consentedSet[id]; }).sort(function (a, b) { return a - b; });
    return '2~' + consented.join('.') + '~dv.' + disclosed.join('.');
  }

  function persistAc(consentedIds) {
    var ac = buildAcString(consentedIds);
    try { localStorage.setItem(AC_LS_KEY, ac); } catch (e) {}
    try {
      var expires = new Date(Date.now() + 365 * 864e5).toUTCString();
      document.cookie = AC_COOKIE + '=' + ac + '; expires=' + expires + '; path=/; SameSite=None; Secure';
    } catch (e) {}
    window.__cbAcString = ac;
    return ac;
  }

  function collectConsentedAtpIds() {
    var ids = [];
    document.querySelectorAll('input[data-atpid]').forEach(function (cb) {
      if (cb.checked) ids.push(Number(cb.getAttribute('data-atpid')));
    });
    return ids;
  }

  function setAllAtp(checked) {
    document.querySelectorAll('input[data-atpid]').forEach(function (cb) { cb.checked = checked; });
  }

  function applyStoredAtp() {
    var set = parseAcString(getStoredAc());
    document.querySelectorAll('input[data-atpid]').forEach(function (cb) {
      cb.checked = !!set[Number(cb.getAttribute('data-atpid'))];
    });
  }

  // Build the sub-tab switcher (IAB Vendors | Google Partners) inside the Vendors
  // tab and a dedicated #cbAtpList container, so the two lists are separate and
  // you don't have to scroll. Returns the ATP list container.
  function ensureVendorSubTabs() {
    var vendorsList = document.getElementById('vendorsList');
    if (!vendorsList) return null;
    var existing = document.getElementById('cbAtpList');
    if (existing) return existing;

    var wrapper = vendorsList.parentNode; // .consentBit-vendors-search-wrapper
    var textColor = (typeof styleConfig !== 'undefined' && styleConfig.textColor) || '#000000';
    var iabCount = (vendorsList.vendorsData && vendorsList.vendorsData.length) || vendorsList.children.length || 0;
    var gCount = atpProviders.length;

    function makePill(id, label) {
      var b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.textContent = label;
      b.style.cssText = 'padding:6px 2px;border:none;background:none;color:' + textColor + ';cursor:pointer;font-size:13px;font-weight:400;text-decoration:none;text-underline-offset:4px';
      return b;
    }
    var btnIab = makePill('cbSubTabIab', 'IAB Vendors (' + iabCount + ')');
    var btnG = makePill('cbSubTabGoogle', 'Google Partners (' + gCount + ')');

    var nav = document.createElement('div');
    nav.id = 'cbVendorSubNav';
    nav.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap';
    nav.appendChild(btnIab);
    nav.appendChild(btnG);

    var atpList = document.createElement('div');
    atpList.id = 'cbAtpList';
    atpList.className = 'consentBit-vendors-list';
    // Kept in flow (display:block) but content hidden — content-visibility:hidden
    // caches the rendered state so switching back is fast (unlike display:none,
    // which rebuilds the whole subtree each time).
    atpList.style.display = 'block';
    atpList.style.contentVisibility = 'hidden';

    wrapper.insertBefore(nav, wrapper.firstChild);
    vendorsList.parentNode.insertBefore(atpList, vendorsList.nextSibling);

    function setActive(which) {
      var iab = which === 'iab';
      // Toggle content-visibility (cached render state) instead of display:none
      // (full subtree teardown/rebuild) so switching large lists is instant.
      vendorsList.style.display = 'block';
      atpList.style.display = 'block';
      vendorsList.style.contentVisibility = iab ? 'visible' : 'hidden';
      atpList.style.contentVisibility = iab ? 'hidden' : 'visible';
      // Active tab: bold (700) + underline; inactive: 400, no underline. Size fixed 13px.
      btnIab.style.fontWeight = iab ? '700' : '400';
      btnIab.style.textDecoration = iab ? 'underline' : 'none';
      btnG.style.fontWeight = iab ? '400' : '700';
      btnG.style.textDecoration = iab ? 'none' : 'underline';
      window.__cbVendorSubTab = which;
    }
    btnIab.addEventListener('click', function () { setActive('iab'); });
    btnG.addEventListener('click', function () { setActive('google'); });
    setActive('iab');
    return atpList;
  }

  function renderAtpSection() {
    var list = document.getElementById('cbAtpList');
    if (!list) return;
    if (list.dataset.rendered === 'true') return;
    if (!atpProviders.length) return;

    var note = document.createElement('p');
    note.className = 'consentBit-scope-note';
    note.style.marginBottom = '12px';
    note.textContent = 'These Google-certified partners are not on the IAB vendor list. Choose whether they may use your data.';
    list.appendChild(note);

    atpProviders.forEach(function (p) {
      var displayName = p.name || ('Provider ' + p.id);

      // One card per provider — identical structure to the IAB vendor items.
      var item = document.createElement('div');
      item.className = 'consentBit-vendor-item';
      item.dataset.atpId = String(p.id);
      item.dataset.atpName = displayName.toLowerCase();

      var header = document.createElement('div');
      header.className = 'consentBit-vendor-header';

      var info = document.createElement('div');
      info.className = 'consentBit-vendor-info';
      var name = document.createElement('div');
      name.className = 'consentBit-vendor-name';
      name.textContent = displayName;
      var idd = document.createElement('div');
      idd.className = 'consentBit-vendor-id';
      idd.textContent = 'AC ID: ' + p.id;
      info.appendChild(name);
      info.appendChild(idd);

      var sw = document.createElement('div');
      sw.className = 'consentBit-switch-wrapper';
      var cw = document.createElement('div');
      cw.className = 'consentBit-consent-switch-wrapper';
      var lbl = document.createElement('div');
      lbl.className = 'consentBit-switch-label';
      lbl.textContent = 'Consent';
      var box = document.createElement('div');
      box.className = 'cb-switch-sm';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'cbAtpProvider_' + p.id + 'ToggleConsent';
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('data-atpid', String(p.id));
      input.setAttribute('aria-label', 'Enable ' + displayName + ' consent');
      box.appendChild(input);
      cw.appendChild(lbl);
      cw.appendChild(box);
      sw.appendChild(cw);

      header.appendChild(info);
      header.appendChild(sw);
      item.appendChild(header);

      // Privacy-policy link — name shown above, URL surfaced as a "Privacy policy" link.
      if (p.policyUrl) {
        var linkWrap = document.createElement('div');
        linkWrap.className = 'consentBit-vendor-inline-links';
        linkWrap.style.marginTop = '8px';
        var a = document.createElement('a');
        a.href = p.policyUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Privacy policy';
        linkWrap.appendChild(a);
        item.appendChild(linkWrap);
      }

      list.appendChild(item);
    });
    list.dataset.rendered = 'true';
  }

  // Filter the ATP sub-tab on the same search box (additive listener; the IAB
  // search keeps working on its own list).
  function wireAtpSearch() {
    var input = document.getElementById('vendorsSearch');
    var list = document.getElementById('cbAtpList');
    if (!input || !list) return;
    input.addEventListener('input', function (e) {
      var term = (e.target.value || '').toLowerCase().trim();
      Array.prototype.forEach.call(list.querySelectorAll('.consentBit-vendor-item'), function (item) {
        var nm = item.dataset.atpName || '';
        var id = item.dataset.atpId || '';
        item.style.display = (term === '' || nm.indexOf(term) !== -1 || id.indexOf(term) !== -1) ? 'block' : 'none';
      });
    });
  }

  function wireButtons() {
    var accept = document.getElementById('cbAcceptBtn');
    var reject = document.getElementById('cbRejectBtn');
    var save = document.getElementById('cbSaveBtn');
    var bannerAccept = document.querySelector('.consentBit-btn-accept');
    var bannerReject = document.querySelector('.consentBit-btn-reject');

    function onAccept() { setAllAtp(true); persistAc(allIds()); }
    function onReject() { setAllAtp(false); persistAc([]); }
    function onSave() { persistAc(collectConsentedAtpIds()); }

    if (accept) accept.addEventListener('click', onAccept);
    if (bannerAccept) bannerAccept.addEventListener('click', onAccept);
    if (reject) reject.addEventListener('click', onReject);
    if (bannerReject) bannerReject.addEventListener('click', onReject);
    if (save) save.addEventListener('click', onSave);
  }

  function boot() {
    loadAtpProviders().then(function () {
      var tries = 0;
      var iv = setInterval(function () {
        var vl = document.getElementById('vendorsList');
        var ready = vl && (vl.children.length > 0 || vl.style.display !== 'none');
        if (ready || tries > 150) {
          clearInterval(iv);
          ensureVendorSubTabs();
          renderAtpSection();
          applyStoredAtp();
          wireButtons();
          wireAtpSearch();
          // Refresh the first-layer partner count now the ATP list is loaded
          // (covers the case where updateDynamicCounts ran before the fetch).
          try { if (typeof updateDynamicCounts === 'function') updateDynamicCounts(); } catch (e) {}
        }
        tries++;
      }, 100);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

// ✅ Handle both cases
if (document.readyState === "loading") {
    // console.log('[ConsentBit] 🔄 DOM loading — waiting for DOMContentLoaded');
    document.addEventListener("DOMContentLoaded", initAll);
} else {
    // console.log('[ConsentBit] ⚡ DOM already loaded — running initAll immediately');
    initAll();
}
`;
}