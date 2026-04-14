// GET /api/checkout-session?session_id=cs_xxx
// Returns payment summary for the frontend after a successful Stripe Checkout redirect.
// Response: { success, amount, currency, transaction_id, date_of_purchase, merchant_type }

export async function handleCheckoutSessionDetails(request, env) {
  if (request.method !== 'GET') {
    return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
  }

  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) {
    return Response.json({ success: false, error: 'Stripe not configured.' }, { status: 503 });
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId || !sessionId.startsWith('cs_')) {
    return Response.json({ success: false, error: 'session_id query param required (e.g. cs_xxx).' }, { status: 400 });
  }

  let session;
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent&expand[]=invoice`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
    session = await res.json();
  } catch (e) {
    return Response.json({ success: false, error: 'Failed to fetch session from Stripe.' }, { status: 502 });
  }

  if (session.error) {
    return Response.json({ success: false, error: session.error.message || 'Stripe error' }, { status: 400 });
  }

  // Only expose details for completed/paid sessions
  if (session.payment_status !== 'paid' && session.status !== 'complete') {
    return Response.json({ success: false, error: 'Payment not completed.' }, { status: 402 });
  }

  // amount_total is in the smallest currency unit (cents); convert to decimal
  const amountTotal = session.amount_total;
  const currency = (session.currency || 'usd').toUpperCase();
  const amountFormatted = amountTotal != null
    ? (amountTotal / 100).toFixed(2)
    : null;

  // transaction_id: the PaymentIntent id (pi_xxx) or SetupIntent id
  const paymentIntent = session.payment_intent;
  const transactionId = typeof paymentIntent === 'object'
    ? paymentIntent?.id
    : paymentIntent || null;

  // date_of_purchase: Unix timestamp → ISO string
  const dateOfPurchase = session.created
    ? new Date(session.created * 1000).toISOString()
    : null;

  // plan details from subscription metadata set during checkout
  const meta = session.metadata || {};
  const subMeta = (typeof session.subscription === 'object' && session.subscription?.metadata) || {};
  const planId = meta.planId || subMeta.planId || null;
  const planType = meta.planType || subMeta.planType || 'subscription';
  const interval = meta.interval || subMeta.interval || null;

  // invoice: from the session's invoice field (expand not needed — id is enough for the URL)
  const invoiceId = typeof session.invoice === 'string'
    ? session.invoice
    : (session.invoice && session.invoice.id) || null;
  const invoiceUrl = session.invoice && typeof session.invoice === 'object'
    ? session.invoice.hosted_invoice_url || null
    : null;

  // customer email
  const customerEmail = session.customer_email || session.customer_details?.email || null;

  // payment status
  const paymentStatus = session.payment_status || null;

  return Response.json({
    success: true,
    amount: amountFormatted,
    currency,
    transaction_id: transactionId,
    date_of_purchase: dateOfPurchase,
    plan_id: planId,
    plan_type: planType,
    interval,
    invoice_id: invoiceId,
    invoice_url: invoiceUrl,
    customer_email: customerEmail,
    payment_status: paymentStatus,
  });
}
