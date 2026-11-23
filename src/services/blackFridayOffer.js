// Black Friday offer — default promotion code for plan changes made without an explicit code.
// Used by the Webflow / Framer upgrade handlers and changeTier when the request has no
// promotionCodeId, so the app's upgrade preview and charge reflect the discount with no app change.
//
// Basic + Essential → BF20OFF (20%), Growth → BF30OFF (30%), both 3 months (Stripe).
// Each plan has its own end time, matching the expiry of its Stripe promotion code.
// Past that time nothing is applied for that plan. To end an offer early, move its time back.
//   BF20OFF (Basic/Essential) expires 2026-11-30 18:29 UTC.
//   BF30OFF (Growth)          expires 2026-11-30 18:29 UTC.

const OFFER_BY_PLAN = {
  basic: { promotionCodeId: 'promo_1UakZMJwcuG9163My19Z7s03', activeUntilMs: Date.parse('2026-11-30T18:29:00Z') }, // BF20OFF
  essential: { promotionCodeId: 'promo_1UakZMJwcuG9163My19Z7s03', activeUntilMs: Date.parse('2026-11-30T18:29:00Z') }, // BF20OFF
  growth: { promotionCodeId: 'promo_1UakbBJwcuG9163MHJ5xP4EW', activeUntilMs: Date.parse('2026-11-30T18:29:00Z') }, // BF30OFF
};

/** Promotion code ID to apply for this plan, or null when the offer is off or the plan has none. */
export function defaultPromotionCodeForPlan(planId, now = Date.now()) {
  const offer = OFFER_BY_PLAN[planId];
  if (!offer || now >= offer.activeUntilMs) return null;
  return offer.promotionCodeId;
}
