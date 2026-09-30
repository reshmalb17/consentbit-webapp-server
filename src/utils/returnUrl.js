// src/utils/returnUrl.js
//
// successUrl / cancelUrl (Stripe Checkout) and returnUrl (billing portal) come from the
// request body. Unchecked, a caller could send them anywhere — and Stripe appends the
// cs_ session id to the success URL, handing it to that host.
//
// Allowed: our own webapp origins (isOwnWebappOrigin — accounts.consentbit.com, the test
// pages.dev app + previews, localhost) and any *.consentbit.com host (isAllowedRedirect,
// e.g. the worker's own /api/checkout-success-redirect). Anything else is replaced by the
// caller's normal default rather than refused, so a real checkout never fails over it.

import { isOwnWebappOrigin } from './cors.js';
import { isAllowedRedirect } from '../handlers/checkoutSuccessRedirect.js';

export function safeReturnUrl(raw, env, fallback, tag = '[ReturnUrl]') {
  const value = String(raw || '').trim();
  if (!value) return fallback;
  try {
    const u = new URL(value);
    if (isOwnWebappOrigin(u.origin, env) || isAllowedRedirect(u, env)) return value;
  } catch (_) { /* not an absolute URL → fall back */ }
  console.warn(`${tag} ignored return URL on an unapproved host`, { value: value.slice(0, 200) });
  return fallback;
}
