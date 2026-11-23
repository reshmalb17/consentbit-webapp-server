// src/utils/ipTruncate.js
// Shortens visitor IP addresses before they are stored or shown (GDPR data minimisation).
//   IPv4 -> /24 : 203.0.113.57        -> 203.0.113.0
//   IPv6 -> /48 : 2001:db8:85a3:8d3::1 -> 2001:db8:85a3::
// IPv4-mapped IPv6 (::ffff:1.2.3.4) is treated as IPv4.
// Anything unrecognised is dropped (null) rather than stored in full.

function truncateIpv6(s) {
  // Expand "::" so every address has 8 groups, then keep the first 3.
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = halves.length === 2
    ? [...head, ...Array(missing).fill('0'), ...tail]
    : head;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const kept = groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '').toLowerCase());
  return `${kept.join(':')}::`;
}

export function truncateIp(raw) {
  if (raw == null) return null;
  // x-forwarded-for may hold a list; the first entry is the client.
  let s = String(raw).split(',')[0].trim();
  if (!s) return null;
  // Strip a zone id (fe80::1%eth0) and IPv4-mapped prefix.
  s = s.replace(/%.*$/, '');
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) s = mapped[1];

  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1, 4).map(Number);
    if (parts.some((n) => n > 255) || Number(v4[4]) > 255) return null;
    return `${parts.join('.')}.0`;
  }
  if (s.includes(':')) return truncateIpv6(s);
  return null;
}
