// CRITICAL: Initialize consent mode IMMEDIATELY (before IIFE) to prevent blocking
// This ensures consent mode is set even if script loads asynchronously
(function() {
  // CRITICAL: Initialize dataLayer and gtag IMMEDIATELY (before any other code)
  window.dataLayer = window.dataLayer || [];
  if (typeof window.gtag === 'undefined') {
    window.gtag = function() { window.dataLayer.push(arguments); };
  }
  
  // CRITICAL: Set Consent Mode 'default' IMMEDIATELY (before any GA4/GTM scripts load)
  // This ensures GA4/GTM respect consent even if they load before DOMContentLoaded
window.gtag('consent', 'default', {
  'analytics_storage': 'granted',
  'ad_storage': 'denied',
  'ad_personalization': 'denied',
  'ad_user_data': 'denied',
  'personalization_storage': 'denied',
  'functionality_storage': 'granted',
  'security_storage': 'granted'
});

  gtag('event', 'page_view', {
    'page_type': 'landing_page',
    'traffic_source': 'organic'
  });

})();
  
  // Main consent management script (can load asynchronously)
  (function () {
    // Emergent: hide all consent banners from first paint (no banner on load for EU or US)
    var h = (typeof window !== 'undefined' && window.location && window.location.hostname) ? window.location.hostname.replace(/^www\./, '') : '';
    var isEmergentHost = !!(h && (h.indexOf('emergent-website.webflow.io') !== -1 || h.indexOf('emergent.tech') !== -1 || h.indexOf('emergent-website') !== -1));
    if (isEmergentHost) {
      try {
        var s = document.createElement('style');
        s.id = 'consentbit-emergent-hide-on-load';
        s.textContent = '#consentbit-container,#initial-consent-banner,#main-consent-banner,.consentbit-ccpa-banner-div,#consent-banner,#consent-us-banner{display:none!important;visibility:hidden!important;opacity:0!important}';
        (document.head || document.documentElement).appendChild(s);
      } catch (e) {}
    }

    // Ensure dataLayer and gtag are available (already initialized above, but ensure for safety)

    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag === 'undefined') {
      window.gtag = function() { window.dataLayer.push(arguments); };
    }
    
    // Create local gtag function for backward compatibility (used by updateGtagConsent)
    function gtag() { 
      window.dataLayer.push(arguments); 
    }
  
    const ENCRYPTION_KEY = "t95w6oAeL1hr0rrtCGKok/3GFNwxzfLxiWTETfZurpI=";
    const ENCRYPTION_IV = "yVSYDuWajEid8kDz";
    
    // Global location data storage (can be accessed from anywhere)
    window.locationData = null;
    let locationDetectionPromise = null; // Promise to prevent multiple simultaneous detections

    // --- Debug timings (disabled by default) ---
    // Enable with: localStorage.setItem('__cb_debug_timings__','1') then refresh
    // Or set: window.__CB_DEBUG_TIMINGS__ = true (before this script runs)
    // Debug timing logger removed (no console statements)
    function __cbTiming() {}
    function __cbNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  
  
    function setConsentCookie(name, value, days) {
      let expires = "";
      if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
      }
      let cookieString = name + "=" + value + expires + "; path=/; SameSite=Lax";
      if (location.protocol === 'https:') {
        cookieString += "; Secure";
      }
      document.cookie = cookieString;
    }
    function getConsentCookie(name) {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop().split(';').shift();
    }
    function removeDuplicateScripts() {
      const scripts = document.head.querySelectorAll('script[data-category]');
      const scriptMap = new Map();
      
      scripts.forEach(function(script) {
        const src = script.src;
        const dataCategory = script.getAttribute('data-category');
        const key = src + '|' + dataCategory;
        
                if (scriptMap.has(key)) {
            script.remove();
        } else {
          scriptMap.set(key, script);
        }
      });
    }
  
    // Global function to check if a script is a Google script
    function isGoogleScript(script) {
      if (!script) return false;
      
      // Check external scripts by src
      if (script.src) {
        return (
          script.src.includes('googletagmanager.com') ||
          script.src.includes('google-analytics.com') ||
          script.src.includes('googleapis.com') ||
          script.src.includes('gstatic.com') ||
          script.src.includes('gtag') ||
          script.src.includes('analytics.js') ||
          script.src.includes('ga.js') ||
          script.src.includes('google.com/recaptcha') ||
          script.src.includes('maps.googleapis.com')
        );
      }
      
      // Check inline scripts by content
      if (script.innerHTML) {
        const content = script.innerHTML.toLowerCase();
        return (
          content.includes('googletagmanager') ||
          content.includes('google-analytics') ||
          content.includes('gtag') ||
          content.includes('datalayer') ||
          content.includes('googleanalytics') ||
          // Check for GTM container ID pattern (e.g., GTM-P77CJZW, GTM-XXXXXXX)
          /gtm-?[a-z0-9]{6,}/i.test(script.innerHTML)
        );
      }
      
      // Check for GTM container ID in script attributes (id, data-gtm-id, etc.)
      if (script.id && /gtm-?[a-z0-9]{6,}/i.test(script.id)) {
        return true;
      }
      
      // Check data attributes for GTM
      for (let attr of script.attributes) {
        if (attr.name.toLowerCase().includes('gtm') || 
            (attr.value && /gtm-?[a-z0-9]{6,}/i.test(attr.value))) {
          return true;
        }
      }
      
      return false;
    }
  
    
    function unblockGoogleScripts() {
      // Find all Google scripts in head section
      const headScripts = document.head.querySelectorAll('script');
      headScripts.forEach(function(script) {
        if (isGoogleScript(script)) {
          // If Google script has type="text/plain", unblock it
          if (script.type === 'text/plain') {
            // CRITICAL: For both inline and external scripts, if they were initially blocked,
            // simply removing type="text/plain" won't work if the browser already parsed and skipped them.
            // We need to recreate the script to force execution/reload.
            
            if (script.innerHTML && !script.src) {
              // This is an inline script - recreate it to force execution
              const newScript = document.createElement('script');
              newScript.innerHTML = script.innerHTML;
              
              // Copy all attributes except type
              for (let attr of script.attributes) {
                if (attr.name !== 'type') {
                  newScript.setAttribute(attr.name, attr.value);
                }
              }
              
              // Insert new script and remove old one (forces execution)
              script.parentNode.insertBefore(newScript, script);
              script.remove();
              return; // Skip the rest since we replaced the script
            } else if (script.src) {
              // CRITICAL: For external scripts (especially with async/defer), if they were initially blocked,
              // the browser has already skipped loading them. We must recreate the script element to force reload.
              try {
                const newScript = document.createElement('script');
                
                // Copy all attributes except type
                for (let attr of script.attributes) {
                  if (attr.name !== 'type') {
                    newScript.setAttribute(attr.name, attr.value);
                  }
                }
                
                // Ensure proper type (or no type attribute for default)
                newScript.type = 'text/javascript';
                
                // Insert new script and remove old one (forces browser to load it)
                script.parentNode.insertBefore(newScript, script);
                script.remove();
                return; // Skip the rest since we replaced the script
              } catch (error) {
                // Fallback: just remove type attribute if recreation fails
                script.removeAttribute('type');
              }
            }
          }
          
          // No blocking attributes to remove - they're not used
          
          // DO NOT remove data-category attribute from Google scripts
          // Keep it as is - we just ignore it for blocking/unblocking purposes
          // Google scripts are controlled by Consent Mode, not by data-category blocking
        }
      });
    }
  
    function ensureGtagInitialization() {
      window.dataLayer = window.dataLayer || [];
      
      if (typeof window.gtag === 'undefined') {
        window.gtag = function() { 
          window.dataLayer.push(arguments); 
        };
      }
      
      const gtmScripts = document.head.querySelectorAll('script[src*="googletagmanager"]');
      if (gtmScripts.length > 0) {
        if (typeof window.gtag === 'function') {
          try {
            window.gtag('event', 'consent_scripts_enabled', {
              'event_category': 'consent',
              'event_label': 'scripts_re_enabled'
            });
            
            setTimeout(function() {
              try {
              
              } catch (e) {
              }
            }, 500);
          } catch (e) {
          }
        }
      }
      
      const analyticsScripts = document.head.querySelectorAll('script[src*="analytics"], script[src*="gtag"], script[src*="googletagmanager"]');
      if (analyticsScripts.length > 0) {
      }
    }
  
    function forceReloadAnalyticsScripts() {
      const analyticsScripts = document.head.querySelectorAll('script[src*="analytics"], script[src*="gtag"], script[src*="googletagmanager"], script[src*="google-analytics"]');
      
      analyticsScripts.forEach(function(script) {
        if (script.type === 'text/javascript' && script.src) {
          try {
            const newScript = document.createElement('script');
            
            for (let attr of script.attributes) {
              newScript.setAttribute(attr.name, attr.value);
            }
            
            newScript.type = 'text/javascript';
            
            newScript.onerror = function() {
            };
            newScript.onload = function() {
            };
            
            script.parentNode.insertBefore(newScript, script);
            script.remove();
          } catch (error) {
          }
        }
      });
    }
  
    function blockScriptsByCategory() {
      removeDuplicateScripts();
      
      // CRITICAL: First, ensure all Google scripts are unblocked
      unblockGoogleScripts();
      
      var scripts = document.head.querySelectorAll('script[data-category]');
      scripts.forEach(function (script) {
        // CRITICAL: Check if Google script FIRST - before any processing
        // This avoids any delay - Google scripts are NEVER blocked
        // They use Consent Mode, not category-based blocking
        if (isGoogleScript(script)) {
          // Don't do anything - just skip it completely
          // Google scripts should never be blocked, so no need to unblock them here
          return; // Exit immediately - no processing, no delay
        }
        
        // For NON-Google scripts: Check their category and block if needed
        var category = script.getAttribute('data-category');
        if (category) {
  
          var categories = category.split(',').map(function (cat) { return cat.trim(); });
  
          // Check if script has "necessary" or "essential" category (these should never be blocked)
          var hasEssentialCategory = categories.some(function (cat) {
            var lowercaseCat = cat.toLowerCase();
            return lowercaseCat === 'necessary' || lowercaseCat === 'essential';
          });
  
          // Block non-essential scripts by changing type to 'text/plain' (browser won't execute)
          if (!hasEssentialCategory) {
            script.type = 'text/plain';
          }
          // If hasEssentialCategory is true, script remains as 'text/javascript' and will execute
        }
      });
    }
    function enableAllScriptsWithDataCategory() {
      // CRITICAL: First, ensure all Google scripts are unblocked
      unblockGoogleScripts();
      
      // Enable all scripts with data-category attribute (including Google scripts)
      var scripts = document.head.querySelectorAll('script[data-category]');
      var blockedScripts = [];
      
      scripts.forEach(function (script) {
        // Skip Google scripts - they're already handled by unblockGoogleScripts()
        if (isGoogleScript(script)) {
          return; // Skip Google scripts
        }
        
        var isBlocked = script.type === 'text/plain' || 
                          false; // No blocking attributes to check
        
        if (isBlocked) {
          blockedScripts.push(script);
        }
      });
      
      blockedScripts.forEach(function (script) {
        if (script.src) {
          try {
            const existingScript = document.querySelector(`script[src="${script.src}"][type="text/javascript"]`);
            if (existingScript) {
              script.remove();
              return;
            }
            
            const newScript = document.createElement('script');
            
            for (let attr of script.attributes) {
              if (attr.name !== 'type' && 
                  attr.name !== 'type') {
                newScript.setAttribute(attr.name, attr.value);
              }
            }
            
            newScript.type = 'text/javascript';
            
            newScript.onerror = function() {
            };
            newScript.onload = function() {
              ensureGtagInitialization();
            };
            
            script.parentNode.insertBefore(newScript, script);
            script.remove();
          } catch (error) {
          }
        } else {
          script.type = 'text/javascript';
          
          if (script.innerHTML) {
            try {
              eval(script.innerHTML);
            } catch (e) {
            }
          }
        }
      });
      
     
      var allBlockedScripts = document.head.querySelectorAll('script[type="text/plain"]');
      allBlockedScripts.forEach(function (script) {
        // Google scripts are already handled by unblockGoogleScripts(), but unblock them here too for safety
        // Check if this is a Google script (should not have been blocked, but just in case)
        if (isGoogleScript(script)) {
          // Google scripts are already unblocked, but ensure they're not in the blocking list
          return;
        }
        // Unblock all scripts (including Google scripts)
        if (script.src) {
          // For external scripts, create new script element to force reload
          try {
            const existingScript = document.querySelector(`script[src="${script.src}"][type="text/javascript"]`);
            if (existingScript) {
              script.remove();
              return;
            }
            
            const newScript = document.createElement('script');
            for (let attr of script.attributes) {
              if (attr.name !== 'type' && 
                  attr.name !== 'type') {
                newScript.setAttribute(attr.name, attr.value);
              }
            }
            newScript.type = 'text/javascript';
            newScript.onload = function() {
              ensureGtagInitialization();
            };
            script.parentNode.insertBefore(newScript, script);
            script.remove();
          } catch (error) {
            // Fallback: just change type if creating new script fails
            script.type = 'text/javascript';
          }
        } else {
          // For inline scripts, just change type and remove attributes
          script.type = 'text/javascript';
          
          if (script.innerHTML) {
            try {
              eval(script.innerHTML);
            } catch (e) {
            }
          }
        }
      });
      
      removeDuplicateScripts();
      
      setTimeout(ensureGtagInitialization, 100);
    }
    function enableScriptsByCategories(allowedCategories) {
      // CRITICAL: First, ensure all Google scripts are unblocked
      unblockGoogleScripts();
      
      // Enable scripts based on categories (including Google scripts) in head section only
      var scripts = document.head.querySelectorAll('script[data-category]');
      var scriptsToEnable = [];
      
      scripts.forEach(function (script) {
        // Skip Google scripts - they're already handled by unblockGoogleScripts()
        if (isGoogleScript(script)) {
          return; // Skip Google scripts
        }
        var category = script.getAttribute('data-category');
        if (category) {
          var categories = category.split(',').map(function (cat) { return cat.trim().toLowerCase(); });
          var shouldEnable = categories.some(function (cat) {
            // Check for exact match or partial match (e.g., 'analytics' matches 'analytics_storage')
            return allowedCategories.some(function (allowedCat) {
              var allowedCatLower = allowedCat.toLowerCase();
              return cat === allowedCatLower || cat.includes(allowedCatLower) || allowedCatLower.includes(cat);
            });
          });
          
          if (shouldEnable) {
            // Check if script is blocked (either by type or attribute)
            var isBlocked = script.type === 'text/plain';
            
            if (isBlocked) {
              scriptsToEnable.push(script);
            }
          }
        }
      });
      
      scriptsToEnable.forEach(function (script) {
        // Re-execute the script if it has a src attribute
        if (script.src) {
          try {
            // Check if a script with this src already exists and is enabled
            const existingScript = document.querySelector(`script[src="${script.src}"][type="text/javascript"]`);
            if (existingScript) {
              // Just remove the blocked version
              script.remove();
              return;
            }
            
            // Create a new script element to force re-execution
            const newScript = document.createElement('script');
            
            // Copy all attributes except blocking ones
            for (let attr of script.attributes) {
              if (attr.name !== 'type' && 
                  attr.name !== 'type') {
                newScript.setAttribute(attr.name, attr.value);
              }
            }
            
            // Ensure proper type
            newScript.type = 'text/javascript';
            
            // Add error handling for script loading
            newScript.onerror = function() {
              // Script failed to load
            };
            newScript.onload = function() {
              // Script loaded successfully - ensure gtag is available
              ensureGtagInitialization();
            };
            
            // Insert the new script before the old one, then remove the old one
            script.parentNode.insertBefore(newScript, script);
            script.remove();
          } catch (error) {
            // Error re-executing script
          }
        } else {
          // For inline scripts, just change the type
          script.type = 'text/javascript';
          
          // Execute the script if it has inline content
          if (script.innerHTML) {
            try {
              eval(script.innerHTML);
            } catch (e) {
              // Error executing re-enabled script
            }
          }
        }
      });
      
      // Remove any duplicates that might have been created
      removeDuplicateScripts();
      
      // Ensure gtag is properly initialized after all scripts are loaded
      setTimeout(ensureGtagInitialization, 100);
    }
    function updateGtagConsent(preferences) {
      // Use window.gtag to ensure we're calling the actual Google gtag function
      if (typeof window.gtag === "function") {
        // Handle CCPA preferences (doNotShare/doNotSell) vs GDPR preferences (analytics/marketing/personalization)
        let analyticsStorage = 'denied';
        let adStorage = 'denied';
        let adPersonalization = 'denied';
        let adUserData = 'denied';
        let personalizationStorage = 'denied';
        
        if (preferences.hasOwnProperty('doNotShare') || preferences.hasOwnProperty('doNotSell')) {
          // CCPA mode: If doNotShare is false, grant all consent
          // If doNotShare is true, deny all consent
          const allowTracking = !preferences.doNotShare;
          analyticsStorage = allowTracking ? 'granted' : 'denied';
          adStorage = allowTracking ? 'granted' : 'denied';
          adPersonalization = allowTracking ? 'granted' : 'denied';
          adUserData = allowTracking ? 'granted' : 'denied';
          personalizationStorage = allowTracking ? 'granted' : 'denied';
        } else {
          // GDPR mode: Use individual category preferences
          analyticsStorage = preferences.analytics ? 'granted' : 'denied';
          adStorage = preferences.marketing ? 'granted' : 'denied';
          adPersonalization = preferences.marketing ? 'granted' : 'denied';
          adUserData = preferences.marketing ? 'granted' : 'denied';
          personalizationStorage = preferences.personalization ? 'granted' : 'denied';
        }
        
        window.gtag('consent', 'update', {
          'analytics_storage': analyticsStorage,
          'functionality_storage': 'granted',
          'ad_storage': adStorage,
          'ad_personalization': adPersonalization,
          'ad_user_data': adUserData,
          'personalization_storage': personalizationStorage,
          'security_storage': 'granted'
        });
        
        // CRITICAL: Trigger GA4 to start tracking after consent is granted
        // This ensures GA4 sends page views and events once consent is given
        if (analyticsStorage === 'granted') {
          // Small delay to ensure consent update is processed first
          setTimeout(function() {
            // Trigger page view event to ensure current page is tracked
            // GA4 will automatically use the measurement ID from the existing config
            if (typeof window.gtag === 'function') {
              try {
                window.gtag('event', 'page_view', {
                  'page_title': document.title,
                  'page_location': window.location.href,
                  'page_path': window.location.pathname + window.location.search
                });
              } catch (e) {
                // Silent error handling
              }
            }
          }, 100);
        }
      }
  
      // Push consent update event to dataLayer
      if (typeof window.dataLayer !== 'undefined') {
        window.dataLayer.push({
          'event': 'consent_update',
          'consent_analytics': preferences.analytics !== undefined ? preferences.analytics : (!preferences.doNotShare),
          'consent_marketing': preferences.marketing !== undefined ? preferences.marketing : (!preferences.doNotShare),
          'consent_personalization': preferences.personalization !== undefined ? preferences.personalization : (!preferences.doNotShare),
          'do_not_share': preferences.doNotShare !== undefined ? preferences.doNotShare : false
        });
      }
    }
    async function setConsentState(preferences, cookieDays) {showAppropriateBanner
      ['analytics', 'marketing', 'personalization'].forEach(function (category) {
        setConsentCookie(
          'cb-consent-' + category + '_storage',
          preferences[category] ? 'true' : 'false',
          cookieDays || 7
        );
      });
  
      // Save CCPA "do-not-share" preference if it exists
      if (preferences.hasOwnProperty('doNotShare')) {
        setConsentCookie(
          'cb-consent-donotshare',
          preferences.doNotShare ? 'true' : 'false',
          cookieDays || 7
        );
      }
  
      // Store encrypted preferences in localStorage
      await storeEncryptedPreferences(preferences);
  
      updateGtagConsent(preferences);
      const expiresAt = Date.now() + (cookieDays * 24 * 60 * 60 * 1000);
      localStorage.setItem('_cb_cea_', expiresAt.toString());
      localStorage.setItem('_cb_ced_', cookieDays.toString());
    }
    // Encrypt and store preferences in localStorage
    async function storeEncryptedPreferences(preferences) {
      try {
        const preferencesString = JSON.stringify(preferences);
        const encryptedData = await encryptWithHardcodedKey(preferencesString);
        localStorage.setItem('_cb_ecp_', encryptedData);
      } catch (error) {
        // Silent error handling
      }
    }
  
    // Decrypt and retrieve preferences from localStorage
    async function getDecryptedPreferences() {
      try {
        const encryptedData = localStorage.getItem('_cb_ecp_');
        if (!encryptedData) {
          return null;
        }
  
        // Decrypt the data
        const key = await importHardcodedKey();
        const iv = base64ToUint8Array(ENCRYPTION_IV);
        const encryptedBytes = base64ToUint8Array(encryptedData);
  
        const decryptedBuffer = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv },
          key,
          encryptedBytes
        );
  
        const decryptedString = new TextDecoder().decode(decryptedBuffer);
        return JSON.parse(decryptedString);
      } catch (error) {
        // Silent error handling
        return null;
      }
    }
  
    async function getConsentPreferences() {
      // Try to get from encrypted localStorage first
      const encryptedPrefs = await getDecryptedPreferences();
      if (encryptedPrefs) {
        return encryptedPrefs;
      }
  
      // Fallback to cookies for backward compatibility
      return {
        analytics: getConsentCookie('_cb_cas_') === 'true',
        marketing: getConsentCookie('_cb_cms_') === 'true',
        personalization: getConsentCookie('_cb_cps_') === 'true',
        doNotShare: getConsentCookie('cb-consent-donotshare') === 'true'  // Convert to camelCase for consistency
      };
    }
    function showBanner(banner) {
      if (banner) {
__cbTiming('showBanner:start', { id: banner.id || null, className: banner.className || null });
        banner.style.setProperty("display", "block", "important");
        banner.style.setProperty("visibility", "visible", "important");
        banner.style.setProperty("opacity", "1", "important");
        banner.classList.add("show-banner");
        banner.classList.remove("hidden");
        __cbTiming('showBanner:styled', { id: banner.id || null });

        // Confirm "visible" after paint
        try {
          requestAnimationFrame(function () {
            requestAnimationFrame(function () {
              try {
                const el = banner.id ? document.getElementById(banner.id) : banner;
                if (!el) return;
                const cs = window.getComputedStyle(el);
                __cbTiming('showBanner:painted', {
                  id: el.id || null,
                  display: cs.display,
                  visibility: cs.visibility,
                  opacity: cs.opacity
                });
              } catch (e) {}
            });
          });
        } catch (e) {}
        
        // Disable scroll only if banner has data-cookie-banner="true" and scroll-control is enabled
        const scrollControl = document.querySelector('[scroll-control="true"]');
        if (scrollControl) {
          // Check the banner element directly - if it has an ID, re-query from DOM to ensure latest state
          let bannerToCheck = banner;
          if (banner.id) {
            const domBanner = document.getElementById(banner.id);
            if (domBanner) {
              bannerToCheck = domBanner;
            }
          }
          
          // Check if banner has data-cookie-banner="true" attribute
          if (bannerToCheck.hasAttribute('data-cookie-banner') && 
              bannerToCheck.getAttribute('data-cookie-banner') === 'true') {
            document.body.style.overflow = "hidden";
          }
        }
      }
    }
    async function hideBanner(banner) {
      if (banner) {
        banner.style.setProperty("display", "none", "important");
        banner.style.setProperty("visibility", "hidden", "important");
        banner.style.setProperty("opacity", "0", "important");
        banner.classList.remove("show-banner");
        banner.classList.add("hidden");
        
        // Re-enable scroll only if banner with data-cookie-banner="true" is hidden
        const scrollControl = document.querySelector('[scroll-control="true"]');
        if (scrollControl) {
          // Check the banner element directly - if it has an ID, re-query from DOM to ensure latest state
          let bannerToCheck = banner;
          if (banner.id) {
            const domBanner = document.getElementById(banner.id);
            if (domBanner) {
              bannerToCheck = domBanner;
            }
          }
          
          if (bannerToCheck.hasAttribute('data-cookie-banner') && bannerToCheck.getAttribute('data-cookie-banner') === 'true') {
            // Check if any banner with data-cookie-banner="true" is still visible
            const cookieBanners = document.querySelectorAll('[data-cookie-banner="true"]');
            let anyVisible = false;
            
            cookieBanners.forEach(function(cookieBanner) {
              const style = window.getComputedStyle(cookieBanner);
              if (style.display !== "none" && 
                  style.visibility !== "hidden" &&
                  style.opacity !== "0") {
                anyVisible = true;
              }
            });
            
            if (!anyVisible) {
              document.body.style.overflow = "";
            }
          }
        }
      }
    }
    async function hideAllBanners() {
      await hideBanner(document.getElementById("cb-initial-banner"));
      await hideBanner(document.getElementById("cb-preferences-banner"));
    }

    function getVisibleBanner() {
      var bannerIds = ["cb-initial-banner", "cb-preferences-banner"];
      for (var i = 0; i < bannerIds.length; i++) {
        var el = document.getElementById(bannerIds[i]);
        if (el) {
          var s = window.getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') return el;
        }
      }
      return null;
    }
  
  
    function base64ToUint8Array(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }
  
    function uint8ArrayToBase64(bytes) {
      return btoa(String.fromCharCode(...bytes));
    }
  
    async function importHardcodedKey() {
      const keyBytes = base64ToUint8Array(ENCRYPTION_KEY);
      return crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"]
      );
    }
  
    async function encryptWithHardcodedKey(data) {
      try {
        const key = await importHardcodedKey();
        const iv = base64ToUint8Array(ENCRYPTION_IV);
        const encoder = new TextEncoder();
        const encryptedBuffer = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          key,
          encoder.encode(data)
        );
        return uint8ArrayToBase64(new Uint8Array(encryptedBuffer));
      } catch (error) {
        throw error;
      }
    }
  
  
    function isTokenExpired(token) {
      if (!token) return true;
      const parts = token.split('.');
      const payloadBase64 = parts[1]; // index 1 = payload (index 0 = header)
      if (!payloadBase64) return true;
      try {
        const payload = JSON.parse(atob(payloadBase64));
        if (!payload.exp) return true;
        return payload.exp < Math.floor(Date.now() / 1000);
      } catch {
        return true;
      }
    }
    async function getOrCreateVisitorId() {
      let visitorId = localStorage.getItem('_cb_vid_');
      if (!visitorId) {
        visitorId = crypto.randomUUID();
        localStorage.setItem('_cb_vid_', visitorId);
      }
      return visitorId;
    }
    function getSiteNameForToken(hostname) {
      return hostname.replace(/^www\./, '');
    }
  
  
    function clearVisitorSession() {
      localStorage.removeItem('_cb_vid_');
      localStorage.removeItem('_cb_vst_');
      localStorage.removeItem('_cb_cg_');
      localStorage.removeItem('_cb_cea_');
      localStorage.removeItem('_cb_ced_');
      localStorage.removeItem('_cb_rtc_');
    }
  
  
    let tokenRequestInProgress = false;
    async function getVisitorSessionToken() {
      try {
        // Check retry count - maximum 5 requests
        const retryCount = parseInt(localStorage.getItem('_cb_rtc_') || '0', 10);
        if (retryCount >= 5) {
          return null; // Stop after 5 attempts
        }
  
        if (tokenRequestInProgress) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const existingToken = localStorage.getItem('_cb_vst_');
          if (existingToken && !isTokenExpired(existingToken)) {
            // Reset retry count on successful token retrieval
            localStorage.removeItem('_cb_rtc_');
            return existingToken;
          }
        }
    
        const existingToken = localStorage.getItem('_cb_vst_');
        if (existingToken && !isTokenExpired(existingToken)) {
          // Reset retry count on successful token retrieval
          localStorage.removeItem('_cb_rtc_');
          return existingToken;
        }
    
        tokenRequestInProgress = true;
        
        // Increment retry count before making request
        localStorage.setItem('_cb_rtc_', (retryCount + 1).toString());
    
        const visitorId = await getOrCreateVisitorId();
        const siteName = getSiteNameForToken(window.location.hostname);
    
        const response = await fetch('https://app.consentbit.com/api/visitor-token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            visitorId: visitorId,
            siteName: siteName,
            useFullSiteName: true
          })
        });
    
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          
          // If response has retry: false, don't retry
          if (errorData.retry === false) {
            return null; // Stop here, don't retry
          }
    
          // Only retry on 500 errors if retry is not false and retry count is less than 5
          if (response.status === 500 && errorData.retry !== false && retryCount < 4) {
            clearVisitorSession();
            const newVisitorId = await getOrCreateVisitorId();
            const retryResponse = await fetch('https://app.consentbit.com/api/visitor-token', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                visitorId: newVisitorId,
                siteName: siteName,
                useFullSiteName: true
              })
            });
    
            if (!retryResponse.ok) {
              const retryErrorData = await retryResponse.json().catch(() => ({}));
              
              // Check retry response too
              if (retryErrorData.retry === false) {
                return null; // Stop retrying
              }
              
              throw new Error(`Retry failed after clearing session: ${retryResponse.status}`);
            }
    
            const retryData = await retryResponse.json();
            localStorage.setItem('_cb_vst_', retryData.token);
            // Reset retry count on success
            localStorage.removeItem('_cb_rtc_');
            return retryData.token;
          }
    
          throw new Error(`Failed to get visitor session token: ${response.status}`);
        }
    
        const data = await response.json();
        localStorage.setItem('_cb_vst_', data.token);
        // Reset retry count on success
        localStorage.removeItem('_cb_rtc_');
        return data.token;
    
      } catch (error) {
        return null;
      } finally {
        tokenRequestInProgress = false;
      }
    }
  
   async function fetchCookieExpirationDays() {
  try {
    // For webapp-migrated sites: read expires from data-config on the script tag (no API call needed)
    const scriptEl = document.querySelector('script[data-config]');
    if (scriptEl) {
      try {
        const raw = scriptEl.getAttribute('data-config');
        const decoded = raw
          .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const cfg = JSON.parse(decoded);
        if (cfg && cfg.settings && cfg.settings.expires != null) {
          return parseInt(cfg.settings.expires, 10) || 180;
        }
      } catch {}
    }
    // Legacy non-migrated sites: fall back to API
    const siteName = window.location.hostname.replace(/^www\./, '').split('.')[0];
    const apiUrl = `https://app.consentbit.com/api/app-data?siteName=${encodeURIComponent(siteName)}`;
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) return 180;
    const data = await response.json();
    if (data && data.cookieExpiration != null) {
      return parseInt(data.cookieExpiration, 10);
    }
    return 180;
  } catch {
    return 180;
  }
}
  
  
  
  
      let country = null;
    
    // CLIENT-SIDE DETECTION REMOVED - Using server-side only
    
    // Show CCPA banner
    function showCCPABanner() {
      hideBanner(document.getElementById("cb-preferences-banner"));
      showBanner(document.getElementById("cb-initial-banner"));
    }

    // Show GDPR banner
    function showGDPRBanner() {
hideBanner(document.getElementById("cb-preferences-banner"));
      showBanner(document.getElementById("cb-initial-banner"));
    }
    
    // Helper function to check if hostname is emergent or sungreen
    function isEmergentOrSungreen() {
      const hostname = window.location.hostname.replace(/^www\./, '');
      return hostname === 'sungreensystems.com' ||          
             hostname.includes('sungreen-systems.webflow.io');
            //   ||
            //  hostname.includes('emergent-website.webflow.io');
    }
  function isEmergent() {
  const hostname = window.location.hostname.replace(/^www\./, '');
  var result = (
    hostname.includes('emergent-website.webflow.io') ||
    hostname.includes('emergent.tech') ||
    hostname.includes('emergent-website')
  );
  return result;
}

  function showEmergentCCPABanner() {
    if (!isEmergent()) return;
    var topDoc = (window.top && window.top.document) ? window.top.document : document;
    var topBody = topDoc.body;
    if (!topBody) return;
    topBody.setAttribute('data-consentbit-emergent-showing', '1');
    var earlyStyle = topDoc.getElementById('consentbit-emergent-hide-on-load');
    if (earlyStyle && earlyStyle.parentNode) earlyStyle.parentNode.removeChild(earlyStyle);
    var container = topDoc.getElementById('cb-initial-banner');
    if (container) {
      container.style.setProperty('display', 'block', 'important');
      container.style.setProperty('visibility', 'visible', 'important');
      container.style.setProperty('opacity', '1', 'important');
    }
    hideBanner(topDoc.getElementById('cb-preferences-banner'));
    var initialBanner = topDoc.getElementById('cb-initial-banner') || topDoc.querySelector('.consentbit-ccpa-banner-div');
    if (initialBanner) {
      showBanner(initialBanner);
      requestAnimationFrame(function () {
        var b = topDoc.getElementById('cb-initial-banner') || topDoc.querySelector('.consentbit-ccpa-banner-div');
        if (b) showBanner(b);
      });
      setTimeout(function () {
        var b2 = topDoc.getElementById('cb-initial-banner') || topDoc.querySelector('.consentbit-ccpa-banner-div');
        if (b2) showBanner(b2);
      }, 50);
      setTimeout(function () {
        getConsentPreferences().then(function (prefs) {
          if (typeof updateCCPAPreferenceForm === 'function') updateCCPAPreferenceForm(prefs || {});
        }).catch(function () {});
      }, 0);
    }
  }
  if (typeof window !== 'undefined') window.ConsentbitShowEmergentBanner = showEmergentCCPABanner;

  if (isEmergent()) {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.nodeType === 3) t = t.parentElement;
      if (!t || !t.getAttribute) return;
      var attrVal = t.getAttribute('consentbit-data-donotshare');
      var isLink = (attrVal === 'consentbit-link-donotshare') || (t.closest && t.closest('[consentbit-data-donotshare="consentbit-link-donotshare"]'));
      if (!isLink) return;
      e.preventDefault();
      e.stopPropagation();
      showEmergentCCPABanner();
    }, true);
  }

  // Document-level delegated handler: #do-not-share-link and close work even if script loads after DOMContentLoaded or elements lack attribute
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t) return;
    if (t.nodeType === 3) t = t.parentElement;
    if (!t) return;
    var isDoNotShare = (t.id === 'cb-ccpa-donotsell-link') || (t.closest && t.closest('#cb-ccpa-donotsell-link'));
    var isClose = (t.id === 'cb-close-initial-btn') || (t.closest && t.closest('#cb-close-initial-btn')) || (t.getAttribute && t.getAttribute('consentbit') === 'close') || (t.closest && t.closest('[consentbit="close"]'));
    var isSaveBtn = (t.id === 'cb-save-prefs-btn') || (t.closest && t.closest('#cb-save-prefs-btn')) || (t.id === 'consebit-ccpa-prefrence-accept') || (t.closest && t.closest('#consebit-ccpa-prefrence-accept')) || (t.closest && t.closest('#cb-preferences-banner') && t.closest('a.consebit-ccpa-prefrence-accept'));
    var isCCPADeclineBtn = (t.id === 'consebit-ccpa-prefrence-decline') || (t.closest && t.closest('#consebit-ccpa-prefrence-decline')) || (t.closest && t.closest('#cb-preferences-banner') && t.closest('a.consebit-ccpa-prefrence-decline'));
    var isGDPRPreferences = (t.id === 'cb-preferences-btn') || (t.closest && t.closest('#cb-preferences-btn'));
    var isGDPRSavePreferences = (t.id === 'cb-save-prefs-btn') || (t.closest && t.closest('#cb-save-prefs-btn'));
    var isGDPRCancel = (t.id === 'cb-cancel-prefs-btn') || (t.closest && t.closest('#cb-cancel-prefs-btn'));
    var isGDPRAccept = (t.id === 'cb-accept-all-btn') || (t.closest && t.closest('#cb-accept-all-btn'));
    var isGDPRDecline = (t.id === 'cb-reject-all-btn') || (t.closest && t.closest('#cb-reject-all-btn'));
    if (isDoNotShare) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof isEmergent === 'function' && isEmergent()) {
        document.body.setAttribute('data-consentbit-emergent-showing', '1');
        var earlyStyle = document.getElementById('consentbit-emergent-hide-on-load');
        if (earlyStyle && earlyStyle.parentNode) earlyStyle.parentNode.removeChild(earlyStyle);
      }
      var container = document.getElementById('cb-initial-banner');
      if (container) {
        container.style.setProperty('display', 'block', 'important');
        container.style.setProperty('visibility', 'visible', 'important');
        container.style.setProperty('opacity', '1', 'important');
      }
      hideBanner(document.getElementById('cb-initial-banner'));
      var mb = document.getElementById('cb-preferences-banner');
      if (mb) {
        showBanner(mb);
        setTimeout(function () {
          getConsentPreferences().then(function (prefs) {
            if (typeof updateCCPAPreferenceForm === 'function') updateCCPAPreferenceForm(prefs || {});
          }).catch(function () {});
        }, 0);
      }
      return;
    }
    if (isClose) {
      e.preventDefault();
      e.stopPropagation();
      var activeBanner = getVisibleBanner();
      if (activeBanner) {
        if (typeof isEmergent === 'function' && isEmergent()) document.body.removeAttribute('data-consentbit-emergent-showing');
        var container = document.getElementById('cb-initial-banner');
        if (container) {
          container.style.setProperty('display', 'none', 'important');
          container.style.setProperty('visibility', 'hidden', 'important');
          container.style.setProperty('opacity', '0', 'important');
        }
        hideBanner(activeBanner);
      }
      return;
    }
    if (isSaveBtn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      var mainConsentBanner = document.getElementById('cb-preferences-banner');
      var initialConsentBanner = document.getElementById('cb-initial-banner');
      if (mainConsentBanner) {
        mainConsentBanner.style.setProperty('display', 'none', 'important');
        mainConsentBanner.style.setProperty('visibility', 'hidden', 'important');
        mainConsentBanner.style.setProperty('opacity', '0', 'important');
        mainConsentBanner.classList.remove('show-banner');
        mainConsentBanner.classList.add('hidden');
      }
      if (initialConsentBanner) {
        initialConsentBanner.style.setProperty('display', 'none', 'important');
        initialConsentBanner.style.setProperty('visibility', 'hidden', 'important');
        initialConsentBanner.style.setProperty('opacity', '0', 'important');
        initialConsentBanner.classList.remove('show-banner');
        initialConsentBanner.classList.add('hidden');
      }
      var container = document.getElementById('cb-initial-banner');
      if (container) {
        container.style.setProperty('display', 'none', 'important');
        container.style.setProperty('visibility', 'hidden', 'important');
        container.style.setProperty('opacity', '0', 'important');
      }
      if (typeof isEmergent === 'function' && isEmergent()) document.body.removeAttribute('data-consentbit-emergent-showing');
      document.body.style.overflow = '';
      localStorage.setItem('_cb_cg_', 'true');
      (async function () {
        var doNotShareCheckbox = document.getElementById('cb-ccpa-optout');
        var preferences;
        var includeUserAgent;
        if (doNotShareCheckbox && doNotShareCheckbox.checked) {
          preferences = { doNotShare: true, doNotSell: true, action: 'rejection', bannerType: window.locationData ? window.locationData.bannerType : undefined };
          includeUserAgent = false;
          if (typeof updateGtagConsent === 'function') updateGtagConsent(preferences);
          localStorage.setItem('_cb_cas_', 'false');
          if (typeof disableWebflowAnalytics === 'function') disableWebflowAnalytics();
          if (typeof blockScriptsWithDataCategory === 'function') blockScriptsWithDataCategory();
        } else {
          preferences = { doNotShare: false, doNotSell: false, action: 'acceptance', bannerType: window.locationData ? window.locationData.bannerType : undefined };
          includeUserAgent = true;
          if (typeof updateGtagConsent === 'function') updateGtagConsent(preferences);
          localStorage.setItem('_cb_cas_', 'true');
          if (typeof enableWebflowAnalytics === 'function') enableWebflowAnalytics();
          if (typeof unblockScriptsWithDataCategory === 'function') unblockScriptsWithDataCategory();
        }
        try {
          var cookieDays = typeof fetchCookieExpirationDays === 'function' ? await fetchCookieExpirationDays() : 7;
          await Promise.all([
            setConsentState(preferences, cookieDays),
            saveConsentStateToServer(preferences, cookieDays, includeUserAgent)
          ]);
        } catch (err) {}
      })();
      return;
    }
    if (isCCPADeclineBtn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      hideBanner(document.getElementById('cb-initial-banner'));
      hideBanner(document.getElementById('cb-preferences-banner'));

      var container2 = document.getElementById('cb-initial-banner');
      if (container2) {
        container2.style.setProperty('display', 'none', 'important');
        container2.style.setProperty('visibility', 'hidden', 'important');
        container2.style.setProperty('opacity', '0', 'important');
      }

      if (typeof isEmergent === 'function' && isEmergent()) document.body.removeAttribute('data-consentbit-emergent-showing');
      document.body.style.overflow = '';
      localStorage.setItem('_cb_cg_', 'true');
      localStorage.setItem('_cb_cas_', 'false');

      (async function () {
        try {
          var cookieDays6 = typeof fetchCookieExpirationDays === 'function' ? await fetchCookieExpirationDays() : 7;
          var preferencesCCPADecline = {
            doNotShare: true,
            doNotSell: true,
            action: 'rejection',
            bannerType: window.locationData ? window.locationData.bannerType : undefined
          };
          if (typeof updateGtagConsent === 'function') updateGtagConsent(preferencesCCPADecline);
          if (typeof blockScriptsWithDataCategory === 'function') blockScriptsWithDataCategory();
          if (typeof disableWebflowAnalytics === 'function') disableWebflowAnalytics();
          await Promise.all([
            setConsentState(preferencesCCPADecline, cookieDays6),
            saveConsentStateToServer(preferencesCCPADecline, cookieDays6, true)
          ]);
        } catch (e7) {}
      })();
      return;
    }

    // GDPR buttons (delegated): supports banners injected after DOMContentLoaded
    if (isGDPRPreferences) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      hideBanner(document.getElementById('cb-initial-banner'));
      showBanner(document.getElementById('cb-preferences-banner'));
      setTimeout(function () {
        if (typeof getConsentPreferences === 'function' && typeof updatePreferenceForm === 'function') {
          getConsentPreferences().then(function (prefs) { updatePreferenceForm(prefs || {}); }).catch(function () {});
        }
      }, 0);
      return;
    }
    if (isGDPRCancel) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      hideBanner(document.getElementById('cb-preferences-banner'));
      hideBanner(document.getElementById('cb-initial-banner'));
      if (typeof blockScriptsByCategory === 'function') blockScriptsByCategory();
      if (typeof window.gtag === 'function') {
        try {
          window.gtag('consent', 'update', {
            'analytics_storage': 'denied',
            'ad_storage': 'denied',
            'ad_personalization': 'denied',
            'ad_user_data': 'denied',
            'personalization_storage': 'denied'
          });
        } catch (e2) {}
      }
      var ac = document.getElementById('cb-pref-analytics');
      var mc = document.getElementById('cb-pref-marketing');
      var pc = document.getElementById('cb-pref-preferences');
      if (ac) ac.checked = false;
      if (mc) mc.checked = false;
      if (pc) pc.checked = false;
      localStorage.setItem('_cb_cg_', 'true');
      (async function () {
        try {
          var cookieDays2 = typeof fetchCookieExpirationDays === 'function' ? await fetchCookieExpirationDays() : 7;
          var prefs2 = { analytics: false, marketing: false, personalization: false, bannerType: window.locationData ? window.locationData.bannerType : undefined };
          if (typeof updateGtagConsent === 'function') updateGtagConsent(prefs2);
          await Promise.all([
            setConsentState(prefs2, cookieDays2),
            saveConsentStateToServer(prefs2, cookieDays2, false)
          ]);
        } catch (e3) {}
      })();
      return;
    }
    if (isGDPRAccept) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      hideBanner(document.getElementById('cb-initial-banner'));
      hideBanner(document.getElementById('cb-initial-banner'));
      hideBanner(document.getElementById('cb-preferences-banner'));
      hideBanner(document.getElementById('cb-preferences-banner'));
      hideBanner(document.getElementById('cb-initial-banner'));
      localStorage.setItem('_cb_cg_', 'true');
      var prefsA = { analytics: true, marketing: true, personalization: true, doNotShare: false, action: 'acceptance', bannerType: window.locationData ? window.locationData.bannerType : undefined };
      if (typeof updateGtagConsent === 'function') updateGtagConsent(prefsA);
      setTimeout(function () {
        if (typeof enableAllScriptsWithDataCategory === 'function') enableAllScriptsWithDataCategory();
        (async function () {
          try {
            var cookieDays3 = typeof fetchCookieExpirationDays === 'function' ? await fetchCookieExpirationDays() : 7;
            await Promise.all([
              setConsentState(prefsA, cookieDays3),
              saveConsentStateToServer(prefsA, cookieDays3, true)
            ]);
          } catch (e4) {}
        })();
      }, 0);
      return;
    }
    if (isGDPRDecline) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      hideBanner(document.getElementById('cb-initial-banner'));
      hideBanner(document.getElementById('cb-initial-banner'));
      hideBanner(document.getElementById('cb-preferences-banner'));
      hideBanner(document.getElementById('cb-preferences-banner'));
      hideBanner(document.getElementById('cb-initial-banner'));
      localStorage.setItem('_cb_cg_', 'true');
      var prefsD = { analytics: false, marketing: false, personalization: false, doNotShare: true, action: 'rejection', bannerType: window.locationData ? window.locationData.bannerType : undefined };
      if (typeof updateGtagConsent === 'function') updateGtagConsent(prefsD);
      // Block immediately (synchronous) so scripts are disabled before anything else runs
      if (typeof blockScriptsByCategory === 'function') blockScriptsByCategory();
      (async function () {
        try {
          var cookieDays4 = typeof fetchCookieExpirationDays === 'function' ? await fetchCookieExpirationDays() : 7;
          await Promise.all([
            setConsentState(prefsD, cookieDays4),
            saveConsentStateToServer(prefsD, cookieDays4, false)
          ]);
        } catch (e5) {}
      })();
      return;
    }
    if (isGDPRSavePreferences) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      hideBanner(document.getElementById('cb-preferences-banner'));
      hideBanner(document.getElementById('cb-initial-banner'));
      hideBanner(document.getElementById('cb-initial-banner'));
      localStorage.setItem('_cb_cg_', 'true');
      var analytics = !!(document.getElementById('cb-pref-analytics') && document.getElementById('cb-pref-analytics').checked);
      var marketing = !!(document.getElementById('cb-pref-marketing') && document.getElementById('cb-pref-marketing').checked);
      var personalization = !!(document.getElementById('cb-pref-preferences') && document.getElementById('cb-pref-preferences').checked);
      var prefsS = { analytics: analytics, marketing: marketing, personalization: personalization, action: (analytics || marketing || personalization) ? 'acceptance' : 'rejection', bannerType: window.locationData ? window.locationData.bannerType : undefined };
      if (typeof updateGtagConsent === 'function') updateGtagConsent(prefsS);
      if (typeof blockScriptsByCategory === 'function') blockScriptsByCategory();
      var selected = [];
      if (analytics) selected.push('analytics');
      if (marketing) selected.push('marketing');
      if (personalization) selected.push('personalization');
      if (selected.length > 0 && typeof enableScriptsByCategories === 'function') enableScriptsByCategories(selected);
      (async function () {
        try {
          var cookieDays5 = typeof fetchCookieExpirationDays === 'function' ? await fetchCookieExpirationDays() : 7;
          await Promise.all([
            setConsentState(prefsS, cookieDays5),
            saveConsentStateToServer(prefsS, cookieDays5, true)
          ]);
        } catch (e6) {}
      })();
      return;
    }
  }, true);

async function showAppropriateBanner() {
  __cbTiming('showAppropriateBanner:start');
  await hideAllBanners();
  __cbTiming('showAppropriateBanner:afterHideAll');

  const allBannersElement = document.querySelector('[data-all-banners]');
  const hasAllBannersAttribute = !!allBannersElement;
  const allBannersValue = hasAllBannersAttribute
    ? allBannersElement.getAttribute('data-all-banners')
    : null;

  const initialCCPABanner = document.getElementById('cb-initial-banner');
  const consentBanner = document.getElementById('cb-initial-banner');
  const usBanner = document.getElementById('cb-initial-banner');

  const isEmergentSungreen = isEmergentOrSungreen();
  const hostname = window.location.hostname.replace('www.', '');
  const isEmergentOnly =
    hostname.includes('emergent-website.webflow.io') ||
    hostname.includes('emergent.tech');

  if (isEmergentOnly || isEmergentSungreen) {
    __cbTiming('showAppropriateBanner:skip', { reason: 'emergentOnlyOrSungreen' });
    await hideAllBanners();
    return;
  }
  if (hasAllBannersAttribute && allBannersValue === 'false') {
    __cbTiming('showAppropriateBanner:forcedGDPR');
    showGDPRBanner();

    setTimeout(async () => {
      __cbTiming('showAppropriateBanner:forcedGDPR:location:start');
      const detectedLocation = await window.getLocationData();
      __cbTiming('showAppropriateBanner:forcedGDPR:location:end', detectedLocation || null);
      if (detectedLocation) {
        window.locationData = {
          country: detectedLocation.country || 'EU',
          continent: detectedLocation.continent || 'Europe',
          state: detectedLocation.state || null,
          bannerType: 'GDPR',
        };
      } else {
        window.locationData = {
          country: 'EU',
          continent: 'Europe',
          state: null,
          bannerType: 'GDPR',
        };
      }
    }, 0);

    return;
  }

  // 2) Emergent ONLY → pure opt‑out: no banner on load
  if (isEmergentOnly) {
    await hideAllBanners();
    return;
  }

  // 3) Attribute missing or "true" → use location for non‑Emergent
  __cbTiming('showAppropriateBanner:location:start');
  const locationData = await window.getLocationData();
  __cbTiming('showAppropriateBanner:location:end', locationData || null);
  if (!locationData || !locationData.bannerType) {
    __cbTiming('showAppropriateBanner:noLocationOrBannerType');
    return;
  }

  const country = locationData.country;
  const state = locationData.state;

  // 3.a) Emergent/Sungreen + US → special US logic (for Sungreen)
  if (isEmergentSungreen && country === 'US') {
    const isCalifornia =
      state === 'CA' ||
      state === 'California' ||
      (state && state.toUpperCase() === 'CA');

    const shouldShowCCPA = isCalifornia || locationData.bannerType === 'CCPA';

    if (shouldShowCCPA) {
      if(isEmergent()){
        await hideAllBanners();
        return;
      }
      if (initialCCPABanner) {
        __cbTiming('showAppropriateBanner:show', { which: 'initialCCPA', id: 'initial-consent-banner' });
        showBanner(initialCCPABanner);
      } else if (consentBanner) {
        __cbTiming('showAppropriateBanner:show', { which: 'gdprFallback', id: 'consent-banner' });
        showBanner(consentBanner);
      }
    } else {
      // Non‑California US for Emergent/Sungreen
      if (usBanner) {
        __cbTiming('showAppropriateBanner:show', { which: 'usBanner', id: 'consent-us-banner' });
        showBanner(usBanner);
      } else if (initialCCPABanner) {
         if(isEmergent()){
        await hideAllBanners();
        return;
      }
        __cbTiming('showAppropriateBanner:show', { which: 'initialCCPA:fallback', id: 'initial-consent-banner' });
        showBanner(initialCCPABanner);
      } else if (consentBanner) {
         if(isEmergent()){
        await hideAllBanners();
        return;
      }
        __cbTiming('showAppropriateBanner:show', { which: 'gdprFallback2', id: 'consent-banner' });
        showBanner(consentBanner);
      }
    }

    return; // do not process further for Emergent/Sungreen US
  }

  // 3.b) Other US laws → CCPA model
  if (
    ['CCPA', 'VCDPA', 'CPA', 'CTDPA', 'UCPA'].includes(locationData.bannerType) ||
    country === 'US'
  ) {
    if (initialCCPABanner) {
       if(isEmergent()){
        await hideAllBanners();
        return;
      }
      __cbTiming('showAppropriateBanner:show', { which: 'initialCCPA', id: 'initial-consent-banner' });
      showBanner(initialCCPABanner);
    } else if (consentBanner) {
       if(isEmergent()){
        await hideAllBanners();
        return;
      }
      __cbTiming('showAppropriateBanner:show', { which: 'gdprFallback', id: 'consent-banner' });
      showBanner(consentBanner);
    }
    return;
  }

  // 3.c) Default → GDPR banner
  if (consentBanner) {
     if(isEmergent()){
        await hideAllBanners();
        return;
      }
    __cbTiming('showAppropriateBanner:show', { which: 'gdpr', id: 'consent-banner' });
    showBanner(consentBanner);
  }
}

    
    // Server-side location detection functions removed - using direct server detection only
    
      async function detectLocationAndGetBannerType() {
      try {
        const sessionToken = localStorage.getItem('_cb_vst_');
  
        if (!sessionToken) {
          __cbTiming('detectLocation:skip', { reason: 'noSessionToken' });
          return null;
        }
  
        const siteName = window.location.hostname.replace(/^www\./, '').split('.')[0];
  
        const apiUrl = `https://app.consentbit.com/api/v2/cmp/detect-location?siteName=${encodeURIComponent(siteName)}`;
        const __tStart = __cbNow();
        __cbTiming('detectLocation:fetch:start', { apiUrl: apiUrl });
  
        const response = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${sessionToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
        });
  
        if (!response.ok) {
          __cbTiming('detectLocation:fetch:end', { ok: false, status: response.status, ms: Math.round((__cbNow() - __tStart) * 100) / 100 });
          return null;
        }
        __cbTiming('detectLocation:fetch:end', { ok: true, status: response.status, ms: Math.round((__cbNow() - __tStart) * 100) / 100 });
  
        const data = await response.json();
        __cbTiming('detectLocation:json', { bannerType: data && data.bannerType, country: data && data.country, state: data && data.state });
  
        if (!data.bannerType) {
          __cbTiming('detectLocation:noBannerType');
          return null;
        }
  
        country = data.country;
        const locationData = {
          country: data.country || 'UNKNOWN',
          continent: data.continent || 'UNKNOWN',
          state: data.state || null,
          bannerType: data.bannerType
        };
        currentLocation = locationData;
        country = locationData.country;
        return data;
      } catch (error) {
        __cbTiming('detectLocation:error', { message: (error && error.message) ? error.message : String(error) });
        return null;
      }
    }
    
    // Global function to get location data (cached, can be called from anywhere)
    window.getLocationData = async function(forceRefresh = false) {
      // Return cached data if available and not forcing refresh
      if (window.locationData && !forceRefresh) {
        __cbTiming('getLocationData:cacheHit', window.locationData);
        return window.locationData;
      }
      
      // If detection is already in progress, wait for it
      if (locationDetectionPromise) {
        __cbTiming('getLocationData:awaitInFlight');
        return await locationDetectionPromise;
      }
      
      // Start new detection
      locationDetectionPromise = (async () => {
        try {
          __cbTiming('getLocationData:start', { forceRefresh: !!forceRefresh });
          const data = await detectLocationAndGetBannerType();
          if (data) {
            // Store globally for reuse
            window.locationData = {
              country: data.country || 'UNKNOWN',
              continent: data.continent || 'UNKNOWN',
              state: data.state || null,
              bannerType: data.bannerType
            };
            __cbTiming('getLocationData:done', window.locationData);
            
            // CRITICAL: If CCPA banner is detected, update Consent Mode to 'granted' (opt-out model)
            // CCPA allows tracking by default, user must opt-out
            if (data.bannerType && ["CCPA", "VCDPA", "CPA", "CTDPA", "UCPA"].includes(data.bannerType)) {
              // Check if consent was already given (don't override user's choice)
              const consentGiven = localStorage.getItem("_cb_cg_");
              if (consentGiven !== "true" && typeof window.gtag === 'function') {
                window.gtag('consent', 'update', {
                  'analytics_storage': 'granted',
                  'ad_storage': 'granted',
                  'ad_personalization': 'granted',
                  'ad_user_data': 'granted',
                  'personalization_storage': 'granted',
                  'functionality_storage': 'granted',
                  'security_storage': 'granted'
                });
                
                // Send page_view event since tracking is now allowed
                setTimeout(function() {
                  if (typeof window.gtag === 'function') {
                    try {
                      window.gtag('event', 'page_view', {
                        'page_title': document.title,
                        'page_location': window.location.href,
                        'page_path': window.location.pathname + window.location.search
                      });
                    } catch (e) {
                      // Silent error handling
                    }
                  }
                }, 100);
              }
            }
            // For GDPR, keep 'denied' (already set in initial Consent Mode)
            
            return window.locationData;
          }
          __cbTiming('getLocationData:null');
          return null;
        } catch (error) {
          __cbTiming('getLocationData:error', { message: (error && error.message) ? error.message : String(error) });
          return null;
        } finally {
          locationDetectionPromise = null; // Clear promise when done
        }
      })();
      
      return await locationDetectionPromise;
    };
  
  
    async function saveConsentStateToServer(preferences, cookieDays, includeUserAgent) {
      try {
        const clientId = window.location.hostname;
        const visitorId = localStorage.getItem("_cb_vid_");
        const policyVersion = "1.2";
        const timestamp = new Date().toISOString();
        const sessionToken = await getVisitorSessionToken();

        if (!sessionToken) {
          return;
        }
  
  
  
  
        const fullPayload = {
          clientId,
          visitorId,
          preferences,
          policyVersion,
          timestamp,
          country: country || "IN",
          bannerType: preferences.bannerType || "GDPR",
          expiresAtTimestamp: Date.now() + ((cookieDays || 7) * 24 * 60 * 60 * 1000),
          expirationDurationDays: cookieDays || 7,
          metadata: {
            ...(includeUserAgent && { userAgent: navigator.userAgent }),
            language: navigator.language,
            platform: navigator.userAgentData?.platform || "unknown",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
          }
        };
  
  
        const encryptedPayload = await encryptWithHardcodedKey(JSON.stringify(fullPayload));
  
  
        const requestBody = {
          encryptedData: encryptedPayload
        };
  
  
  
        const response = await fetch("https://app.consentbit.com/api/v2/cmp/consent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${sessionToken}`,
          },
          body: JSON.stringify(requestBody),
        });
  
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Server error: ${response.status} ${response.statusText}`);
        }
  
        const result = await response.json();
  
      } catch (error) {
        // Silent error handling
      }
    }
  function setConsentExpiry(cookieDays) {
  const days = cookieDays || 7; // default 7 days
  const ms = days * 24 * 60 * 60 * 1000;
  localStorage.setItem('_cb_cexp_', String(Date.now() + ms));
}
  function isConsentExpired() {
  const expiry = localStorage.getItem('_cb_cexp_');
  if (!expiry) return false;
  return Date.now() > Number(expiry);
}
function clearConsentState() {
  localStorage.removeItem('_cb_cg_');   // consent given flag
  localStorage.removeItem('_cb_cexp_'); // expiry
  // Optional: clear stored preferences if you want a clean reset
   localStorage.removeItem('_cb_cp_');
}
    function updatePreferenceForm(preferences) {
      const necessaryCheckbox = document.getElementById('cb-pref-essential');
      const marketingCheckbox = document.getElementById('cb-pref-marketing');
      const personalizationCheckbox = document.getElementById('cb-pref-preferences');
      const analyticsCheckbox = document.getElementById('cb-pref-analytics');
      const checkboxUs = document.getElementById('cb-ccpa-optout');
  
  
  
      if (necessaryCheckbox) {
        necessaryCheckbox.checked = true;
        necessaryCheckbox.disabled = true;
      }
      
      // US preference banner checkbox - always checked and disabled
      if (checkboxUs && !checkboxUs.hasAttribute('data-us-checkbox-initialized')) {
        checkboxUs.checked = true;
        checkboxUs.disabled = true;
        checkboxUs.setAttribute('data-us-checkbox-initialized', 'true');
        
        // Prevent unchecking even if user tries to interact
        checkboxUs.addEventListener('click', function(e) {
          e.preventDefault();
          checkboxUs.checked = true;
          return false;
        }, true);
        checkboxUs.addEventListener('change', function(e) {
          if (!checkboxUs.checked) {
            checkboxUs.checked = true;
          }
        }, true);
      } else if (checkboxUs) {
        // Ensure it's still checked even if already initialized
        checkboxUs.checked = true;
        checkboxUs.disabled = true;
      }
      
      if (marketingCheckbox) {
        marketingCheckbox.checked = Boolean(preferences.marketing);
      }
      if (personalizationCheckbox) {
        personalizationCheckbox.checked = Boolean(preferences.personalization);
      }
      if (analyticsCheckbox) {
        analyticsCheckbox.checked = Boolean(preferences.analytics);
      }
    }
  
  
    function updateCCPAPreferenceForm(preferences) {
  
      const doNotShareCheckbox = document.getElementById('cb-ccpa-optout');
  
  
  
      if (doNotShareCheckbox) {
  
        if (preferences.hasOwnProperty('doNotShare')) {
          doNotShareCheckbox.checked = preferences.doNotShare;
        } else if (preferences.hasOwnProperty('donotshare')) {
          doNotShareCheckbox.checked = preferences.donotshare;
        } else {
  
          const shouldCheck = !preferences.analytics || !preferences.marketing || !preferences.personalization;
          doNotShareCheckbox.checked = shouldCheck;
        }
      }
  
  
      const ccpaToggleCheckboxes = document.querySelectorAll('.consentbit-ccpa-prefrence-toggle input[type="checkbox"]');
      ccpaToggleCheckboxes.forEach(checkbox => {
        const checkboxName = checkbox.name || checkbox.getAttribute('data-category') || '';
  
        if (checkboxName.toLowerCase().includes('analytics')) {
          checkbox.checked = !Boolean(preferences.analytics);
        } else if (checkboxName.toLowerCase().includes('marketing') || checkboxName.toLowerCase().includes('advertising')) {
          checkbox.checked = !Boolean(preferences.marketing);
        } else if (checkboxName.toLowerCase().includes('personalization') || checkboxName.toLowerCase().includes('functional')) {
          checkbox.checked = !Boolean(preferences.personalization);
        }
      });
    }
  
    async function checkPublishingStatus() {
      try {
        // Cache publishing status for 10 minutes to avoid API round-trip on every page load
        const _cbPsKey = '_cb_ps_';
        try {
          const _cbPsRaw = localStorage.getItem(_cbPsKey);
          if (_cbPsRaw) {
            const _cbPs = JSON.parse(_cbPsRaw);
            if (_cbPs && typeof _cbPs.canPublish === 'boolean' && Date.now() < (_cbPs.exp || 0)) {
              return _cbPs.canPublish;
            }
          }
        } catch (_) {}

        const sessionToken = localStorage.getItem('_cb_vst_');
        if (!sessionToken) {
          return false;
        }
        const siteDomain = window.location.hostname;
        
        // Get siteId from data-site-info or data-site-id attribute if available
        let siteId = null;
        const siteInfoElement = document.querySelector('[data-site-info], [data-site-id]');
        if (siteInfoElement) {
          const siteInfo = siteInfoElement.getAttribute('data-site-info') || siteInfoElement.getAttribute('data-site-id');
          if (siteInfo) {
            try {
              // Try to parse as JSON first
              const parsed = JSON.parse(siteInfo);
              siteId = parsed.siteId || parsed.id || siteInfo;
            } catch (e) {
              // If not JSON, use the value directly
              siteId = siteInfo;
            }
          }
        }
        
        let apiUrl = `https://app.consentbit.com/api/site/subscription-status?siteDomain=${encodeURIComponent(siteDomain)}`;
        if (siteId) {
          apiUrl += `&siteId=${encodeURIComponent(siteId)}`;
        }
        apiUrl += `&siteName=${encodeURIComponent(siteDomain)}`;
        
        const response = await fetch(apiUrl, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${sessionToken}`,
            "Accept": "application/json"
          }
        });
        if (!response.ok) {
          return false;
        }
        const data = await response.json();
        const canPublish = data.canPublishToCustomDomain === true;
        // Cache result for 10 minutes
        try { localStorage.setItem(_cbPsKey, JSON.stringify({ canPublish, exp: Date.now() + 600000 })); } catch (_) {}
        return canPublish;
      } catch (error) {
        return false;
      }
    }
    function removeConsentElements() {    const selectors = [
        '.consentbit-gdpr-banner-div',
        '.consentbit-preference_div',
        '.consentbit-change-preference',
        '.consentbit-ccpa-banner-div',
        '.consentbit-ccpa_preference',
      ];
      selectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => el.remove());
      });
    }
    function isStagingHostname() {
      const hostname = window.location.hostname;
      return hostname.includes('.webflow.io') || hostname.includes('localhost') || hostname.includes('127.0.0.1');
    }
  
  
    function monitorDynamicScripts() {
      const observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
          mutation.addedNodes.forEach(function (node) {
            if (node.nodeType === 1 && node.tagName === 'SCRIPT') {
  
              // Only block scripts with data-category attribute
              // Scripts without data-category are allowed (functionality scripts)
              if (!node.hasAttribute('data-category')) {
                return; // Skip blocking scripts without data-category (functionality scripts)
              }
  
              // CRITICAL: Never block Google Tag Manager/Google Analytics scripts
              // Even if they have data-category attribute, they use Consent Mode
              // If it's a Google script, ensure it's unblocked immediately
              if (isGoogleScript(node)) {
                if (node.type === 'text/plain') {
                  node.type = 'text/javascript';
                }
                node.removeAttribute('data-category');
                return; // Exit early for Google scripts - don't block them
              }
  
              const analyticsConsent = localStorage.getItem("_cb_cas_");
              const marketingConsent = localStorage.getItem("_cb_cms_");
              const personalizationConsent = localStorage.getItem("_cb_cps_");
              const consentGiven = localStorage.getItem("_cb_cg_");
  
  
              if (node.hasAttribute('data-category')) {
                const category = node.getAttribute('data-category');
                const categories = category.split(',').map(function (cat) { return cat.trim(); });
  
                // Check if ANY category is necessary or essential (these should never be blocked)
                var hasEssentialCategory = categories.some(function (cat) {
                  var lowercaseCat = cat.toLowerCase();
                  return lowercaseCat === 'necessary' || lowercaseCat === 'essential';
                });
  
  
                if (!hasEssentialCategory && consentGiven === "true") {
                  var shouldBlock = false;
  
  
                  categories.forEach(function (cat) {
                    var lowercaseCat = cat.toLowerCase();
                    if (lowercaseCat === 'analytics' && analyticsConsent === "false") {
                      shouldBlock = true;
                    } else if ((lowercaseCat === 'marketing' || lowercaseCat === 'advertising') && marketingConsent === "false") {
                      shouldBlock = true;
                    } else if ((lowercaseCat === 'personalization' || lowercaseCat === 'functional') && personalizationConsent === "false") {
                      shouldBlock = true;
                    }
                  });
  
                  if (shouldBlock) {
                    node.type = 'text/plain';
                  }
                }
              } else {
  
                if (node.src && (
                  node.src.includes('facebook.net') ||
                  node.src.includes('fbcdn.net') ||
                  node.src.includes('hotjar.com') ||
                  node.src.includes('mixpanel.com') ||
                  node.src.includes('intercom.io') ||
                  node.src.includes('klaviyo.com') ||
                  node.src.includes('tiktok.com') ||
                  node.src.includes('linkedin.com') ||
                  node.src.includes('twitter.com') ||
                  node.src.includes('adobe.com')
                )) {
  
                  if (analyticsConsent === "false" && marketingConsent === "false") {
                    node.type = 'text/plain';
                  }
                }
              }
            }
          });
        });
      });
  
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }
  
  
    // CRITICAL: Unblock Google scripts immediately when script loads (before DOMContentLoaded)
    // This ensures Google scripts with type="text/plain" are unblocked as soon as possible
    unblockGoogleScripts();
    
    // Load styles and monitor scripts after initial render to avoid blocking
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        // Consent Mode 'default' is already set at the top of the script (before IIFE)
        // No need to set it again here - it's already protecting against early GA4/GTM initialization
        
        // Unblock Google scripts again during DOMContentLoaded to catch any scripts added dynamically
        unblockGoogleScripts();
        
        monitorDynamicScripts();
      });
    } else {
      // DOM already loaded, unblock Google scripts immediately
      unblockGoogleScripts();
      
      monitorDynamicScripts();
    }
  
  
  
    async function checkConsentExpiration() {
      const expiresAt = localStorage.getItem('_cb_cea_');
      if (expiresAt && Date.now() > parseInt(expiresAt, 10)) {
  
        localStorage.removeItem('_cb_cg_');
        localStorage.removeItem('_cb_cp_');
        localStorage.removeItem('_cb_cea_');
        localStorage.removeItem('_cb_ced_');
  
        ['analytics', 'marketing', 'personalization'].forEach(category => {
          setConsentCookie('cb-consent-' + category + '_storage', '', -1);
        });
      }
    }
  
   
    async function disableScrollOnSite(){
      const scrollControl = document.querySelector('[scroll-control="true"]');
      if (!scrollControl) return;
      
      function checkAndUpdateScroll() {
        // Check all banners with data-cookie-banner="true"
        const cookieBanners = document.querySelectorAll('[data-cookie-banner="true"]');
        let anyVisible = false;

        cookieBanners.forEach(function(banner) {
          const style = window.getComputedStyle(banner);
          if (style.display !== "none" && 
              style.visibility !== "hidden" &&
              style.opacity !== "0") {
            anyVisible = true;
          }
        });
        
        // If any banner with data-cookie-banner="true" is visible, disable scroll
        // If no banners are visible, enable scroll
        document.body.style.overflow = anyVisible ? "hidden" : "";
      }
      
      // Set up MutationObserver for all banners with data-cookie-banner="true"
      const cookieBanners = document.querySelectorAll('[data-cookie-banner="true"]');
      cookieBanners.forEach(function(banner) {
        const observer = new MutationObserver(() => {
          checkAndUpdateScroll();
        });
        observer.observe(banner, { attributes: true, attributeFilter: ["style", "class"] });
      });
      
      // Initial check on load
      checkAndUpdateScroll();
    }
  
    async function __cbInit() {
      // Emergent: hide all banners immediately on load (no banner on load for EU or US)
      if (isEmergent()) {
        await hideAllBanners();
      }

      unblockGoogleScripts();


      // STEP 1: Check if consent is already given - if yes, don't do banner/location logic
      // Check both _cb_cg_ (consent.js key) AND consentbit_* (standard loader key)
      let consentGiven = localStorage.getItem("_cb_cg_");
      if (!consentGiven) {
        for (var _cbCI = 0; _cbCI < localStorage.length; _cbCI++) {
          var _cbCK = localStorage.key(_cbCI);
          if (_cbCK && _cbCK.indexOf('consentbit_') === 0) {
            try { var _cbCV = JSON.parse(localStorage.getItem(_cbCK)); if (_cbCV && _cbCV.accepted) { consentGiven = 'true'; break; } } catch(_e) {}
          }
        }
      }
        if (isConsentExpired()) {
         clearConsentState();
         consentGiven = null;
        }

      // Block non-essential scripts immediately if consent not yet given.
      // Scripts placed with type="text/plain" + data-category in HTML stay inert until unblocked.
      // Scripts already executed (type="text/javascript") cannot be undone here — site owners
      // must use type="text/plain" in their HTML for pre-consent blocking to work.
      if (!consentGiven) {
        blockScriptsByCategory();
      }

      // STEP 2: Check staging status synchronously (needed for toggle button visibility)
      const isStaging = isStagingHostname();

      // Variables to store background data
      let canPublish = false;

      // STEP 3: Show toggle button immediately if staging or consent already given
      const toggleConsentBtn = document.getElementById('cb-floating-trigger');
      if (toggleConsentBtn) {
        // Show toggle button immediately if staging or consent already given
        if (isStaging || consentGiven) {
          toggleConsentBtn.style.display = 'block';
        }
        
        // Set up click handler immediately - consolidated banner display logic
        toggleConsentBtn.onclick = async function (e) {
          e.preventDefault();
          if (isEmergent()) {
            await hideAllBanners();
            return;
          }
          // Ensure token exists BEFORE location detection (token is required for getLocationData)
          let token = localStorage.getItem('_cb_vst_');
          if (!token) {
            // Generate token if not available (needed for location detection regardless of consent state)
            try {
              token = await getVisitorSessionToken();
              if (token && !localStorage.getItem('_cb_vst_')) {
                localStorage.setItem('_cb_vst_', token);
              }
            } catch (error) {
            }
          }

          // Use consolidated function to show appropriate banner
          if (!isEmergent()) {
            await showAppropriateBanner();
          }
          
          // SPECIAL LOGIC: For emergent/sungreen clients, ensure correct banner is shown after toggle
          // This ensures US banner is shown for non-California US states, or CCPA for California/CCPA bannerType
          if (isEmergentOrSungreen()) {
            
            const locationData = await window.getLocationData();
            if (locationData && locationData.country === "US") {
              // Check for both "CA" (state code) and "California" (full name) formats
              const isCalifornia = locationData.state === "CA" || 
                                   locationData.state === "California" ||
                                   (locationData.state && locationData.state.toUpperCase() === "CA");
              
              // Show CCPA banner if: California state OR bannerType is CCPA
              const shouldShowCCPA = isCalifornia || locationData.bannerType === "CCPA";
              
              if (shouldShowCCPA) {
                // California visitor OR CCPA bannerType - show CCPA banner
                const initialCCPABanner = document.getElementById("cb-initial-banner");
                const mainConsentBanner = document.getElementById("cb-preferences-banner");
                if (initialCCPABanner) {
                  if (isEmergent()) {
                    await hideAllBanners();
                    return;
                  }
                  showBanner(initialCCPABanner);
                  hideBanner(document.getElementById("cb-initial-banner"));
                } else if (mainConsentBanner) {
                  showBanner(mainConsentBanner);
                  hideBanner(document.getElementById("cb-initial-banner"));
                }
              } else {
                // US but not California and not CCPA bannerType - show US banner
                const usBanner = document.getElementById("cb-initial-banner");
                if (usBanner) {
                  showBanner(usBanner);
                  hideBanner(document.getElementById("cb-initial-banner"));
                  hideBanner(document.getElementById("cb-preferences-banner"));
                } else {
                  // Fallback to CCPA banner if US banner doesn't exist (for US visitors)
                  const initialCCPABanner = document.getElementById("cb-initial-banner");
                  const mainConsentBanner = document.getElementById("cb-preferences-banner");
                  if (isEmergent()) {
                    await hideAllBanners();
                    return;
                  }
                  if (initialCCPABanner) {
                    showBanner(initialCCPABanner);
                  } else if (mainConsentBanner) {
                    showBanner(mainConsentBanner);
                  }
                }
              }
            }
          }
          
          // Update preference forms after banner is shown
          if (typeof updatePreferenceForm === 'function') {
            setTimeout(async () => {
              const preferences = await getConsentPreferences();
              updatePreferenceForm(preferences);
            }, 100);
          }
        };
      }
      
      // STEP 4: Background operations - token generation and location detection (non-blocking)
      if (!consentGiven) {
        if (isEmergent()) {
          await hideAllBanners();
          return;
        }
        // Hide immediately to prevent unpaid/wrong-region banners from flashing
        await hideAllBanners();

        // Check data-all-banners attribute first
        const allBannersElement = document.querySelector('[data-all-banners]');
        const hasAllBannersAttribute = allBannersElement && allBannersElement.hasAttribute('data-all-banners');
        const allBannersValue = hasAllBannersAttribute ? allBannersElement.getAttribute('data-all-banners') : null;
        
        // ALWAYS generate token and detect location (for both false and true cases)
        setTimeout(async () => {
          try {
            // Generate token
            const token = await getVisitorSessionToken();

            if (!token) {
              // Token generation failed — show GDPR banner as fallback so user isn't stuck
              await showAppropriateBanner();
              return;
            } else {
              if (!localStorage.getItem('_cb_vst_')) {
                localStorage.setItem('_cb_vst_', token);
              }
            }

            // If staging, skip publishing status check and show banner immediately
            // If not staging, check publishing status first before showing banner
            if (isStaging) {
              // skip canPublish check for staging
            } else if (window.__CB_WEBFLOW_MODE__) {
              // Webflow/Framer mode: the CDN already verified the subscription when serving
              // the loader script, so canPublishToCustomDomain check is redundant AND wrong
              // (Webflow subdomains like .webflow.io are never "custom domains").
              canPublish = true;
              if (toggleConsentBtn) toggleConsentBtn.style.display = 'block';
            } else {
              // For non-staging sites, check publishing status first before showing banner
              canPublish = await checkPublishingStatus();

              // Update toggle button visibility after canPublish check
              if (toggleConsentBtn) {
                if (canPublish) {
                  toggleConsentBtn.style.display = 'block';
                } else {
                  toggleConsentBtn.style.display = 'none';
                }
              }

              if (!canPublish) {
                removeConsentElements();
                return;
              }
            }
            
            // If data-all-banners="false", show GDPR banner after token generation
            if (hasAllBannersAttribute && allBannersValue === 'false') {
              if (isEmergent()) {
                await hideAllBanners();
                return;
              }
              showGDPRBanner();
            }
            
            // Detect location and show banner
            // For staging: shows immediately after location detection
            // For non-staging: shows after publishing status check and location detection
            const detectedLocation = await window.getLocationData();
            
            if (hasAllBannersAttribute && allBannersValue === 'false') {
              if (isEmergent()) {
                await hideAllBanners();
                return;
              }
              // For data-all-banners="false", update locationData but keep bannerType as GDPR
              if (detectedLocation) {
                window.locationData = {
                  country: detectedLocation.country || 'EU',
                  continent: detectedLocation.continent || 'Europe',
                  state: detectedLocation.state || null,
                  bannerType: 'GDPR' // Always GDPR when data-all-banners="false"
                };
              } else {
                // Fallback if detection fails
                window.locationData = {
                  country: 'EU',
                  continent: 'Europe',
                  state: null,
                  bannerType: 'GDPR'
                };
              }
             
            } else {
              // For data-all-banners="true" OR attribute missing (doesn't exist) - show appropriate banner based on location detection
              if(isEmergent()){
              await hideAllBanners();

                return;
              }
              else {
                await showAppropriateBanner();
              }
            }

          } catch (error) {
            console.error('[CB-INIT] setTimeout catch:', error);
            if (!hasAllBannersAttribute || allBannersValue !== 'false') {
              clearVisitorSession();
              setTimeout(() => location.reload(), 5000);
            }
            return;
          }
        }, 0);
      }
      
     
      // Set up GDPR banner buttons IMMEDIATELY (before async operations)
      // Preferences button (show preferences panel)
      const preferencesBtn = document.getElementById('cb-preferences-btn');
      if (preferencesBtn) {
        preferencesBtn.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          // IMMEDIATE UI RESPONSE - synchronous
          const consentBanner = document.getElementById("cb-initial-banner");
          const mainBanner = document.getElementById("cb-preferences-banner");
          if (consentBanner) hideBanner(consentBanner);
          if (mainBanner) showBanner(mainBanner);
          
          // Background operations (non-blocking)
          setTimeout(function() {
            getConsentPreferences().then(preferences => {
              updatePreferenceForm(preferences);
            }).catch(error => {
              // Silent error handling
            });
          }, 0);
        };
      }
  
      // Cancel button (go back to main banner)
      const cancelGDPRBtn = document.getElementById('cb-cancel-prefs-btn');
      if (cancelGDPRBtn) {
        cancelGDPRBtn.onclick = async function (e) {
          e.preventDefault();
          // STEP 6: Hide banners
          hideBanner(document.getElementById("cb-preferences-banner"));
          hideBanner(document.getElementById("cb-initial-banner"));
          // STEP 1: Block all scripts except necessary/essential
          blockScriptsByCategory();
  
          // STEP 2: Also block any scripts that are already running by disabling them
          // Disable Google Analytics if present
          if (typeof gtag !== 'undefined') {
            gtag('consent', 'update', {
              'analytics_storage': 'denied',
              'ad_storage': 'denied',
              'ad_personalization': 'denied',
              'ad_user_data': 'denied',
              'personalization_storage': 'denied'
            });
          }
  
          // Disable Google Tag Manager if present
          if (typeof window.dataLayer !== 'undefined') {
            window.dataLayer.push({
              'event': 'consent_denied',
              'analytics_storage': 'denied',
              'ad_storage': 'denied'
            });
          }
  
          // STEP 3: Uncheck all preference checkboxes
          const analyticsCheckbox = document.getElementById('cb-pref-analytics');
          const marketingCheckbox = document.getElementById('cb-pref-marketing');
          const personalizationCheckbox = document.getElementById('cb-pref-preferences');
  
          if (analyticsCheckbox) {
            analyticsCheckbox.checked = false;
          }
          if (marketingCheckbox) {
            marketingCheckbox.checked = false;
          }
          if (personalizationCheckbox) {
            personalizationCheckbox.checked = false;
          }
  
          // STEP 4: Save consent state with all preferences as false (like decline behavior)
          const preferences = {
            analytics: false,
            marketing: false,
            personalization: false,
            bannerType: window.locationData ? window.locationData.bannerType : undefined
          };
  
          await setConsentState(preferences, cookieDays);
          updateGtagConsent(preferences);
  
          // STEP 5: Set consent as given and save to server
          localStorage.setItem("_cb_cg_", "true");
  
          try {
            await saveConsentStateToServer(preferences, cookieDays, false); // Exclude userAgent like decline
          } catch (error) {
            // Silent error handling
          }
        };
      }
      // Accept all
      const acceptBtn = document.getElementById('cb-accept-all-btn');
      if (acceptBtn) {
        acceptBtn.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          
          // IMMEDIATE UI RESPONSE: Hide banners synchronously
          hideBanner(document.getElementById("cb-initial-banner"));
          hideBanner(document.getElementById("cb-initial-banner"));
          hideBanner(document.getElementById("cb-preferences-banner"));
          hideBanner(document.getElementById("cb-preferences-banner"));
          hideBanner(document.getElementById("cb-initial-banner"));
          localStorage.setItem("_cb_cg_", "true");
          
          // CRITICAL: Update Google Consent Mode IMMEDIATELY and SYNCHRONOUSLY
          const preferences = { 
            analytics: true, 
            marketing: true, 
            personalization: true, 
            doNotShare: false, 
            action: 'acceptance', 
            bannerType: window.locationData ? window.locationData.bannerType : undefined 
          };
          updateGtagConsent(preferences);
          
          // Background operations (non-blocking)
          setTimeout(function() {
            // Enable scripts immediately for better UX
            enableAllScriptsWithDataCategory();
            
            // Do heavy operations in background
            Promise.all([
              setConsentState(preferences, cookieDays),
              saveConsentStateToServer(preferences, cookieDays, true)
            ]).catch(error => {
            });
          }, 0);
        };
      }
  
      // Reject all
      const declineBtn = document.getElementById('cb-reject-all-btn');
      if (declineBtn) {
        declineBtn.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          
          // IMMEDIATE UI RESPONSE: Hide banners synchronously
          hideBanner(document.getElementById("cb-initial-banner"));
          hideBanner(document.getElementById("cb-initial-banner"));
          hideBanner(document.getElementById("cb-preferences-banner"));
          hideBanner(document.getElementById("cb-preferences-banner"));
          hideBanner(document.getElementById("cb-initial-banner"));
          localStorage.setItem("_cb_cg_", "true");
          
          // CRITICAL: Update Consent Mode IMMEDIATELY and SYNCHRONOUSLY so GTM can respond
          const preferences = { 
            analytics: false, 
            marketing: false, 
            personalization: false, 
            doNotShare: true, 
            action: 'rejection', 
            bannerType: window.locationData ? window.locationData.bannerType : undefined 
          };
          updateGtagConsent(preferences);
          
          // Background operations (non-blocking)
          setTimeout(function() {
            // Block scripts with data-category immediately
            blockScriptsByCategory();
            
            // Only block scripts with data-category attribute (except Google scripts)
            // Scripts without data-category are allowed to run (functionality scripts)
            var allScripts = document.head.querySelectorAll('script[src]');
            allScripts.forEach(function (script) {
              // Skip Google scripts (they use Consent Mode)
              if (isGoogleScript(script)) {
                return;
              }
              
              // Only block scripts with data-category attribute (already handled by blockScriptsByCategory)
              // Scripts without data-category are allowed (functionality scripts)
              // No need to block them here - blockScriptsByCategory handles data-category scripts
            });
            
            // Block inline scripts in head section (only if they have data-category)
            var inlineScripts = document.head.querySelectorAll('script:not([src])');
            inlineScripts.forEach(function (script) {
              if (!script.innerHTML) return;
              
              // Don't block dataLayer initialization or gtag consent commands
              var isGoogleConsentScript = script.innerHTML && (
                script.innerHTML.includes('dataLayer') ||
                script.innerHTML.includes('gtag') ||
                script.innerHTML.includes('googletagmanager')
              );
              
              if (isGoogleConsentScript) {
                return; // Skip Google consent scripts
              }
              
              // Only block if script has data-category attribute (handled by blockScriptsByCategory)
              // Scripts without data-category are allowed (functionality scripts)
            });
            
            // Background operations (saving cookies, server calls, etc.)
            Promise.all([
              setConsentState(preferences, cookieDays),
              saveConsentStateToServer(preferences, cookieDays, false)
            ]).catch(error => {
            });
          }, 0);
        };
      }
  
      // Set up close buttons IMMEDIATELY
      setupConsentbitCloseButtons();
    
   
      
     
      // POST-BANNER OPERATIONS (after banner is visible)
      
      // 1. Enable scroll control
      await disableScrollOnSite();
      
      // 2. Check consent expiration
      checkConsentExpiration();
      
      // 3. Scan and send scripts (in background - deferred to avoid blocking)
      // Use requestIdleCallback if available, otherwise setTimeout to defer execution
      const currentToken = localStorage.getItem('_cb_vst_');
      if (currentToken) {
        const deferredExecution = () => {
          // Defer even more to ensure it doesn't block critical rendering
          setTimeout(() => {
            scanAndSendHeadScriptsIfChanged(currentToken)
              .catch(error => {
                // Silent error handling
              });
          }, 2000); // Wait 2 seconds after page load to avoid blocking
        };
        
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(deferredExecution, { timeout: 5000 });
        } else {
          // Fallback: defer by 2 seconds
          setTimeout(deferredExecution, 2000);
        }
      }
      
      let cookieDays = await fetchCookieExpirationDays();
      const prefs = await getConsentPreferences();
      updatePreferenceForm(prefs);
      
      // Initialize checkbox-us (always checked and disabled) for US preference banner
      // ONLY for emergent/sungreen clients
      if (isEmergentOrSungreen()) {
        function initializeCheckboxUs() {
          const checkboxUs = document.getElementById('cb-ccpa-optout');
          if (checkboxUs && !checkboxUs.hasAttribute('data-us-checkbox-initialized')) {
            checkboxUs.checked = true;
            checkboxUs.disabled = true;
            checkboxUs.setAttribute('data-us-checkbox-initialized', 'true');
            
            // Prevent unchecking even if user tries to interact
            checkboxUs.addEventListener('click', function(e) {
              e.preventDefault();
              checkboxUs.checked = true;
              return false;
            }, true);
            checkboxUs.addEventListener('change', function(e) {
              if (!checkboxUs.checked) {
                checkboxUs.checked = true;
              }
            }, true);
          }
        }
        
        // Initialize immediately
        initializeCheckboxUs();
        
        // Also initialize when main-banner-us is shown (in case it's added dynamically)
        const mainBannerUs = document.getElementById('cb-preferences-banner');
        if (mainBannerUs) {
          const observer = new MutationObserver(function() {
            initializeCheckboxUs();
          });
          observer.observe(mainBannerUs, { childList: true, subtree: true });
        }
      }

      if (isEmergent()) {
        await hideAllBanners();
      }
  
  
  
      
      // Do Not Share (CCPA) – #do-not-share-link: Emergent or non-Emergent, click shows main-consent-banner (preferences panel)
      const doNotShareBtn = document.getElementById('cb-ccpa-donotsell-link');
      if (doNotShareBtn) {
        doNotShareBtn.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          hideBanner(document.getElementById("cb-initial-banner"));
          const mainBanner = document.getElementById('cb-preferences-banner');
          if (mainBanner) {
            showBanner(mainBanner);
            setTimeout(function() {
              getConsentPreferences().then(preferences => {
                updateCCPAPreferenceForm(preferences);
              }).catch(error => {
                // Silent error handling
              });
            }, 0);
          }
        };
      }
  
            // CCPA Preference Accept button
        const ccpaPreferenceAcceptBtn = document.getElementById('cb-save-prefs-btn');
        if (ccpaPreferenceAcceptBtn) {
          ccpaPreferenceAcceptBtn.onclick = async function (e) {
            e.preventDefault();

            // IMMEDIATE UI RESPONSE: Hide banners first
            hideBanner(document.getElementById("cb-initial-banner"));
            const ccpaPreferencePanel = document.querySelector('.consentbit-ccpa_preference');
            hideBanner(ccpaPreferencePanel);
            const ccpaBannerDiv = document.querySelector('.consentbit-ccpa-banner-div');
            hideBanner(ccpaBannerDiv);
            localStorage.setItem("_cb_cg_", "true");

            // Read the do-not-share checkbox value
            const doNotShareCheckbox = document.getElementById('cb-ccpa-optout');
            let preferences;
            
            // CRITICAL: Update Google Consent Mode IMMEDIATELY based on checkbox state
  
            if (doNotShareCheckbox && doNotShareCheckbox.checked) {
              // Checkbox checked means "Do Not Share" - block based on US law type
              preferences = {
               
                doNotShare: true,  // Changed to camelCase to match server expectation
                doNotSell: true,   // Added to match server expectation
                action: 'rejection',
                bannerType: window.locationData ? window.locationData.bannerType : undefined
              };
              
              // CRITICAL: Update Google Consent Mode IMMEDIATELY
              updateGtagConsent(preferences);

              // For CCPA: Disable Webflow Analytics when "Do Not Share" is checked
              localStorage.setItem("_cb_cas_", "false");
              disableWebflowAnalytics();
  
              // Apply law-specific blocking based on banner type
              if (window.locationData && ["VCDPA", "CPA", "CTDPA", "UCPA"].includes(window.locationData.bannerType)) {
                // Enhanced privacy laws with granular opt-out requirements
                blockTargetedAdvertisingScripts();
                blockSaleScripts();
                blockProfilingScripts();
                blockCrossContextBehavioralAdvertising();
                blockAutomatedDecisionScripts();
              } else {
                // CCPA - block all scripts with data-category attribute
                blockScriptsWithDataCategory();
              }
            } else {
              // Checkbox unchecked means "Allow" - unblock all scripts
              preferences = {
               
                doNotShare: false,  // Changed to camelCase to match server expectation
                doNotSell: false,   // Added to match server expectation
                action: 'acceptance',
                bannerType: window.locationData ? window.locationData.bannerType : undefined
              };
              
              // CRITICAL: Update Google Consent Mode IMMEDIATELY
              updateGtagConsent(preferences);
              
              // For CCPA: Enable Webflow Analytics when "Do Not Share" is unchecked
              localStorage.setItem("_cb_cas_", "true");
              enableWebflowAnalytics();
              
              // Unblock all scripts
              unblockScriptsWithDataCategory();
  
              // Also unblock any scripts that might have been blocked by the initial blocking
              var allBlockedScripts = document.head.querySelectorAll('script[type="text/plain"][data-category]');
              allBlockedScripts.forEach(function (oldScript) {
                var newScript = document.createElement('script');
                for (var i = 0; i < oldScript.attributes.length; i++) {
                  var attr = oldScript.attributes[i];
                  if (attr.name === 'type') {
                    newScript.type = 'text/javascript';
                  } else {
                    newScript.setAttribute(attr.name, attr.value);
                  }
                }
                if (oldScript.innerHTML) {
                  newScript.innerHTML = oldScript.innerHTML;
                }
                oldScript.parentNode.replaceChild(newScript, oldScript);
              });
            }
  
            // Background operations - don't block UI
            Promise.all([
              setConsentState(preferences, cookieDays),
              saveConsentStateToServer(preferences, cookieDays, true)
            ]).catch(error => {
              // Silent error handling
            });
          };
        }
  
            // CCPA Preference Decline button
        const ccpaPreferenceDeclineBtn = document.getElementById('cb-reject-all-btn');
        if (ccpaPreferenceDeclineBtn) {
          ccpaPreferenceDeclineBtn.onclick = async function (e) {
            e.preventDefault();

            // IMMEDIATE UI RESPONSE: Hide banners and block scripts
            hideBanner(document.getElementById("cb-initial-banner"));
            const ccpaPreferencePanel = document.querySelector('.consentbit-ccpa_preference');
            hideBanner(ccpaPreferencePanel);
            const ccpaBannerDiv = document.querySelector('.consentbit-ccpa-banner-div');
            hideBanner(ccpaBannerDiv);
            localStorage.setItem("_cb_cg_", "true");
            localStorage.setItem("_cb_cas_", "false");
            
            // CRITICAL: Update Google Consent Mode IMMEDIATELY
            const preferences = {
              doNotShare: true,
              doNotSell: true,
              action: 'rejection',
              bannerType: window.locationData ? window.locationData.bannerType : undefined
            };
            updateGtagConsent(preferences);
            
            // Block scripts immediately
            blockScriptsByCategory();
            disableWebflowAnalytics();
  
            Promise.all([
              setConsentState(preferences, cookieDays),
              saveConsentStateToServer(preferences, cookieDays, true)
            ]).catch(error => {
              // Silent error handling
            });
          };
        }
  
            // Save button (CCPA) – also handled by document-level delegated handler if element missing at init
      const saveBtn = document.getElementById('cb-save-prefs-btn');
        if (saveBtn) {
          saveBtn.onclick = async function (e) {
            e.preventDefault();
            // IMMEDIATE UI RESPONSE: Hide banners and container first so banner closes
            const mainConsentBanner = document.getElementById('cb-preferences-banner');
            const initialConsentBanner = document.getElementById('cb-initial-banner');
            if (mainConsentBanner) await hideBanner(mainConsentBanner);
            if (initialConsentBanner) await hideBanner(initialConsentBanner);
            var container = document.getElementById('cb-initial-banner');
            if (container) {
              container.style.setProperty('display', 'none', 'important');
              container.style.setProperty('visibility', 'hidden', 'important');
              container.style.setProperty('opacity', '0', 'important');
            }
            if (typeof isEmergent === 'function' && isEmergent()) document.body.removeAttribute('data-consentbit-emergent-showing');
            localStorage.setItem("_cb_cg_", "true");
  
            // Read the do-not-share checkbox value
            const doNotShareCheckbox = document.getElementById('cb-ccpa-optout');
            let preferences;
            let includeUserAgent;
  
            if (doNotShareCheckbox && doNotShareCheckbox.checked) {
              // Checkbox checked means "Do Not Share" - block all scripts and restrict userAgent
              preferences = {
               
                doNotShare: true,  // Changed to camelCase to match server expectation
                doNotSell: true,   // Added to match server expectation
                action: 'rejection',
                bannerType: window.locationData ? window.locationData.bannerType : undefined
              };
              includeUserAgent = false; // Restrict userAgent
              
              // CRITICAL: Update Google Consent Mode IMMEDIATELY
              updateGtagConsent(preferences);
              
              // For CCPA: Disable Webflow Analytics when "Do Not Share" is checked
              localStorage.setItem("_cb_cas_", "false");
              disableWebflowAnalytics();
            } else {
              // Checkbox unchecked means "Allow" - unblock all scripts and allow userAgent
              preferences = {
                
                doNotShare: false,  // Changed to camelCase to match server expectation
                doNotSell: false,   // Added to match server expectation
                action: 'acceptance',
                bannerType: window.locationData ? window.locationData.bannerType : undefined
              };
              includeUserAgent = true; // Allow userAgent
              
              // CRITICAL: Update Google Consent Mode IMMEDIATELY
              updateGtagConsent(preferences);
              
              // For CCPA: Enable Webflow Analytics when "Do Not Share" is unchecked
              localStorage.setItem("_cb_cas_", "true");
              enableWebflowAnalytics();
            }
  
            // Handle script blocking/unblocking immediately
            if (doNotShareCheckbox && doNotShareCheckbox.checked) {
              blockScriptsWithDataCategory();
            } else {
              unblockScriptsWithDataCategory();
            }
  
            // Background operations
            Promise.all([
              setConsentState(preferences, cookieDays),
              saveConsentStateToServer(preferences, cookieDays, includeUserAgent)
            ]).catch(error => {
              // Silent error handling
            });
          };
        }
  
      // Save Preferences button
      const savePreferencesBtn = document.getElementById('cb-save-prefs-btn');
      if (savePreferencesBtn) {
        savePreferencesBtn.onclick = async function (e) {
          e.preventDefault();
          
          // IMMEDIATE UI RESPONSE: Hide banners first
          hideBanner(document.getElementById("cb-preferences-banner"));
          hideBanner(document.getElementById("cb-initial-banner"));
          hideBanner(document.getElementById("cb-initial-banner"));
          localStorage.setItem("_cb_cg_", "true");
          
          // Read checkboxes and handle scripts immediately
          const analytics = !!(document.getElementById('cb-pref-analytics') && document.getElementById('cb-pref-analytics').checked);
          const marketing = !!(document.getElementById('cb-pref-marketing') && document.getElementById('cb-pref-marketing').checked);
          const personalization = !!(document.getElementById('cb-pref-preferences') && document.getElementById('cb-pref-preferences').checked);
          
          // CRITICAL: Update Consent Mode IMMEDIATELY and SYNCHRONOUSLY so GTM can respond
          const preferences = {
            analytics: analytics,
            marketing: marketing,
            personalization: personalization,
            action: (analytics || marketing || personalization) ? 'acceptance' : 'rejection',
            bannerType: window.locationData ? window.locationData.bannerType : undefined
          };
          updateGtagConsent(preferences);
          
          // Block ALL scripts first, then enable selected categories
          blockScriptsByCategory();
          const selectedCategories = [];
          if (analytics) selectedCategories.push('analytics');
          if (marketing) selectedCategories.push('marketing');
          if (personalization) selectedCategories.push('personalization');
          
          if (selectedCategories.length > 0) {
            enableScriptsByCategories(selectedCategories);
            
            // Also unblock ALL other scripts that were blocked (including those without data-category)
            // Change type from text/plain to text/javascript and remove blocking attributes
            var allBlockedScripts = document.head.querySelectorAll('script[type="text/plain"]');
            allBlockedScripts.forEach(function (script) {
              // Unblock all scripts (they were blocked before consent)
              if (script.src) {
                try {
                  const existingScript = document.querySelector(`script[src="${script.src}"][type="text/javascript"]`);
                  if (existingScript) {
                    script.remove();
                    return;
                  }
                  
                  const newScript = document.createElement('script');
                  for (let attr of script.attributes) {
                    if (attr.name !== 'type') {
                      newScript.setAttribute(attr.name, attr.value);
                    }
                  }
                  newScript.type = 'text/javascript';
                  newScript.onload = function() {
                    ensureGtagInitialization();
                  };
                  script.parentNode.insertBefore(newScript, script);
                  script.remove();
                } catch (error) {
                  // Fallback: just change type if creating new script fails
                  script.type = 'text/javascript';
                }
              } else {
                // For inline scripts, just change type
                script.type = 'text/javascript';
                
                if (script.innerHTML) {
                  try {
                    eval(script.innerHTML);
                  } catch (e) {
                  }
                }
              }
            });
          }
  
          // Background operations (saving cookies, server calls, etc.)
          Promise.all([
            setConsentState(preferences, cookieDays),
            saveConsentStateToServer(preferences, cookieDays, true)
          ]).catch(error => {
            // Silent error handling
          });
        };
      }
  
      // Cancel button handler is already set up earlier (before async operations)
  
      // ========================================
      // US BANNER BUTTON HANDLERS (for emergent/sungreen non-California US visitors)
      // ========================================
      
      // Decline button (US banner) - same as CCPA decline button (reject all)
      // ONLY for emergent/sungreen clients
      const declineBtnUs = document.getElementById('cb-reject-all-btn');
      if (declineBtnUs && isEmergentOrSungreen()) {
        declineBtnUs.onclick = async function (e) {
          e.preventDefault();

          // IMMEDIATE UI RESPONSE: Hide banners and block scripts
          hideBanner(document.getElementById("cb-initial-banner"));
          hideBanner(document.getElementById('cb-preferences-banner'));
          localStorage.setItem("_cb_cg_", "true");
          localStorage.setItem("_cb_cas_", "false");
          
          // CRITICAL: Update Google Consent Mode IMMEDIATELY
          const preferences = {
            doNotShare: true,
            doNotSell: true,
            action: 'rejection',
            bannerType: window.locationData ? window.locationData.bannerType : undefined
          };
          updateGtagConsent(preferences);
          
          // Block scripts immediately
          blockScriptsWithDataCategory();
          disableWebflowAnalytics();

          Promise.all([
            setConsentState(preferences, cookieDays),
            saveConsentStateToServer(preferences, cookieDays, true)
          ]).catch(error => {
            // Silent error handling
          });
        };
      }
      
      // Accept button (US banner) - same as CCPA save-btn (accept all - doNotShare=false)
      // ONLY for emergent/sungreen clients
      const acceptBtnUs = document.getElementById('cb-accept-all-btn');
      if (acceptBtnUs && isEmergentOrSungreen()) {
        acceptBtnUs.onclick = async function (e) {
          e.preventDefault();

          // IMMEDIATE UI RESPONSE: Hide banners first
          hideBanner(document.getElementById("cb-initial-banner"));
          hideBanner(document.getElementById('cb-preferences-banner'));
          localStorage.setItem("_cb_cg_", "true");

          // Accept all - same as CCPA save-btn when do-not-share is unchecked
          const preferences = {
            doNotShare: false,
            doNotSell: false,
            action: 'acceptance',
            bannerType: window.locationData ? window.locationData.bannerType : undefined
          };
          
          // CRITICAL: Update Google Consent Mode IMMEDIATELY
          updateGtagConsent(preferences);
          
          // For CCPA: Enable Webflow Analytics when "Do Not Share" is unchecked
          localStorage.setItem("_cb_cas_", "true");
          enableWebflowAnalytics();
          
          // Unblock all scripts
          unblockScriptsWithDataCategory();

          // Also unblock any scripts that might have been blocked by the initial blocking
          var allBlockedScripts = document.head.querySelectorAll('script[type="text/plain"][data-category]');
          allBlockedScripts.forEach(function (oldScript) {
            var newScript = document.createElement('script');
            for (var i = 0; i < oldScript.attributes.length; i++) {
              var attr = oldScript.attributes[i];
              if (attr.name === 'type') {
                newScript.type = 'text/javascript';
              } else {
                newScript.setAttribute(attr.name, attr.value);
              }
            }
            if (oldScript.innerHTML) {
              newScript.innerHTML = oldScript.innerHTML;
            }
            oldScript.parentNode.replaceChild(newScript, oldScript);
          });

          // Background operations
          Promise.all([
            setConsentState(preferences, cookieDays),
            saveConsentStateToServer(preferences, cookieDays, true)
          ]).catch(error => {
            // Silent error handling
          });
        };
      }
      
      // Preferences button (US banner) - show main-banner-us
      // ONLY for emergent/sungreen clients
      const preferencesBtnUs = document.getElementById('cb-preferences-btn');
      if (preferencesBtnUs && isEmergentOrSungreen()) {
        preferencesBtnUs.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          
          // IMMEDIATE UI RESPONSE - synchronous
          const usBanner = document.getElementById("cb-initial-banner");
          const mainBannerUs = document.getElementById('cb-preferences-banner');
          if (usBanner) hideBanner(usBanner);
          if (mainBannerUs) {
            showBanner(mainBannerUs);
          }
          
          // Initialize checkbox-us immediately (always checked and disabled)
          const checkboxUs = document.getElementById('cb-ccpa-optout');
          if (checkboxUs && !checkboxUs.hasAttribute('data-us-checkbox-initialized')) {
            checkboxUs.checked = true;
            checkboxUs.disabled = true;
            checkboxUs.setAttribute('data-us-checkbox-initialized', 'true');
            
            // Prevent unchecking even if user tries to interact
            checkboxUs.addEventListener('click', function(e) {
              e.preventDefault();
              checkboxUs.checked = true;
              return false;
            }, true);
            checkboxUs.addEventListener('change', function(e) {
              if (!checkboxUs.checked) {
                checkboxUs.checked = true;
              }
            }, true);
          } else if (checkboxUs) {
            // Ensure it's still checked even if already initialized
            checkboxUs.checked = true;
            checkboxUs.disabled = true;
          }
          
          // Background operations (non-blocking)
          setTimeout(function() {
            getConsentPreferences().then(preferences => {
              updatePreferenceForm(preferences);
            }).catch(error => {
              // Silent error handling
            });
          }, 0);
        };
      }
      
      // Cancel button (US banner) - same as CCPA decline button (reject all)
      // ONLY for emergent/sungreen clients
      const cancelBtnUs = document.getElementById('cb-cancel-prefs-btn');
      if (cancelBtnUs && isEmergentOrSungreen()) {
        cancelBtnUs.onclick = async function (e) {
          e.preventDefault();

          // IMMEDIATE UI RESPONSE: Hide banners and block scripts
          hideBanner(document.getElementById("cb-preferences-banner"));
          hideBanner(document.getElementById("cb-initial-banner"));
          localStorage.setItem("_cb_cg_", "true");
          localStorage.setItem("_cb_cas_", "false");
          
          // CRITICAL: Update Google Consent Mode IMMEDIATELY
          const preferences = {
            doNotShare: true,
            doNotSell: true,
            action: 'rejection',
            bannerType: window.locationData ? window.locationData.bannerType : undefined
          };
          updateGtagConsent(preferences);
          
          // Block scripts immediately
          blockScriptsWithDataCategory();
          disableWebflowAnalytics();

          Promise.all([
            setConsentState(preferences, cookieDays),
            saveConsentStateToServer(preferences, cookieDays, true)
          ]).catch(error => {
            // Silent error handling
          });
        };
      }
      
      // Save Preferences button (US banner) - same as CCPA save-btn (read do-not-share checkbox)
      // ONLY for emergent/sungreen clients
      const savePreferencesBtnUs = document.getElementById('cb-save-prefs-btn');
      if (savePreferencesBtnUs && isEmergentOrSungreen()) {
        savePreferencesBtnUs.onclick = async function (e) {
          e.preventDefault();

          // IMMEDIATE UI RESPONSE: Hide banners first
          hideBanner(document.getElementById("cb-initial-banner"));
          hideBanner(document.getElementById('cb-preferences-banner'));
          localStorage.setItem("_cb_cg_", "true");

          // Read the do-not-share checkbox value (same as CCPA save-btn)
          const doNotShareCheckbox = document.getElementById('cb-ccpa-optout');
          let preferences;
          let includeUserAgent;

          if (doNotShareCheckbox && doNotShareCheckbox.checked) {
            // Checkbox checked means "Do Not Share" - block all scripts and restrict userAgent
            preferences = {
              doNotShare: true,
              doNotSell: true,
              action: 'rejection',
              bannerType: window.locationData ? window.locationData.bannerType : undefined
            };
            includeUserAgent = false; // Restrict userAgent
            
            // CRITICAL: Update Google Consent Mode IMMEDIATELY
            updateGtagConsent(preferences);
            
            // For CCPA: Disable Webflow Analytics when "Do Not Share" is checked
            localStorage.setItem("_cb_cas_", "false");
            disableWebflowAnalytics();
          } else {
            // Checkbox unchecked means "Allow" - unblock all scripts and allow userAgent
            preferences = {
              doNotShare: false,
              doNotSell: false,
              action: 'acceptance',
              bannerType: window.locationData ? window.locationData.bannerType : undefined
            };
            includeUserAgent = true; // Allow userAgent
            
            // CRITICAL: Update Google Consent Mode IMMEDIATELY
            updateGtagConsent(preferences);
            
            // For CCPA: Enable Webflow Analytics when "Do Not Share" is unchecked
            localStorage.setItem("_cb_cas_", "true");
            enableWebflowAnalytics();
          }

          // Handle script blocking/unblocking immediately
          if (doNotShareCheckbox && doNotShareCheckbox.checked) {
            blockScriptsWithDataCategory();
          } else {
            unblockScriptsWithDataCategory();
          }

          // Background operations
          Promise.all([
            setConsentState(preferences, cookieDays),
            saveConsentStateToServer(preferences, cookieDays, includeUserAgent)
          ]).catch(error => {
            // Silent error handling
          });
        };
      }
  
      // Universal close button handler - handles both consentbit="close" and id="close-consent-banner"
   async   function setupConsentbitCloseButtons() {
        // Handle elements with consentbit="close" attribute
        const closeButtons = document.querySelectorAll('[consentbit="close"]');
        closeButtons.forEach(function (closeBtn) {
          // Check if handler already attached (to avoid duplicates)
          if (closeBtn.hasAttribute('data-close-handler-attached')) {
            return;
          }
          
          // Mark as handled
          closeBtn.setAttribute('data-close-handler-attached', 'true');
          
          closeBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
  
            // IMMEDIATE RESPONSE: Find and hide the currently visible banner synchronously
            // Check banners in order of likelihood for faster response
            const bannerIds = [
              "cb-initial-banner",
              "cb-preferences-banner"
            ];
            
            let activeBanner = null;
            
            // First check by ID (faster)
            for (let i = 0; i < bannerIds.length; i++) {
              const banner = document.getElementById(bannerIds[i]);
              if (banner) {
                const style = window.getComputedStyle(banner);
                if (style.display !== 'none' && 
                    style.visibility !== 'hidden' && 
                    style.opacity !== '0') {
                  activeBanner = banner;
                  break;
                }
              }
            }
            
            // If not found by ID, check by class (slower, but needed for some banners)
            if (!activeBanner) {
              const classSelectors = [
                '.consentbit-ccpa-banner-div',
                '.consentbit-ccpa_preference',
                '.consentbit-gdpr-banner-div',
                '.consentbit-preference_div',
                '#main-banner-us'
              ];
              
              for (let i = 0; i < classSelectors.length; i++) {
                const banner = document.querySelector(classSelectors[i]);
                if (banner) {
                  const style = window.getComputedStyle(banner);
                  if (style.display !== 'none' && 
                      style.visibility !== 'hidden' && 
                      style.opacity !== '0') {
                    
                    // Special case: If consentbit-preference_div is visible, prioritize its parent main-banner
                    if (banner.classList.contains('consentbit-preference_div')) {
                      const mainBanner = document.getElementById('cb-preferences-banner');
                      if (mainBanner) {
                        const mainStyle = window.getComputedStyle(mainBanner);
                        if (mainStyle.display !== 'none' &&
                            mainStyle.visibility !== 'hidden' &&
                            mainStyle.opacity !== '0') {
                          activeBanner = mainBanner;
                          break;
                        }
                      }
                    }
                    
                    activeBanner = banner;
                    break;
                  }
                }
              }
            }
            
            // Hide the banner immediately (synchronous)
            if (activeBanner) {
              hideBanner(activeBanner);
            }
          }, true);
        });
        
        // Also handle elements with id="close-consent-banner" (handles duplicate IDs)
        const cancelBtns = document.querySelectorAll('#close-consent-banner');
        cancelBtns.forEach(function(cancelBtn) {
          // Skip if already handled above (has consentbit="close")
          if (cancelBtn.hasAttribute('data-close-handler-attached')) {
            return;
          }
          
          // Mark as handled
          cancelBtn.setAttribute('data-close-handler-attached', 'true');
          
          cancelBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
  
            // Find the currently visible banner by checking all possible banner elements
            const banners = [
              document.getElementById("cb-initial-banner"),
              document.getElementById("cb-initial-banner"),
              document.getElementById("cb-preferences-banner"),
              document.getElementById("cb-preferences-banner"),
              document.getElementById("cb-initial-banner"),
              document.getElementById("cb-initial-banner"),
              document.querySelector('.consentbit-ccpa-banner-div'),
              document.querySelector('.consentbit-ccpa_preference'),
              document.querySelector('.consentbit-gdpr-banner-div'),
              document.querySelector('.consentbit-preference_div'),
              document.getElementById('cb-preferences-banner'),
            ];
  
            // Find the currently visible banner
            let activeBanner = null;
            banners.forEach(function (banner) {
              if (banner && window.getComputedStyle(banner).display !== 'none' &&
                window.getComputedStyle(banner).visibility !== 'hidden' &&
                window.getComputedStyle(banner).opacity !== '0') {
                
                // Special case: If consentbit-preference_div is visible, prioritize its parent main-banner
                if (banner.classList.contains('consentbit-preference_div')) {
                  const mainBanner = document.getElementById('cb-preferences-banner');
                  if (mainBanner && window.getComputedStyle(mainBanner).display !== 'none' &&
                    window.getComputedStyle(mainBanner).visibility !== 'hidden' &&
                    window.getComputedStyle(mainBanner).opacity !== '0') {
                    activeBanner = mainBanner; // Use parent main-banner instead
                    return;
                  }
                }
                
                activeBanner = banner;
              }
            });
            
            // Hide the currently active banner
            if (activeBanner) {
              hideBanner(activeBanner);
            }
          }, true);
        });
      }
  
      // Universal "Do Not Share" link with consentbit-data-donotshare="consentbit-link-donotshare" attribute
   function setupDoNotShareLinks() {
  const doNotShareLinks = document.querySelectorAll(
    '[consentbit-data-donotshare="consentbit-link-donotshare"]'
  );

  doNotShareLinks.forEach(function (link) {
    link.onclick = async function (e) {
      e.preventDefault();

      // Hide all other banners first
     await hideAllBanners();

      // 1) Emergent: pure opt‑out → show CCPA initial banner only on click
      if (isEmergent()) {
        const ccpaInitial = document.getElementById('cb-initial-banner');
        if (!ccpaInitial) {
          // no-op (previously logged)
        } else {
          var earlyHide = document.getElementById('consentbit-emergent-hide-on-load');
          if (earlyHide && earlyHide.parentNode) {
            earlyHide.parentNode.removeChild(earlyHide);
          }
          showBanner(ccpaInitial);
          try {
            const preferences = await getConsentPreferences();
            if (typeof updateCCPAPreferenceForm === 'function') {
              updateCCPAPreferenceForm(preferences || {});
            }
          } catch (err) {
            // ignore
          }
        }
        return; // Do not run location logic
      }

      // 2) Non‑Emergent: keep location-based logic

      // Check for data-all-banners attribute first
      const allBannersElement = document.querySelector('[data-all-banners]');
      const allBannersValue = allBannersElement
        ? allBannersElement.getAttribute('data-all-banners')
        : null;

      if (allBannersValue === 'false') {
        // Force GDPR banner when data-all-banners="false"
        if (isEmergent()) {
          await hideAllBanners();
          return;
        }
        showGDPRBanner();
        return;
      }
        if (isEmergent()) {
          await hideAllBanners();
          return;
        }

      // data-all-banners="true" or missing → wait for location detection
      const currentLocationData = await window.getLocationData();

      if (currentLocationData && currentLocationData.bannerType) {
        // SPECIAL LOGIC: Emergent/Sungreen (non‑Emergent here means Sungreen) + US
        if (isEmergent()) {
          await hideAllBanners();
          return;
        }
        if (
          isEmergentOrSungreen() &&
          currentLocationData.country === 'US'
        ) {
          const state = currentLocationData.state;
          const isCalifornia =
            state === 'CA' ||
            state === 'California' ||
            (state && state.toUpperCase() === 'CA');

          const shouldShowCCPA =
            isCalifornia || currentLocationData.bannerType === 'CCPA';

          if (shouldShowCCPA) {
          
            const ccpaBanner = document.getElementById('cb-initial-banner');
            if (ccpaBanner) {
              showBanner(ccpaBanner);
              const preferences = await getConsentPreferences();
              updateCCPAPreferenceForm(preferences);
            }
          } else {
            const usBanner = document.getElementById('cb-initial-banner');
            if (usBanner) {
              showBanner(usBanner);
              const preferences = await getConsentPreferences();
              updatePreferenceForm(preferences);
            } else {
              const initialCCPABanner =
                document.getElementById('cb-initial-banner');
              const mainConsentBanner =
                document.getElementById('cb-preferences-banner');

              if (initialCCPABanner) {
                showBanner(initialCCPABanner);
                const preferences = await getConsentPreferences();
                updateCCPAPreferenceForm(preferences);
              } else if (mainConsentBanner) {
                showBanner(mainConsentBanner);
                const preferences = await getConsentPreferences();
                updateCCPAPreferenceForm(preferences);
              } else {
                showGDPRBanner();
              }
            }
          }
          return; // Exit early - don't check other conditions for Emergent/Sungreen US
        }

        // Other US privacy laws → CCPA model
        if (
          ['CCPA', 'VCDPA', 'CPA', 'CTDPA', 'UCPA'].includes(
            currentLocationData.bannerType
          ) ||
          currentLocationData.country === 'US'
        ) {
          if(isEmergent()){
            
            await hideAllBanners();
            return;
          }
          const ccpaBanner = document.getElementById('cb-preferences-banner');
          if (ccpaBanner) {
            showBanner(ccpaBanner);
            const preferences = await getConsentPreferences();
            updateCCPAPreferenceForm(preferences);
          }
        } else {
          // Non‑US → GDPR banner
          showGDPRBanner();
        }
      }
      // If location detection fails, do nothing (no banner)
    };
  });
}

  
      // Set up close buttons and do not share links when DOM is ready
      setupConsentbitCloseButtons();
      setupDoNotShareLinks();

      // Monitor for dynamically added close buttons and do not share links
      const closeButtonObserver = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
          mutation.addedNodes.forEach(function (node) {
            if (node.nodeType === 1) {
              // Check if the added node is a close button (consentbit="close" or id="close-consent-banner")
              if (node.hasAttribute && node.hasAttribute('consentbit') && node.getAttribute('consentbit') === 'close') {
                setupConsentbitCloseButtons();
              }
              // Check if the added node has id="close-consent-banner"
              if (node.id === 'close-consent-banner') {
                setupConsentbitCloseButtons();
              }
              // Check if any child elements are close buttons
              const closeButtons = node.querySelectorAll && node.querySelectorAll('[consentbit="close"], #close-consent-banner');
              if (closeButtons && closeButtons.length > 0) {
                setupConsentbitCloseButtons();
              }
  
              // Check if the added node is a do not share link
              if (node.hasAttribute && node.hasAttribute('consentbit-data-donotshare') && node.getAttribute('consentbit-data-donotshare') === 'consentbit-link-donotshare') {
                setupDoNotShareLinks();
              }
              
  
            }
          });
        });
      });
  
      // Start observing for dynamically added close buttons and do not share links
      closeButtonObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
  
      // CCPA Link Block - Show CCPA Banner (only if data-all-banners is not "false")
      const ccpaLinkBlock = document.getElementById('cb-ccpa-donotsell-link');
      if (ccpaLinkBlock) {
        ccpaLinkBlock.onclick = function (e) {
          e.preventDefault();
  
          // Check data-all-banners attribute - if "false", show GDPR banner instead
          const allBannersElement = document.querySelector('[data-all-banners]');
          const hasAllBannersAttribute = allBannersElement && allBannersElement.hasAttribute('data-all-banners');
          const allBannersValue = hasAllBannersAttribute ? allBannersElement.getAttribute('data-all-banners') : null;
          
          if (hasAllBannersAttribute && allBannersValue === 'false') {
            // Show GDPR banner when data-all-banners="false"
            showGDPRBanner();
          } else {
            // Show CCPA banner only when data-all-banners is not "false"
            const ccpaBannerDiv = document.querySelector('.consentbit-ccpa-banner-div');
            if(isEmergent()){
              // If user clicked the attribute link only (consentbit-data-donotshare), don't re-hide – the link handler already showed initial-consent-banner
              if (e.target && e.target.closest && e.target.closest('[consentbit-data-donotshare="consentbit-link-donotshare"]')) {
                return;
              }
              hideAllBanners();
              hideBanner(ccpaBannerDiv);
              return;
            }
            showBanner(ccpaBannerDiv);
            
            // Also show the CCPA banner if it exists
            showBanner(document.getElementById("cb-initial-banner"));
          }
        };
      }
  
      // If consent is already given, hide all banners and do not show any
      if (consentGiven === "true") {
        await hideAllBanners();
  
        // Unblock scripts based on saved consent preferences
        const savedPreferences = await getConsentPreferences();
        
        // CRITICAL FIX: Update Google consent state with saved preferences
        updateGtagConsent(savedPreferences);
        
        // CRITICAL: Ensure GA4 tracks page view for returning visitors
        // This is important because returning visitors might have missed the initial page view
        if (savedPreferences.analytics) {
          setTimeout(function() {
            if (typeof window.gtag === 'function') {
              try {
                // Send page view event to ensure returning visitor is tracked
                window.gtag('event', 'page_view', {
                  'page_title': document.title,
                  'page_location': window.location.href,
                  'page_path': window.location.pathname + window.location.search
                });
              } catch (e) {
                // Silent error handling
              }
            }
          }, 200);
        }
        
        // CRITICAL FIX: Initialize Webflow Analytics based on saved consent
        if (savedPreferences.analytics) {
          enableWebflowAnalytics();
        } else {
          disableWebflowAnalytics();
        }
        
        // CRITICAL FIX: Handle case where no consent is given (all denied)
        if (!savedPreferences.analytics && !savedPreferences.marketing && !savedPreferences.personalization) {
          // Block all scripts if no consent is given
          blockScriptsByCategory();
        } else if (savedPreferences.analytics || savedPreferences.marketing || savedPreferences.personalization) {
          // If any consent is given, unblock appropriate scripts
          const selectedCategories = Object.keys(savedPreferences).filter(k => savedPreferences[k] && k !== 'doNotShare');
          if (selectedCategories.length > 0) {
            enableScriptsByCategories(selectedCategories);
  
            // Also unblock any scripts that might have been blocked
            var allBlockedScripts = document.head.querySelectorAll('script[type="text/plain"][data-category]');
            allBlockedScripts.forEach(function (oldScript) {
              var category = oldScript.getAttribute('data-category');
              if (category) {
                var categories = category.split(',').map(function (cat) { return cat.trim(); });
                var shouldEnable = categories.some(function (cat) {
                  return selectedCategories.includes(cat);
                });
                if (shouldEnable) {
                  var newScript = document.createElement('script');
                  for (var i = 0; i < oldScript.attributes.length; i++) {
                    var attr = oldScript.attributes[i];
                    if (attr.name === 'type') {
                      newScript.type = 'text/javascript';
                    } else {
                      newScript.setAttribute(attr.name, attr.value);
                    }
                  }
                  if (oldScript.innerHTML) {
                    newScript.innerHTML = oldScript.innerHTML;
                  }
                  oldScript.parentNode.replaceChild(newScript, oldScript);
                }
              }
            });
          }
        }
  
        // Do not show any banner unless user clicks the icon
        return;
      }
  
      // Banner already shown earlier - just handle server location data if available
      if (!consentGiven) {
        // Check data-all-banners attribute first
        if(isEmergent()){
          await hideAllBanners();
          return;
        }
        const allBannersElement = document.querySelector('[data-all-banners]');
        const hasAllBannersAttribute = allBannersElement && allBannersElement.hasAttribute('data-all-banners');
        const allBannersValue = hasAllBannersAttribute ? allBannersElement.getAttribute('data-all-banners') : null;
        
        // If data-all-banners="false", skip location-based banner display (GDPR already shown)
        if (hasAllBannersAttribute && allBannersValue === 'false') {
          // GDPR banner already shown, skip CCPA banner display
          return;
        }
        
        // Also handle server-detected location data  
        if (window.locationData && window.locationData.bannerType) {
          if (["CCPA", "VCDPA", "CPA", "CTDPA", "UCPA"].includes(window.locationData.bannerType)) {
            // US Privacy Laws: Ensure all scripts are unblocked initially (opt-out model)
            // For CCPA, scripts should start as text/javascript, not text/plain
            
            // CRITICAL: First, ensure all Google scripts are unblocked
            unblockGoogleScripts();
            
            // First remove any duplicate scripts
            removeDuplicateScripts();
            
            var allBlockedScripts = document.head.querySelectorAll('script[type="text/plain"][data-category]');
          
          allBlockedScripts.forEach(function (script) {
            // Skip Google scripts - they're already handled by unblockGoogleScripts()
            if (isGoogleScript(script)) {
              return; // Skip Google scripts
            }
            // Re-execute the script if it has a src attribute
            if (script.src) {
              try {
                // Check if a script with this src already exists and is enabled
                const existingScript = document.querySelector(`script[src="${script.src}"][type="text/javascript"]`);
                if (existingScript) {
                  // Just remove the blocked version
                  script.remove();
                  return;
                }
                
                // Create a new script element to force re-execution
                const newScript = document.createElement('script');
                
                // Copy all attributes except type
                for (let attr of script.attributes) {
                  if (attr.name !== 'type') {
                    newScript.setAttribute(attr.name, attr.value);
                  }
                }
                
                // Ensure proper type
                newScript.type = 'text/javascript';
                
                // Insert the new script before the old one, then remove the old one
                script.parentNode.insertBefore(newScript, script);
                script.remove();
              } catch (error) {
                // Error re-executing script
              }
            } else {
              // For inline scripts, just change the type
              script.type = 'text/javascript';
            }
          });
  
          // Also unblock any scripts that might have been blocked by initial blocking
          var allBlockedScripts2 = document.head.querySelectorAll('script[type="text/plain"]');
          allBlockedScripts2.forEach(function (script) {
            // Skip Google scripts - they're already handled by unblockGoogleScripts()
            if (isGoogleScript(script)) {
              return; // Skip Google scripts
            }
            // Re-execute the script if it has a src attribute
            if (script.src) {
              try {
                // Check if a script with this src already exists and is enabled
                const existingScript = document.querySelector(`script[src="${script.src}"][type="text/javascript"]`);
                if (existingScript) {
                  // Just remove the blocked version
                  script.remove();
                  return;
                }
                
                // Create a new script element to force re-execution
                const newScript = document.createElement('script');
                
                // Copy all attributes except type
                for (let attr of script.attributes) {
                  if (attr.name !== 'type') {
                    newScript.setAttribute(attr.name, attr.value);
                  }
                }
                
                // Ensure proper type
                newScript.type = 'text/javascript';
                
                // Insert the new script before the old one, then remove the old one
                script.parentNode.insertBefore(newScript, script);
                  script.remove();
              } catch (error) {
                // Error re-executing script
              }
            } else {
              // For inline scripts, just change the type
              script.type = 'text/javascript';
            }
          });
  
                    // For CCPA/US Privacy Laws: Scripts start enabled but banner must be shown
            // User must explicitly accept or decline through banner interaction
            // BUT: If data-all-banners="false", show GDPR banner instead of CCPA

          // Check data-all-banners attribute - if "false", show GDPR banner instead
          const allBannersElementCheck = document.querySelector('[data-all-banners]');
          const hasAllBannersAttributeCheck = allBannersElementCheck && allBannersElementCheck.hasAttribute('data-all-banners');
          const allBannersValueCheck = hasAllBannersAttributeCheck ? allBannersElementCheck.getAttribute('data-all-banners') : null;
          
          if (hasAllBannersAttributeCheck && allBannersValueCheck === 'false') {
            // Show GDPR banner when data-all-banners="false" (even if location is CCPA)
            showBanner(document.getElementById("cb-initial-banner"));
            hideBanner(document.getElementById("cb-initial-banner"));
          } else {
           
            if (isEmergent()) {
              await hideAllBanners();
              return;
            }
            showBanner(document.getElementById("cb-initial-banner"));
            hideBanner(document.getElementById("cb-initial-banner"));
          }
  
  
                } else {
            // Show GDPR banner (default for EU and other locations)
            showBanner(document.getElementById("cb-initial-banner"));
            hideBanner(document.getElementById("cb-initial-banner"));
            blockScriptsByCategory();
          }
        }
      }
  
  
  
      
     
      initializeWebflowAnalytics();
      monitorConsentChanges();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', __cbInit);
    } else {
      __cbInit();
    }


    function unblockScriptsWithDataCategory() {
      unblockGoogleScripts();
      
   
      var scripts = document.head.querySelectorAll('script[type="text/plain"][data-category]');
      scripts.forEach(function (script) {
      
        if (isGoogleScript(script)) {
          return; // Skip Google scripts
        }
        
     
        if (script.src) {
          try {
         
            const existingScript = document.querySelector(`script[src="${script.src}"][type="text/javascript"]`);
            if (existingScript) {
              // Just remove the blocked version
              script.remove();
              return;
            }
            
           
            const newScript = document.createElement('script');
            
        
            for (let attr of script.attributes) {
              if (attr.name !== 'type' && 
                  attr.name !== 'type') {
                newScript.setAttribute(attr.name, attr.value);
              }
            }
            
           
            newScript.type = 'text/javascript';
            
            // Insert the new script before the old one, then remove the old one
            script.parentNode.insertBefore(newScript, script);
            script.remove();
          } catch (error) {
            // Silent error handling
          }
        } else {
          // For inline scripts, just change the type
          script.type = 'text/javascript';
          
          // Execute the script if it has inline content
          if (script.innerHTML) {
            try {
              eval(script.innerHTML);
            } catch (e) {
              // Silent error handling
            }
          }
        }
      });
      
      // Ensure gtag is properly initialized after all scripts are loaded
      setTimeout(ensureGtagInitialization, 100);
    }
  
    function blockScriptsWithDataCategory() {
      // CRITICAL: First, ensure all Google scripts are unblocked
      unblockGoogleScripts();
      
      // CCPA: Block ALL scripts with data-category attribute (except Google scripts) in head section only
      var scripts = document.head.querySelectorAll('script[data-category]');
      scripts.forEach(function (script) {
        // CRITICAL: Never block Google Tag Manager/Google Analytics scripts
        // Even if they have data-category attribute, they use Consent Mode
        // Skip Google scripts - they're controlled by Consent Mode, not script blocking
        if (isGoogleScript(script)) {
          return; // Exit early for Google scripts - don't block them
        }
        
        // Block non-Google scripts with data-category
        if (script.type !== 'text/plain') {
          script.type = 'text/plain';
        }
      });
    }
  
    async function hashStringSHA256(str) {
      const encoder = new TextEncoder();
      const data = encoder.encode(str);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  
    async function scanAndSendHeadScriptsIfChanged(sessionToken) {
      // Early return if no token
      if (!sessionToken) {
        return;
      }
  
      const headScripts = document.head.querySelectorAll('script');
      const scriptData = Array.from(headScripts).map(script => ({
        src: script.src || null,
        content: script.src ? null : script.innerHTML,
        dataCategory: script.getAttribute('data-category') || null
      }));
      const scriptDataString = JSON.stringify(scriptData);
      const scriptDataHash = await hashStringSHA256(scriptDataString);
  
      const cachedHash = localStorage.getItem('_cb_hsh_');
      if (cachedHash === scriptDataHash) {
        return; // No change, do nothing
      }
  
      try {
        const encryptedScriptData = await encryptWithHardcodedKey(scriptDataString);
  
        // Get siteName from hostname
        const siteName = window.location.hostname.replace(/^www\./, '').split('.')[0];
  
        // Build API URL with siteName parameter
        const apiUrl = `https://app.consentbit.com/api/v2/cmp/head-scripts?siteName=${encodeURIComponent(siteName)}`;
  
        // Add timeout to prevent blocking (5 second max wait)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
  
        try {
          const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({ encryptedData: encryptedScriptData }),
            signal: controller.signal, // Add abort signal for timeout
            // Use keepalive to prevent blocking page unload
            keepalive: true
          });
  
          clearTimeout(timeoutId);
  
          if (response.ok) {
            localStorage.setItem('_cb_hsh_', scriptDataHash);
          }
        } catch (fetchError) {
          clearTimeout(timeoutId);
          // If timeout or network error, fail silently (non-critical operation)
          if (fetchError.name !== 'AbortError') {
            // Only log non-timeout errors if needed
          }
        }
      } catch (e) {
        // Silent error handling for encryption/other errors
      }
    }
  
    function blockTargetedAdvertisingScripts() {
      // Only block scripts with data-category attribute
      const targetedAdvertisingPatterns = /facebook|meta|fbevents|linkedin|twitter|pinterest|tiktok|snap|reddit|quora|outbrain|taboola|sharethrough|doubleclick|adwords|adsense|adservice|pixel|quantserve|scorecardresearch|moat|integral-marketing|comscore|nielsen|quantcast|adobe/i;
  
      const scripts = document.head.querySelectorAll('script[src][data-category]');
      scripts.forEach(script => {
        // CRITICAL: Never block Google scripts even if they match pattern
        if (isGoogleScript(script)) {
          return; // Skip Google scripts
        }
        
        if (targetedAdvertisingPatterns.test(script.src)) {
          if (script.type !== 'text/plain') {
            script.type = 'text/plain';
          }
        }
      });
    }
  
    function blockSaleScripts() {
      // Only block scripts with data-category attribute
      const salePatterns = /facebook|meta|fbevents|linkedin|twitter|pinterest|tiktok|snap|reddit|quora|outbrain|taboola|sharethrough|doubleclick|adwords|adsense|adservice|pixel|quantserve|scorecardresearch|moat|integral-marketing|comscore|nielsen|quantcast|adobe|marketo|hubspot|salesforce|pardot|eloqua|act-on|mailchimp|constantcontact|sendgrid|klaviyo|braze|iterable/i;
  
      const scripts = document.head.querySelectorAll('script[src][data-category]');
      scripts.forEach(script => {
        // CRITICAL: Never block Google scripts even if they match pattern
        if (isGoogleScript(script)) {
          return; // Skip Google scripts
        }
        
        if (salePatterns.test(script.src)) {
          if (script.type !== 'text/plain') {
            script.type = 'text/plain';
          }
        }
      });
    }
  
    function blockProfilingScripts() {
      // Only block scripts with data-category attribute
      const profilingPatterns = /optimizely|hubspot|marketo|pardot|salesforce|intercom|drift|zendesk|freshchat|tawk|livechat|clarity|hotjar|mouseflow|fullstory|logrocket|mixpanel|segment|amplitude|heap|kissmetrics|matomo|piwik|plausible|woopra|crazyegg|clicktale|chartbeat|parse\.ly/i;
  
      const scripts = document.head.querySelectorAll('script[src][data-category]');
      scripts.forEach(script => {
        // CRITICAL: Never block Google scripts even if they match pattern
        if (isGoogleScript(script)) {
          return; // Skip Google scripts
        }
        
        if (profilingPatterns.test(script.src)) {
          if (script.type !== 'text/plain') {
            script.type = 'text/plain';
          }
        }
      });
    }
  
    function blockCrossContextBehavioralAdvertising() {
      // Only block scripts with data-category attribute
      const crossContextPatterns = /facebook|meta|fbevents|linkedin|twitter|pinterest|tiktok|snap|reddit|quora|outbrain|taboola|sharethrough|doubleclick|adwords|adsense|adservice|pixel|quantserve|scorecardresearch|moat|integral-marketing|comscore|nielsen|quantcast|adobe/i;
  
      const scripts = document.head.querySelectorAll('script[src][data-category]');
      scripts.forEach(script => {
        // CRITICAL: Never block Google scripts even if they match pattern
        if (isGoogleScript(script)) {
          return; // Skip Google scripts
        }
        
        if (crossContextPatterns.test(script.src)) {
          if (script.type !== 'text/plain') {
            script.type = 'text/plain';
          }
        }
      });
    }
  
    function blockAutomatedDecisionScripts() {
      // Only block scripts with data-category attribute
      const automatedDecisionPatterns = /optimizely|hubspot|marketo|pardot|salesforce|intercom|drift|zendesk|freshchat|tawk|livechat|clarity|hotjar|mouseflow|fullstory|logrocket|mixpanel|segment|amplitude|heap|kissmetrics|matomo|piwik|plausible|woopra|crazyegg|clicktale|chartbeat|parse\.ly/i;
      
      const scripts = document.head.querySelectorAll('script[src][data-category]');
      scripts.forEach(script => {
        // CRITICAL: Never block Google scripts even if they match pattern
        if (isGoogleScript(script)) {
          return; // Skip Google scripts
        }
        
        if (automatedDecisionPatterns.test(script.src)) {
          if (script.type !== 'text/plain') {
            script.type = 'text/plain';
          }
        }
      });
    }
  
    // ========================================
    // WEBFLOW ANALYTICS INTEGRATION
    // ========================================
  
    // Configuration for Webflow Analytics integration
    const WEBFLOW_ANALYTICS_CONFIG = {
      enabled: true,
      trackPageViews: true,
      trackForms: true,
      trackClicks: true,
      trackEvents: true,
      debugMode: false,
      scriptUrl: "https://cdn.webflow.com/analyze.js" // Webflow Analytics script URL
    };
  
    // Dynamically load Webflow Analytics script based on consent
    function enableWebflowAnalytics() {
      if (typeof window.WebflowAnalytics === "undefined") {
        try {
          // Check if script is already being loaded
          if (document.querySelector('script[src*="analyze.js"]')) {
            return;
          }
  
          // Create and insert Webflow Analytics script
          var script = document.createElement("script");
          script.src = WEBFLOW_ANALYTICS_CONFIG.scriptUrl;
          script.async = true;
          script.onload = function() {
            // Initialize tracking after script loads
            setTimeout(initializeWebflowAnalytics, 100);
          };
          script.onerror = function() {
            // Silent error handling
          };
          
          document.head.appendChild(script);
          
         
        } catch (error) {
        }
      } else {
       
        // Initialize tracking immediately if already available
        initializeWebflowAnalytics();
      }
    }
  
    // Initialize Webflow Analytics when consent is given
    function initializeWebflowAnalytics() {
      if (!WEBFLOW_ANALYTICS_CONFIG.enabled) {
        return;
      }
  
      const consentGiven = localStorage.getItem("_cb_cg_");
      const analyticsConsent = localStorage.getItem("_cb_cas_");
      
      // Only proceed if consent is given AND analytics consent is specifically granted
      if (consentGiven === "true" && analyticsConsent === "true") {
        if (typeof window.WebflowAnalytics !== 'undefined') {
          
          // Track initial page view
          trackWebflowPageView();
          
          // Set up form tracking
          if (WEBFLOW_ANALYTICS_CONFIG.trackForms) {
            setupWebflowFormTracking();
          }
          
          // Set up click tracking
          if (WEBFLOW_ANALYTICS_CONFIG.trackClicks) {
            setupWebflowClickTracking();
          }
          
          // Track consent granted event
          trackWebflowEvent('consentbit_consent_granted', {
            category: 'consent',
            label: 'analytics_consent_granted',
            consent_categories: getActiveConsentCategories(),
            consentbit_integration: true
          });
        } else {
          // Try to load the Webflow Analytics script
          enableWebflowAnalytics();
        }
      } else {
        // If consent is revoked or analytics consent is false, ensure script is removed
        if (consentGiven === "true" && analyticsConsent === "false") {
          disableWebflowAnalytics();
        }
      }
    }
  
    // Track Webflow page view
    function trackWebflowPageView() {
      if (typeof window.WebflowAnalytics !== 'undefined' && getConsentBitAnalyticsConsent()) {
        try {
          window.WebflowAnalytics.track('page_view', {
            page_title: document.title,
            page_url: window.location.href,
            page_referrer: document.referrer,
            consentbit_integration: true,
            consentbit_timestamp: new Date().toISOString()
          });
        } catch (error) {
        }
      }
    }
  
    // Track custom events in Webflow Analytics
    function trackWebflowEvent(eventName, eventData = {}) {
      if (typeof window.WebflowAnalytics !== 'undefined' && getConsentBitAnalyticsConsent()) {
        try {
          const enhancedEventData = {
            ...eventData,
            consentbit_integration: true,
            consentbit_timestamp: new Date().toISOString()
          };
          
          window.WebflowAnalytics.track(eventName, enhancedEventData);
        } catch (error) {
        }
      }
    }
  
    // Set up Webflow form tracking
    function setupWebflowFormTracking() {
      if (!getConsentBitAnalyticsConsent()) return;
  
      document.addEventListener('submit', function(event) {
        const form = event.target;
        
        // Check if it's a Webflow form
        if (form.classList.contains('w-form') || form.hasAttribute('data-name')) {
          const formName = form.getAttribute('data-name') || 'Unknown Form';
          
          // Track form submission
          trackWebflowEvent('form_submit', {
            category: 'forms',
            label: formName,
            form_id: form.id || 'unknown',
            form_action: form.action || 'unknown',
            consentbit_form_tracking: true
          });
          
          // Track form success/failure
          setTimeout(function() {
            const successMessage = form.querySelector('.w-form-done');
            const errorMessage = form.querySelector('.w-form-fail');
            
            if (successMessage && successMessage.style.display !== 'none') {
              trackWebflowEvent('form_success', {
                category: 'forms',
                label: formName,
                form_id: form.id || 'unknown',
                consentbit_form_tracking: true
              });
            } else if (errorMessage && errorMessage.style.display !== 'none') {
              trackWebflowEvent('form_error', {
                category: 'forms',
                label: formName,
                form_id: form.id || 'unknown',
                consentbit_form_tracking: true
              });
            }
          }, 1000);
        }
      });
    }
  
    // Set up Webflow click tracking
    function setupWebflowClickTracking() {
      if (!getConsentBitAnalyticsConsent()) return;
  
      document.addEventListener('click', function(event) {
        const target = event.target;
        
        // Track button clicks
        if (target.tagName === 'BUTTON' || target.classList.contains('w-button')) {
          const buttonText = target.textContent.trim() || target.getAttribute('aria-label') || 'Unknown Button';
          const buttonId = target.id || 'unknown';
          
          trackWebflowEvent('button_click', {
            category: 'engagement',
            label: buttonText,
            button_id: buttonId,
            button_type: target.getAttribute('data-type') || 'general',
            consentbit_click_tracking: true
          });
        }
        
        // Track link clicks
        if (target.tagName === 'A' || target.closest('a')) {
          const link = target.tagName === 'A' ? target : target.closest('a');
          const linkText = link.textContent.trim() || link.getAttribute('aria-label') || 'Unknown Link';
          const linkHref = link.href || 'unknown';
          
          trackWebflowEvent('link_click', {
            category: 'engagement',
            label: linkText,
            link_url: linkHref,
            link_type: link.getAttribute('data-type') || 'general',
            consentbit_click_tracking: true
          });
        }
      });
    }
  
    // Helper function to check if analytics consent is given
    function getConsentBitAnalyticsConsent() {
      const consentGiven = localStorage.getItem("_cb_cg_");
      const analyticsConsent = localStorage.getItem("_cb_cas_");
      return consentGiven === "true" && analyticsConsent === "true";
    }
  
    // Helper function to get active consent categories
    function getActiveConsentCategories() {
      const categories = [];
      if (localStorage.getItem("_cb_cas_") === "true") categories.push('analytics');
      if (localStorage.getItem("_cb_cms_") === "true") categories.push('marketing');
      if (localStorage.getItem("_cb_cps_") === "true") categories.push('personalization');
      return categories.join(',');
    }
  
    // Monitor consent changes and update Webflow Analytics
    function monitorConsentChanges() {
      let lastConsentState = getConsentBitAnalyticsConsent();
      
      setInterval(function() {
        const currentConsentState = getConsentBitAnalyticsConsent();
        
        if (currentConsentState !== lastConsentState) {
          
          if (currentConsentState) {
            // Consent granted - initialize Webflow Analytics
            initializeWebflowAnalytics();
          } else {
            // Consent revoked - track revocation event and disable
            if (typeof window.WebflowAnalytics !== 'undefined') {
              trackWebflowEvent('consentbit_consent_revoked', {
                category: 'consent',
                label: 'analytics_consent_revoked',
                consentbit_integration: true
              });
            }
            // Remove Webflow Analytics script when consent is revoked
            disableWebflowAnalytics();
          }
          
          lastConsentState = currentConsentState;
        }
      }, 2000);
    }
  
    // Remove Webflow Analytics script when consent is revoked
    function disableWebflowAnalytics() {
      try {
        // Remove the script tag
        const scriptTag = document.querySelector('script[src*="analyze.js"]');
        if (scriptTag) {
          scriptTag.remove();
          
        }
        
        // Clear the global object
        if (window.WebflowAnalytics) {
          delete window.WebflowAnalytics;
         
        }
      } catch (error) {
      }
    }
  
    // Public API for external use
    window.ConsentBitWebflowIntegration = {
      // Configuration
      config: WEBFLOW_ANALYTICS_CONFIG,
      
      // Core functions
      trackEvent: trackWebflowEvent,
      trackPageView: trackWebflowPageView,
      initialize: initializeWebflowAnalytics,
      
      // Script management
      enableAnalytics: enableWebflowAnalytics,
      disableAnalytics: disableWebflowAnalytics,
      
      // Consent functions
      getAnalyticsConsent: getConsentBitAnalyticsConsent,
      getActiveConsentCategories: getActiveConsentCategories,
      
      // Utility functions
      isWebflowAnalyticsAvailable: function() {
        return typeof window.WebflowAnalytics !== 'undefined';
      },
      
      // Configuration helpers
      enableDebugMode: function() {
        WEBFLOW_ANALYTICS_CONFIG.debugMode = true;
      },
      
      disableTracking: function() {
        WEBFLOW_ANALYTICS_CONFIG.enabled = false;
      },
      
      enableTracking: function() {
        WEBFLOW_ANALYTICS_CONFIG.enabled = true;
      }
    };
  
    // Set up consent event listener for external CMP integration
    document.addEventListener('consentUpdated', function(event) {
      if (event.detail && event.detail.analytics === true) {
        enableWebflowAnalytics();
      } else if (event.detail && event.detail.analytics === false) {
        disableWebflowAnalytics();
      }

      // Release data-category scripts that were blocked by the loaderWebflow inline blocker.
      // Build allowed-category list from the event detail and call enableScriptsByCategories.
      if (event.detail) {
        var _cbAllowed = [];
        if (event.detail.analytics === true) _cbAllowed.push('analytics', 'statistics', 'performance');
        if (event.detail.marketing === true) _cbAllowed.push('marketing', 'advertising', 'advertisement');
        if (event.detail.preferences === true) _cbAllowed.push('preferences', 'functional', 'personalization');
        if (_cbAllowed.length > 0 && typeof enableScriptsByCategories === 'function') {
          try { enableScriptsByCategories(_cbAllowed); } catch(e) {}
        }
      }
    });
  
    // Also listen for the legacy consent event format
    document.addEventListener('consentUpdated', function(event) {
      if (window.userConsent && window.userConsent.analytics === true) {
        enableWebflowAnalytics();
      } else if (window.userConsent && window.userConsent.analytics === false) {
        disableWebflowAnalytics();
      }
    });

  })();
  