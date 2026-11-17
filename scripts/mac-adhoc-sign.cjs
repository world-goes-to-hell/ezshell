// electron-builder afterPack hook: ad-hoc signs the macOS app.
//
// The macOS build has no Apple Developer certificate (build.mac.identity is null), so
// electron-builder signs nothing. But packing changes the bundle Electron shipped (new name, the
// app's files, Info.plist), which breaks the signature it came with, and an Apple Silicon Mac does
// not run code whose signature is missing or broken: it says the app "is damaged and can't be
// opened". An ad-hoc signature ("-", no certificate) makes the bundle valid again. Gatekeeper still
// asks about an unidentified developer on first launch, which the user can allow.
//
// Runs on the macOS runner only; the Windows build returns at once.

const path = require('path')
const { execFileSync } = require('child_process')

exports.default = async function adHocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  // Fails the build if the result is not a valid signature
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`ad-hoc signed ${appPath}`)
}
