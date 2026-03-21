/**
 * Public SVG served from the Worker so embed scripts can load a logo without
 * depending on the Next.js app hosting /asset/logo.webp (often missing or wrong origin).
 */
export function handleEmbedFloatingLogo() {
  const svg =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">' +
    '<circle cx="20" cy="20" r="18" fill="#007aff"/>' +
    '<circle cx="14" cy="14" r="2.2" fill="#ffffff"/>' +
    '<circle cx="24" cy="18" r="2.5" fill="#ffffff"/>' +
    '<circle cx="17" cy="25" r="2" fill="#ffffff"/>' +
    '</svg>';
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
