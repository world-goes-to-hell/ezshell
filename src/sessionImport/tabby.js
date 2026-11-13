// Tabby's config.yaml: `profiles` (type ssh: options.host/port/user/auth/privateKeys/jumpHost) and
// `groups` (id → name; older versions put the group name on the profile). jumpHost is the id of
// another profile, resolved to its address. Passwords live in the OS key store or Tabby's vault:
// not read.

const { createCollector, MAX_FILE_BYTES } = require('./model.js');

/** "file://C:\\keys\\id" or a plain path */
function keyFile(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/^file:\/\/\/?/i, (m) => (/^file:\/\/\/[A-Za-z]:/i.test(value) ? '' : m === 'file:///' ? '/' : ''));
}

function readTabbyText(text) {
  const yaml = require('js-yaml');
  let config;
  try {
    // js-yaml 4's load() uses the default schema: plain data only, no code or custom types
    config = yaml.load(String(text), { json: true });
  } catch {
    throw new Error('Tabby 설정 파일을 읽지 못했습니다.');
  }
  const collector = createCollector('tabby', 'Tabby');
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  const groups = new Map((Array.isArray(config?.groups) ? config.groups : [])
    .filter(g => g && typeof g.id === 'string')
    .map(g => [g.id, typeof g.name === 'string' ? g.name : '']));
  const byId = new Map(profiles.filter(p => p && typeof p.id === 'string').map(p => [p.id, p]));

  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    if (profile.type !== 'ssh') {
      if (profile.type) collector.skip(`${String(profile.type).slice(0, 20)} 프로필`);
      continue;
    }
    const options = profile.options && typeof profile.options === 'object' ? profile.options : {};
    const groupName = typeof profile.group === 'string' ? (groups.get(profile.group) ?? profile.group) : '';
    const jumpProfile = typeof options.jumpHost === 'string' ? byId.get(options.jumpHost) : null;
    const jumpOptions = jumpProfile?.options && typeof jumpProfile.options === 'object' ? jumpProfile.options : null;
    const keys = Array.isArray(options.privateKeys) ? options.privateKeys : [];
    collector.add({
      name: profile.name,
      host: options.host,
      port: options.port,
      username: options.user,
      privateKeyPath: keyFile(keys.find(k => typeof k === 'string') ?? ''),
      // A password Tabby keeps is not in this file; one written into it is not read either
      hasSavedPassword: typeof options.password === 'string' && options.password !== '' ? true : null,
      jump: jumpOptions ? { host: jumpOptions.host, port: jumpOptions.port, username: jumpOptions.user } : null,
      folderId: collector.folderFor(groupName ? [groupName] : [])
    });
  }
  return collector.result();
}

function readTabbyFile(buffer) {
  if (buffer.length > MAX_FILE_BYTES) throw new Error('파일이 너무 큽니다.');
  return readTabbyText(buffer.toString('utf8'));
}

module.exports = { readTabbyText, readTabbyFile };
