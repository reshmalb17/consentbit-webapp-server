// src/utils/flowLog.js
//
// Structured logs for the subscription renewal / cancellation workflow.
//
// Switched on by env CB_FLOW_LOG ("1" / "true" / "on"). It is set in wrangler.toml's
// top-level [vars] only, which applies to the Test worker; [env.production.vars] does not
// inherit it, so production stays silent even though both deploy from this same source.
//
// Every line carries the tag [CB-FLOW] and is one JSON object, so on Test you can watch just
// this workflow without the rest of the worker's output:
//
//   npx wrangler tail --search "CB-FLOW"                     # everything in the workflow
//   npx wrangler tail --search "CB-FLOW banner."             # one area
//
// Areas: banner · trial · guard · invoiceVoid · cardPin · checkout
// Never throws and never logs card numbers — only Stripe object ids.

export const FLOW_TAG = '[CB-FLOW]';

export function isFlowLogOn(env) {
  const v = String(env?.CB_FLOW_LOG ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * @param {object} env
 * @param {string} area   e.g. 'banner'
 * @param {string} event  e.g. 'blocked'
 * @param {object} [data]
 */
export function flowLog(env, area, event, data = {}) {
  if (!isFlowLogOn(env)) return;
  try {
    console.log(`${FLOW_TAG} ${area}.${event} ${JSON.stringify({ at: new Date().toISOString(), ...data })}`);
  } catch {
    // logging must never affect the request
  }
}
