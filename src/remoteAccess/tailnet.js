// Which addresses belong to Tailscale. Remote access listens only on such an address and answers
// only connections that come from one, so it is never reachable from the LAN or the internet.
// Loaded by main.js at runtime (copied to out/main/src), so keep it CommonJS.

/** 100.64.0.0/10 (the range Tailscale gives its devices) */
function isTailnetIpv4(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address))
  if (!match) return false
  const [a, b, c, d] = match.slice(1).map(Number)
  if ([a, b, c, d].some((part) => part > 255)) return false
  return a === 100 && b >= 64 && b <= 127
}

/** fd7a:115c:a1e0::/48 (Tailscale's IPv6 range) */
function isTailnetIpv6(address) {
  return /^fd7a:115c:a1e0:/i.test(String(address))
}

/** `::ffff:100.101.102.103` is an IPv4 address seen through an IPv6 socket */
function isTailnetAddress(address) {
  const text = String(address ?? '').replace(/%.*$/, '')
  // The mapped form holds an IPv4 address only: what follows the prefix is never read as IPv6
  if (/^::ffff:/i.test(text)) return isTailnetIpv4(text.replace(/^::ffff:/i, ''))
  return isTailnetIpv4(text) || isTailnetIpv6(text)
}

/**
 * Whether a network interface is Tailscale's. 100.64.0.0/10 is also what carriers use for their own
 * NAT (some ISPs, phone tethering, other VPNs): an address in the range on another interface would
 * open the port to strangers on that network. Windows and Linux name the interface after Tailscale;
 * macOS only numbers its tunnels (utunN).
 */
function isTailscaleInterface(name, platform) {
  return platform === 'darwin' ? /^utun\d+$/.test(name) : /tailscale/i.test(name)
}

/**
 * This PC's Tailscale IPv4 address, or null when Tailscale is not running.
 * @param {object} interfaces what os.networkInterfaces() returns
 */
function findTailnetAddress(interfaces, platform = process.platform) {
  for (const [name, list] of Object.entries(interfaces || {})) {
    if (!isTailscaleInterface(name, platform)) continue
    for (const item of list || []) {
      if (!item.internal && item.family === 'IPv4' && isTailnetIpv4(item.address)) return item.address
    }
  }
  return null
}

module.exports = { isTailnetAddress, isTailnetIpv4, findTailnetAddress }
