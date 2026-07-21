// GET /api/checkout-success-redirect?session_id=cs_xxx&redirect=<encoded-url>
// Stripe calls this as the success_url. Fetches session details from Stripe,
// appends them as URL params to the redirect destination, then 302 redirects.
// No auth required — this is a browser redirect from Stripe.

// Open-redirect guard. This endpoint runs on the Worker (manager.consentbit.com)
// but redirects OUT to the app front-end, so a same-origin check won't do —
// we allow-list trusted ConsentBit app hosts instead. Every legitimate caller
// passes its own app origin (accounts/dashboard.consentbit.com). Extra hosts can
// be added via the REDIRECT_ALLOWED_HOSTS env var (comma-separated) for
// staging/preview domains without a code change.
function isAllowedRedirect(url, env) {
  // Block non-web schemes (javascript:, data:, etc.). Allow http only for local dev.
  const host = url.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLocal) return false;
  if (isLocal) return true;

  if (host === 'consentbit.com' || host.endsWith('.consentbit.com')) return true;

  const extra = (env && env.REDIRECT_ALLOWED_HOSTS ? String(env.REDIRECT_ALLOWED_HOSTS) : '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(host);
}

export async function handleCheckoutSuccessRedirect(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) {
    return new Response('Stripe not configured', { status: 503 });
  }

  const url = new URL(request.url);
  const sessionId  = url.searchParams.get('session_id') ?? '';
  const redirectTo = url.searchParams.get('redirect')   ?? '';

  if (!redirectTo) {
    return new Response('Bad Request: missing redirect param', { status: 400 });
  }

  let dest;
  try {
    dest = new URL(redirectTo);
  } catch {
    return new Response('Bad Request: invalid redirect URL', { status: 400 });
  }

  // Open-redirect guard: only ever redirect to a trusted ConsentBit app host.
  if (!isAllowedRedirect(dest, env)) {
    return new Response('Bad Request: redirect not allowed', { status: 400 });
  }

  // If session_id is missing or invalid, redirect without extra params
  if (!sessionId.startsWith('cs_')) {
    return Response.redirect(dest.toString(), 302);
  }

  try {
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent&expand[]=invoice`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    const session = await res.json();

    if (!session.error && (session.payment_status === 'paid' || session.status === 'complete' || session.payment_status === 'no_payment_required')) {
      // Amount
      const amountFormatted = session.amount_total != null
        ? (session.amount_total / 100).toFixed(2)
        : null;
      if (amountFormatted) dest.searchParams.set('amount', amountFormatted);

      // Currency
      const currency = session.currency ? session.currency.toUpperCase() : null;
      if (currency) dest.searchParams.set('currency', currency);

      // Transaction ID (PaymentIntent)
      const paymentIntent = session.payment_intent;
      const transactionId = typeof paymentIntent === 'object'
        ? paymentIntent?.id
        : paymentIntent || null;
      if (transactionId) dest.searchParams.set('transaction_id', transactionId);

      // Date of purchase
      const dateOfPurchase = session.created
        ? new Date(session.created * 1000).toISOString()
        : null;
      if (dateOfPurchase) dest.searchParams.set('date', dateOfPurchase);

      // Plan details from subscription_data metadata
      const meta = session.metadata || {};
      const subMeta = (typeof session.subscription === 'object' && session.subscription?.metadata) || {};
      const planId   = meta.planId   || subMeta.planId   || null;
      const planType = meta.planType || subMeta.planType || 'subscription';
      const interval = meta.interval || subMeta.interval || null;
      if (planId)   dest.searchParams.set('plan_id',   planId);
      if (planType) dest.searchParams.set('plan_type', planType);
      if (interval) dest.searchParams.set('interval',  interval);

      // Invoice
      const invoiceId = typeof session.invoice === 'string'
        ? session.invoice
        : (session.invoice?.id) || null;
      const invoiceUrl = session.invoice && typeof session.invoice === 'object'
        ? session.invoice.hosted_invoice_url || null
        : null;
      if (invoiceId)  dest.searchParams.set('invoice_id',  invoiceId);
      if (invoiceUrl) dest.searchParams.set('invoice_url', invoiceUrl);

      // Customer email
      const customerEmail = session.customer_email || session.customer_details?.email || null;
      if (customerEmail) dest.searchParams.set('email', customerEmail);

      // Payment status
      if (session.payment_status) dest.searchParams.set('payment_status', session.payment_status);
    }
  } catch {
    // Best-effort — redirect without extra params on any error
  }

  return Response.redirect(dest.toString(), 302);
}
