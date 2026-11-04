// Algorithms every ssh2 connection offers: ssh2's defaults, then older ones that ssh2 supports but
// leaves out of its defaults. Old servers (CentOS 5/6 era OpenSSH, network devices) offer only those,
// and failed with "no matching key exchange algorithm" while PuTTY connected.
// Appended, so they come last: a server that knows a modern algorithm still gets the modern one. A
// middleman cannot strip the modern ones to force these: both algorithm lists go into the exchange
// hash the server signs, and the host key is checked (src/hostKeys). See docs/fix/2026-11-04-legacy-ssh-algorithms.md.
const constants = require('ssh2/lib/protocol/constants.js');

const LEGACY = {
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'],
  serverHostKey: ['ssh-dss'],
  cipher: ['aes128-cbc', 'aes192-cbc', 'aes256-cbc', '3des-cbc'],
  hmac: ['hmac-sha1-96', 'hmac-md5', 'hmac-md5-96']
};

/** The legacy algorithms the runtime supports; ssh2 throws on a name its crypto library lacks */
function legacyAlgorithms(supported) {
  return Object.fromEntries(Object.entries(LEGACY).map(([category, names]) => (
    [category, { append: names.filter(name => supported[category].includes(name)) }]
  )));
}

const SSH_ALGORITHMS = legacyAlgorithms({
  kex: constants.SUPPORTED_KEX,
  serverHostKey: constants.SUPPORTED_SERVER_HOST_KEY,
  cipher: constants.SUPPORTED_CIPHER,
  hmac: constants.SUPPORTED_MAC
});

module.exports = { SSH_ALGORITHMS, legacyAlgorithms };
