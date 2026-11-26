const { approvedUrl, readJson, SHA256 } = require('./download.js')
const { findJbrBuild, AGENT_LICENSE_URL, JBR_LICENSE_URL } = require('./enhancedProviders.js')

const LICENSE_URLS = {
  temurin: 'https://openjdk.org/legal/gplv2+ce.html',
  zulu: 'https://www.azul.com/products/core/openjdk-terms-of-use/',
  jbr: JBR_LICENSE_URL,
  'hotswap-agent': AGENT_LICENSE_URL
}
const ADOPTIUM_OS = { win32: 'windows', darwin: 'mac', linux: 'linux' }
const AZUL_OS = { win32: 'windows', darwin: 'macos', linux: 'linux' }
const AZUL_NAME_OS = { win32: 'win', darwin: 'macosx', linux: 'linux' }
const ARCHITECTURES = {
  x64: { adoptium: 'x64', azul: 'x86', bitness: '64', suffix: 'x64' },
  arm64: { adoptium: 'aarch64', azul: 'arm', bitness: '64', suffix: 'aarch64' },
  ia32: { adoptium: 'x32', azul: 'x86', bitness: '32', suffix: 'i686' },
  arm: { adoptium: 'arm', azul: 'arm', bitness: '32', suffix: 'aarch32hf' },
  ppc64: { adoptium: 'ppc64le' },
  s390x: { adoptium: 's390x' },
  riscv64: { adoptium: 'riscv64' }
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const VERSION = /^\d[\da-z._+-]{0,79}$/i
const featureOf = (version) => Number(/^(?:1\.)?(\d+)(?:[._+-]|$)/.exec(version ?? '')?.[1]) || null
const validSelection = (vendor, feature) => typeof vendor === 'string' && vendor !== 'hotswap-agent' && Object.hasOwn(LICENSE_URLS, vendor)
  && Number.isInteger(feature) && feature >= 6 && feature <= 25 && (vendor !== 'jbr' || feature === 17 || feature === 21)

function buildOf({ vendor, feature, arch, version, archive, url, sha256, size }) {
  const link = approvedUrl(url)
  if (!link?.pathname.endsWith(`.${archive}`) || !SHA256.test(sha256) || !VERSION.test(version) || featureOf(version) !== feature) return null
  return { vendor, feature, version, arch, archive, url: link.href, sha256, licenseUrl: LICENSE_URLS[vendor],
    ...(Number.isSafeInteger(size) && size > 0 ? { sizeBytes: size } : {}) }
}

function parseTemurin(data, { feature, platform, arch }) {
  const archive = platform === 'win32' ? 'zip' : 'tar.gz'
  for (const release of Array.isArray(data) ? data : []) {
    const binaries = Array.isArray(release?.binaries) ? release.binaries : []
    const binary = binaries.find(item => item?.image_type === 'jdk' && item.os === ADOPTIUM_OS[platform] && item.architecture === ARCHITECTURES[arch]?.adoptium)
    if (!binary) continue
    const { link, checksum, size } = binary.package ?? {}
    const result = buildOf({ vendor: 'temurin', feature, arch, archive, version: release.version_data?.openjdk_version, url: link, sha256: checksum, size })
    if (result) return result
  }
  return null
}

const isVersion = (version, feature) => Array.isArray(version) && version[0] === feature && version.length <= 6
  && version.every(number => Number.isSafeInteger(number) && number >= 0)

function compareParts(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

function pickZulu(data, { feature, platform, arch }) {
  const archive = platform === 'win32' ? 'zip' : 'tar.gz'
  const suffix = ARCHITECTURES[arch]?.suffix
  // Azul can return a 32-bit build and several variants even with a bitness filter.
  return (Array.isArray(data) ? data : []).filter(row => row?.availability_type === 'CA' && UUID.test(row.package_uuid)
    && isVersion(row.java_version, feature) && typeof row.name === 'string' && suffix
    && row.name.includes('-ca-jdk') && row.name.endsWith(`-${AZUL_NAME_OS[platform]}_${suffix}.${archive}`))
    .sort((a, b) => compareParts(a.java_version, b.java_version) || (b.openjdk_build_number ?? 0) - (a.openjdk_build_number ?? 0))[0] ?? null
}

function parseZulu(data, row, { feature, platform, arch }) {
  const cpu = ARCHITECTURES[arch]
  const archive = platform === 'win32' ? 'zip' : 'tar.gz'
  if (data?.package_uuid !== row.package_uuid || data.name !== row.name || data.availability_type !== 'CA'
    || data.os !== AZUL_OS[platform] || data.arch !== cpu.azul || String(data.hw_bitness) !== cpu.bitness
    || (platform === 'linux' && data.lib_c_type !== 'glibc') || data.java_package_type !== 'jdk'
    || data.archive_type !== archive || !isVersion(data.java_version, feature)) return null
  const build = data.openjdk_build_number
  const version = data.java_version.join('.') + (Number.isSafeInteger(build) && build > 0 ? `+${build}` : '')
  return buildOf({ vendor: 'zulu', feature, arch, archive, version, url: data.download_url, sha256: data.sha256_hash, size: data.size })
}

async function findBuild(vendor, feature, { platform, arch, request, signal }) {
  if (!validSelection(vendor, feature)) throw new Error('JDK 공급자와 버전을 선택해 주세요.')
  if (vendor === 'jbr') return findJbrBuild(feature, { platform, arch, request, signal })
  const spec = { feature, platform, arch }
  const cpu = ARCHITECTURES[arch]
  const options = { request, signal }
  if (vendor === 'temurin') {
    if (!ADOPTIUM_OS[platform] || !cpu?.adoptium || feature < 8) return null
    const query = new URLSearchParams({ architecture: cpu.adoptium, os: ADOPTIUM_OS[platform], image_type: 'jdk',
      heap_size: 'normal', jvm_impl: 'hotspot', vendor: 'eclipse', page: '0', page_size: '3' })
    return parseTemurin(await readJson(`https://api.adoptium.net/v3/assets/feature_releases/${feature}/ga?${query}`, options), spec)
  }
  if (!AZUL_OS[platform] || !cpu?.azul) return null
  const base = 'https://api.azul.com/metadata/v1/zulu/packages/'
  const query = new URLSearchParams({ java_version: String(feature), os: platform === 'linux' ? 'linux-glibc' : AZUL_OS[platform], arch: cpu.azul, hw_bitness: cpu.bitness,
    archive_type: platform === 'win32' ? 'zip' : 'tar.gz', java_package_type: 'jdk', release_status: 'ga', availability_types: 'CA',
    latest: 'true', javafx_bundled: 'false', crac_supported: 'false' })
  const row = pickZulu(await readJson(`${base}?${query}`, options), spec)
  return row ? parseZulu(await readJson(`${base}${row.package_uuid}`, options), row, spec) : null
}

module.exports = { findBuild, parseTemurin, parseZulu, pickZulu, featureOf, validSelection, VERSION, LICENSE_URLS }
