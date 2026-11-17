/**
 * Expo config on top of app.json.
 *
 * TL_FREE_SIGNING=1 prepares an iOS build that a free Apple ID ("Personal Team"
 * in Xcode) can sign and install on its own iPhone:
 * - removes Associated Domains (universal links), which a Personal Team cannot
 *   sign; invitation and list links then open in the browser / paste field;
 * - uses a bundle identifier unique to you (TL_IOS_BUNDLE_ID, default
 *   org.triangulair.app.dev), since free provisioning needs one not registered
 *   by someone else.
 * See docs/run-on-iphone.md.
 */
module.exports = ({ config }) => {
  if (process.env.TL_FREE_SIGNING !== '1') return config;
  const ios = { ...(config.ios ?? {}) };
  delete ios.associatedDomains;
  ios.bundleIdentifier = process.env.TL_IOS_BUNDLE_ID || `${ios.bundleIdentifier}.dev`;
  return { ...config, ios };
};
