// Per-customer promo code restrictions.
//
// WHY THIS EXISTS
// Stripe can restrict a promotion code to one Customer (`promotion_code.customer`),
// but that only bites when the Checkout Session / Subscription already has a
// `customer` attached. Our main checkout path (createCheckoutSession.js) sends
// `customer_email` only — Stripe creates the Customer *after* checkout completes —
// so there is no Customer object to compare against and the restriction is never
// enforced. Result: a "limit to one customer" code works for everybody.
//
// This module enforces the restriction ourselves, keyed on the account email we
// already have server-side, before the discount is ever attached to Stripe.
//
// To restrict a new code: add one entry below (code lowercased, emails lowercased).
// Codes NOT listed here are unrestricted and behave exactly as before.

const RESTRICTED_CODES = {
  consent35: ['rodrigo.rejman@platanhotels.pl'],
  demo100: ['reshma@seattlenewmedia.com'],
};

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

/** True if this customer-facing code string has an email allowlist. */
export function isRestrictedCode(code) {
  return Object.prototype.hasOwnProperty.call(RESTRICTED_CODES, norm(code));
}

/**
 * Check a customer-facing code string ("CONSENT35") against an account email.
 * Unrestricted codes always pass.
 */
export function isCodeAllowedForEmail(code, email) {
  const allowed = RESTRICTED_CODES[norm(code)];
  if (!allowed) return true;
  return allowed.includes(norm(email));
}

/** Message shown when a restricted code is used by the wrong account. */
export const PROMO_NOT_ALLOWED_MESSAGE = 'This promo code is not available for your account';

/**
 * Guard for handlers that only have a promo_xxx id. Resolves the id to its
 * customer-facing code via Stripe, then applies the allowlist.
 *
 * Returns { allowed: true, code } or { allowed: false, reason }.
 * A lookup failure denies (fail-closed) — the caller already treats an
 * unverifiable promotion code as a hard error.
 */
export async function isPromotionCodeAllowedForEmail(secret, promotionCodeId, email) {
  if (!promotionCodeId) return { allowed: true, code: null };
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/promotion_codes/${encodeURIComponent(promotionCodeId)}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    const promo = await res.json();
    if (promo.error) {
      console.warn('[PromoRestrictions] lookup error', promo.error?.message);
      return { allowed: false, reason: 'Promotion code could not be verified', code: null };
    }
    const code = promo.code || null;
    if (!isCodeAllowedForEmail(code, email)) {
      console.warn('[PromoRestrictions] denied', { code, email, promotionCodeId });
      return { allowed: false, reason: PROMO_NOT_ALLOWED_MESSAGE, code };
    }
    return { allowed: true, code };
  } catch (e) {
    console.error('[PromoRestrictions] lookup failed', e?.message);
    return { allowed: false, reason: 'Promotion code could not be verified', code: null };
  }
}

/**
 * Guard for the raw-coupon path (`discounts[0][coupon]` = coup_xxx), which would
 * otherwise sidestep every promotion-code check. Denies if the coupon backs a
 * restricted code the caller is not on the allowlist for.
 *
 * Returns { allowed: true } or { allowed: false, reason }.
 */
export async function isCouponIdAllowedForEmail(secret, couponId, email) {
  if (!couponId) return { allowed: true };
  try {
    const params = new URLSearchParams({ coupon: couponId, limit: '100' });
    const res = await fetch(
      `https://api.stripe.com/v1/promotion_codes?${params.toString()}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    const data = await res.json();
    if (data.error) {
      console.warn('[PromoRestrictions] coupon lookup error', data.error?.message);
      return { allowed: false, reason: 'Coupon could not be verified' };
    }
    const codes = Array.isArray(data.data) ? data.data.map((pc) => pc.code) : [];
    const blocking = codes.find((c) => isRestrictedCode(c) && !isCodeAllowedForEmail(c, email));
    if (blocking) {
      console.warn('[PromoRestrictions] denied raw coupon', { couponId, blocking, email });
      return { allowed: false, reason: PROMO_NOT_ALLOWED_MESSAGE };
    }
    return { allowed: true };
  } catch (e) {
    console.error('[PromoRestrictions] coupon lookup failed', e?.message);
    return { allowed: false, reason: 'Coupon could not be verified' };
  }
}
