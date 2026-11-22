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
 *
 * TL_WEB_BASE=/triangulair builds the web app for a sub-path (https://cloud.example.org/triangulair/)
 * instead of the root of a domain (expo-router `experiments.baseUrl`; scripts/web-base.cjs).
 * See docs/self-host-web.md.
 *
 * EXPO_PUBLIC_LINK_ORIGIN=https://links.example.net sets the address of the links the app hands
 * out (src/config.ts LINK_ORIGIN) and the matching Android App Links and iOS Associated Domains.
 * app.json holds the placeholder example.org: use a domain you control.
 */
const { webBase } = require('./scripts/web-base.cjs');

function withLinkHost(config) {
  const origin = process.env.EXPO_PUBLIC_LINK_ORIGIN;
  if (!origin) return config;
  const host = new URL(origin).host;
  const android = config.android && {
    ...config.android,
    intentFilters: (config.android.intentFilters ?? []).map((f) => ({
      ...f,
      data: (f.data ?? []).map((d) => (d.host === 'example.org' ? { ...d, host } : d)),
    })),
  };
  const ios = config.ios && {
    ...config.ios,
    associatedDomains: (config.ios.associatedDomains ?? []).map((d) => d.replace('applinks:example.org', `applinks:${host}`)),
  };
  return { ...config, ...(android && { android }), ...(ios && { ios }) };
}

module.exports = ({ config }) => {
  config = withLinkHost(config);
  const base = webBase();
  if (base) config = { ...config, experiments: { ...(config.experiments ?? {}), baseUrl: base } };
  if (process.env.TL_FREE_SIGNING !== '1') return config;
  const ios = { ...(config.ios ?? {}) };
  delete ios.associatedDomains;
  ios.bundleIdentifier = process.env.TL_IOS_BUNDLE_ID || `${ios.bundleIdentifier}.dev`;
  return { ...config, ios };
};
