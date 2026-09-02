// POST /api/validate-promo
// Body: { code, productType?, interval, quantity? }
// Returns: { success, valid, discountCents?, finalCents?, stripeCouponId?, message }
// Validates using Stripe promotion codes only (no PromoCode table). Create codes in Stripe Dashboard.

import { ensureSchema, getSessionById, getUserById } from '../services/db.js';
import {
  isRestrictedCode,
  isCodeAllowedForEmail,
  PROMO_NOT_ALLOWED_MESSAGE,
} from '../services/promoRestrictions.js';

/** Logged-in account email, with an ?email/body email hint for embedded apps. See validate-coupon. */
async function resolveCallerEmail(request, env, body) {
  // Debug: identity resolution is the usual failure point for restricted codes.
  // Cookie NAMES only — never log the sid value.
  const cookie = request.headers.get('Cookie') || '';
  const cookieNames = cookie ? cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean) : [];
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  console.log('[ValidatePromo] identity debug', {
    origin: request.headers.get('Origin') || null,
    referer: request.headers.get('Referer') || null,
    hasCookieHeader: cookie.length > 0,
    cookieNames,
    hasSid: !!m,
    emailHint: (body?.email || '') ? 'present' : 'absent',
  });
  try {
    if (m && env.CONSENT_WEBAPP) {
      const session = await getSessionById(env.CONSENT_WEBAPP, m[1].trim());
      console.log('[ValidatePromo] session lookup', { sessionFound: !!session, userId: session ? (session.userId ?? session.user_id ?? null) : null });
      if (session) {
        const user = await getUserById(env.CONSENT_WEBAPP, session.userId ?? session.user_id);
        console.log('[ValidatePromo] user lookup', { userFound: !!user, email: user?.email ?? null });
        if (user?.email) return String(user.email).trim().toLowerCase();
      }
    }
  } catch (e) {
    console.warn('[ValidatePromo] session lookup failed', e?.message);
  }
  const hint = (body?.email || '').toString().trim().toLowerCase();
  return hint || null;
}

const PRICES = { monthly: 800, yearly: 7200 }; // cents per license: $8, $72

/** Find active Stripe promotion code by code string; returns { promotionCode, coupon } or null. */
async function findStripePromoByCode(secret, code) {
  if (!secret || !code) return null;
  const normalized = code.trim().toLowerCase();
  const url = `https://api.stripe.com/v1/promotion_codes?active=true&limit=100&expand[]=data.coupon`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  });
  const data = await res.json();
  if (data.error || !Array.isArray(data.data)) return null;
  const found = data.data.find((pc) => (pc.code || '').toLowerCase() === normalized);
  if (!found || !found.coupon) return null;
  const coupon = typeof found.coupon === 'object' ? found.coupon : { id: found.coupon };
  return { promotionCode: found, coupon };
}

export async function handleValidatePromo(request, env) {
  if (request.method !== 'POST') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }
  const db = env.CONSENT_WEBAPP;
  await ensureSchema(db);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ success: false, valid: false, message: 'Invalid JSON' }, { status: 400 });
  }
  const code = body.code && String(body.code).trim();
  const interval = body.interval === 'yearly' ? 'yearly' : 'monthly';
  const quantity = Math.max(1, Math.min(1000, parseInt(body.quantity, 10) || 1));

  if (!code) {
    return Response.json({ success: true, valid: false, message: 'Enter a promo code' });
  }

  const stripeSecret = env.STRIPE_SECRET_KEY;
  if (!stripeSecret) {
    return Response.json({ success: true, valid: false, message: 'Promo not configured' });
  }

  const stripePromo = await findStripePromoByCode(stripeSecret, code);
  if (!stripePromo) {
    return Response.json({ success: true, valid: false, message: 'Invalid promo code' });
  }

  // Per-customer promo restrictions (see services/promoRestrictions.js).
  const promoCodeString = stripePromo.promotionCode?.code || code;
  if (isRestrictedCode(promoCodeString)) {
    const callerEmail = await resolveCallerEmail(request, env, body);
    if (!isCodeAllowedForEmail(promoCodeString, callerEmail)) {
      console.warn('[ValidatePromo] restricted code denied', { code: promoCodeString, callerEmail });
      return Response.json({ success: true, valid: false, message: PROMO_NOT_ALLOWED_MESSAGE });
    }
  }

  const coupon = stripePromo.coupon;
  const couponId = coupon.id || stripePromo.promotionCode.coupon;
  const baseCents = PRICES[interval] * quantity;
  let discountCents = 0;
  if (coupon.percent_off != null) {
    discountCents = Math.round((baseCents * coupon.percent_off) / 100);
  } else if (coupon.amount_off != null) {
    discountCents = Math.min(coupon.amount_off, baseCents);
  }
  const finalCents = Math.max(0, baseCents - discountCents);

  return Response.json({
    success: true,
    valid: true,
    discountCents,
    finalCents,
    baseCents,
    stripeCouponId: couponId,
    message: `Promo applied. You pay $${(finalCents / 100).toFixed(2)}`,
  });
}
