___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "TAG",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "ConsentBit CMP",
  "description": "Loads the ConsentBit consent banner from your Script ID and sets the Google Consent Mode v2 default (all denied) before any other tag fires. Requires a ConsentBit account.",
  "categories": [
    "UTILITY",
    "PERSONALIZATION"
  ],
  "containerContexts": [
    "WEB"
  ],
  "brand": {
    "id": "brand_dummy",
    "displayName": "ConsentBit",
    "thumbnail": ""
  },
  "consentSettings": {
    "consentStatus": "notNeeded"
  }
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "scriptId",
    "displayName": "ConsentBit Script ID",
    "simpleValueType": true,
    "help": "Copy this from your ConsentBit dashboard under <strong>Install</strong>. It is the ID in the middle of your install snippet:<br><code>https://manager.consentbit.com/consentbit/<strong>{SCRIPT ID}</strong>/script.js</code><br>Paste the ID only, not the whole URL.",
    "valueValidators": [
      {
        "type": "NON_EMPTY"
      },
      {
        "type": "REGEX",
        "args": [
          "^[0-9a-zA-Z_-]{8,64}$"
        ],
        "errorMessage": "Enter the Script ID on its own (for example 3f2b9c10-8a4e-4d51-9b77-2c6d0e1a5f88), not the full script URL."
      }
    ],
    "alwaysInSummary": true
  }
]


___SANDBOXED_JS_FOR_WEB_TEMPLATE___

const injectScript = require('injectScript');
const setDefaultConsentState = require('setDefaultConsentState');
const setInWindow = require('setInWindow');
const encodeUriComponent = require('encodeUriComponent');
const log = require('logToConsole');

// The banner is always served from ConsentBit's own origin. Pinned here because
// the inject_script permission has to declare the URL prefix in advance.
const CDN_ORIGIN = 'https://manager.consentbit.com';

const scriptId = data.scriptId ? data.scriptId.trim() : '';

if (!scriptId) {
  log('ConsentBit: no Script ID configured — nothing was loaded.');
  return data.gtmOnFailure();
}

// --- Google Consent Mode v2 default ------------------------------------------
// Runs from the "Consent Initialization - All Pages" trigger, so it lands before
// any measurement tag in this container. Every storage type is denied until the
// visitor chooses; security_storage is always granted. The banner then applies the
// real choice with gtag("consent","update") when the user clicks. wait_for_update
// of 500ms matches the value the banner itself uses.
setDefaultConsentState({
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  functionality_storage: 'denied',
  personalization_storage: 'denied',
  security_storage: 'granted',
  wait_for_update: 500
});

// Tell the banner the default has already been published, so its boot() skips the
// duplicate gtag("consent","default") push. The banner checks this flag.
setInWindow('__cbConsentDefaultSet', true, true);

// --- Load the banner ---------------------------------------------------------
// The banner reads its own configuration (regulation, geo, styling, blocking
// rules, translations) from the response body — the Script ID is the only input
// it needs.
const url = CDN_ORIGIN + '/consentbit/' + encodeUriComponent(scriptId) + '/script.js';

injectScript(url, data.gtmOnSuccess, data.gtmOnFailure, url);


___WEB_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "logging",
        "versionId": "1"
      },
      "param": [
        {
          "key": "environments",
          "value": {
            "type": 1,
            "string": "debug"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "inject_script",
        "versionId": "1"
      },
      "param": [
        {
          "key": "urls",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "https://manager.consentbit.com/consentbit/*"
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "access_consent",
        "versionId": "1"
      },
      "param": [
        {
          "key": "consentTypes",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "consentType"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "ad_storage"
                  },
                  {
                    "type": 8,
                    "boolean": false
                  },
                  {
                    "type": 8,
                    "boolean": true
                  }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "consentType"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "ad_user_data"
                  },
                  {
                    "type": 8,
                    "boolean": false
                  },
                  {
                    "type": 8,
                    "boolean": true
                  }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "consentType"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "ad_personalization"
                  },
                  {
                    "type": 8,
                    "boolean": false
                  },
                  {
                    "type": 8,
                    "boolean": true
                  }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "consentType"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "analytics_storage"
                  },
                  {
                    "type": 8,
                    "boolean": false
                  },
                  {
                    "type": 8,
                    "boolean": true
                  }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "consentType"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "functionality_storage"
                  },
                  {
                    "type": 8,
                    "boolean": false
                  },
                  {
                    "type": 8,
                    "boolean": true
                  }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "consentType"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "personalization_storage"
                  },
                  {
                    "type": 8,
                    "boolean": false
                  },
                  {
                    "type": 8,
                    "boolean": true
                  }
                ]
              },
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "consentType"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "security_storage"
                  },
                  {
                    "type": 8,
                    "boolean": false
                  },
                  {
                    "type": 8,
                    "boolean": true
                  }
                ]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "access_globals",
        "versionId": "1"
      },
      "param": [
        {
          "key": "keys",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "key"
                  },
                  {
                    "type": 1,
                    "string": "read"
                  },
                  {
                    "type": 1,
                    "string": "write"
                  },
                  {
                    "type": 1,
                    "string": "execute"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "__cbConsentDefaultSet"
                  },
                  {
                    "type": 8,
                    "boolean": true
                  },
                  {
                    "type": 8,
                    "boolean": true
                  },
                  {
                    "type": 8,
                    "boolean": false
                  }
                ]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]


___TESTS___

scenarios:
- name: Injects the banner using the configured Script ID
  code: |-
    const mockData = {
      scriptId: '3f2b9c10-8a4e-4d51-9b77-2c6d0e1a5f88'
    };

    let injectedUrl;
    mock('injectScript', (url, onSuccess) => {
      injectedUrl = url;
      onSuccess();
    });

    runCode(mockData);

    assertThat(injectedUrl).isEqualTo(
      'https://manager.consentbit.com/consentbit/3f2b9c10-8a4e-4d51-9b77-2c6d0e1a5f88/script.js'
    );
    assertApi('gtmOnSuccess').wasCalled();
- name: Sets an all-denied consent default before injecting
  code: |-
    const mockData = {
      scriptId: 'abcd1234'
    };

    let defaults;
    mock('setDefaultConsentState', state => {
      defaults = state;
    });
    mock('injectScript', (url, onSuccess) => onSuccess());

    runCode(mockData);

    assertThat(defaults.ad_storage).isEqualTo('denied');
    assertThat(defaults.ad_user_data).isEqualTo('denied');
    assertThat(defaults.ad_personalization).isEqualTo('denied');
    assertThat(defaults.analytics_storage).isEqualTo('denied');
    assertThat(defaults.functionality_storage).isEqualTo('denied');
    assertThat(defaults.personalization_storage).isEqualTo('denied');
    assertThat(defaults.security_storage).isEqualTo('granted');
    assertThat(defaults.wait_for_update).isEqualTo(500);
- name: Fails cleanly when no Script ID is set
  code: |-
    const mockData = {scriptId: ''};

    mock('injectScript', () => fail('injectScript must not run without a Script ID'));

    runCode(mockData);

    assertApi('gtmOnFailure').wasCalled();
    assertApi('gtmOnSuccess').wasNotCalled();


___NOTES___

Created on 2026-07-24
