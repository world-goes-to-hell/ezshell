// electron-builder afterPack hook for the macOS app: makes node-pty's helper runnable, then ad-hoc
// signs the bundle. Runs on the macOS runner only; the Windows build returns at once.
//
// 1. spawn-helper. node-pty starts every local shell through a small program, `spawn-helper`, that
//    sits next to its native module. In the npm package that file has no execute permission, and
//    then opening a local terminal fails with "posix_spawnp failed". It gets the permission here.
//
// 2. Ad-hoc signature. The build has no Apple Developer certificate (build.mac.identity is null),
//    so electron-builder signs nothing. But packing changes the bundle Electron shipped (new name,
//    the app's files, Info.plist), which breaks the signature it came with, and an Apple Silicon
//    Mac does not run code whose signature is missing or broken: it says the app "is damaged and
//    can't be opened". An ad-hoc signature ("-", no certificate) makes the bundle valid again.
//    Gatekeeper still asks about an unidentified developer on first launch, which the user can
//    allow. Signing comes last: changing a file afterwards would break the signature again.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

/** Every file called `name` under `dir` */
function findFiles(dir, name) {
  const found = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findFiles(full, name))
    else if (entry.name === name) found.push(full)
  }
  return found
}

exports.default = async function prepareMacApp(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

  const helpers = findFiles(path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty'), 'spawn-helper')
  // Without the helper no local terminal can open: better a failed build than a broken app
  if (helpers.length === 0) throw new Error('node-pty spawn-helper not found in the packed app')
  for (const helper of helpers) {
    fs.chmodSync(helper, 0o755)
    console.log(`made runnable: ${helper}`)
  }

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  // Fails the build if the result is not a valid signature
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`ad-hoc signed ${appPath}`)
}

exports.findFiles = findFiles
