'use strict';

// electron-builder's beforePack hook (package.json build.beforePack): a macOS package gets the
// window helper built for its arch first, so it is copied into the bundle's Resources/bin
// (build.mac.extraResources). Packaging for macOS without it fails rather than ship a Capri that
// silently cannot see windows; other platforms never carry it (build.files leaves out its bin/).

const { buildMacHelper } = require('./build-mac-helper');

// electron-builder's Arch enum: ia32 0, x64 1, armv7l 2, arm64 3, universal 4
const ARCH = { 1: 'x64', 3: 'arm64' };

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = ARCH[context.arch];
  if (!arch) throw new Error(`macOS window helper: no build for arch ${context.arch} (arm64 or x64 only)`);
  buildMacHelper({ arch, required: true });
};
