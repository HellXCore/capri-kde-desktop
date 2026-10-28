'use strict';
const path = require('node:path');
const { verifyMacSignature } = require('./verify-mac-signature');

// Fail before installers and update checksums are produced if the final bundle is not sealed.
module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  verifyMacSignature(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
};
