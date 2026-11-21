// Metro configuration for the monorepo.
//
// The app consumes the workspace packages (@triangulair/data, @triangulair/osm,
// @triangulair/import, @triangulair/crypto, @triangulair/storage, @triangulair/sync)
// straight from their TypeScript sources in ../../packages. Each package keeps
// its own lockfile, so their runtime dependencies (yjs, opening_hours, fflate, libsodium-wrappers-sumo, @scure/bip39, @noble/hashes) are also
// dependencies of this app and are resolved from apps/mobile/node_modules, even when a package has no node_modules of its own.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const appRoot = __dirname;
const repoRoot = path.resolve(appRoot, '../..');

const config = getDefaultConfig(appRoot);

const workspacePackages = {
  '@triangulair/data': path.join(repoRoot, 'packages/data'),
  '@triangulair/osm': path.join(repoRoot, 'packages/osm'),
  '@triangulair/import': path.join(repoRoot, 'packages/import'),
  '@triangulair/crypto': path.join(repoRoot, 'packages/crypto'),
  '@triangulair/storage': path.join(repoRoot, 'packages/storage'),
  '@triangulair/sync': path.join(repoRoot, 'packages/sync'),
};

config.watchFolders = [...new Set([...(config.watchFolders ?? []), ...Object.values(workspacePackages)])];
config.resolver.nodeModulesPaths = [path.join(appRoot, 'node_modules')];
// Workspace packages are not in node_modules: map their names to their folders
// (Metro then reads their package.json `exports`).
config.resolver.extraNodeModules = { ...(config.resolver.extraNodeModules ?? {}), ...workspacePackages };
// The packages' fixtures (fixture mode) are JSON files.
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'json'])];

const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // The OSM fixtures (test data of packages/osm) are only bundled in fixture
  // mode (EXPO_PUBLIC_OSM_FIXTURES=1); otherwise src/osm/fixtures.ts is empty.
  if (
    process.env.EXPO_PUBLIC_OSM_FIXTURES !== '1' &&
    moduleName === './fixtures' &&
    context.originModulePath === path.join(appRoot, 'src/osm/client.ts')
  ) {
    return { type: 'empty' };
  }
  // sql.js (web database) and libsodium have Node-only branches (`require('node:fs')`
  // behind a `process.versions.node` check) that are never taken in a browser or on a
  // phone. Metro resolves every require statically, so they must resolve to something.
  if (moduleName === 'node:fs' || moduleName === 'node:crypto') {
    return { type: 'empty' };
  }
  // lib0 (yjs) has a react-native build of `lib0/webcrypto` that needs isomorphic-webcrypto;
  // use a small shim over the polyfilled `crypto.getRandomValues` instead.
  if (platform !== 'web' && moduleName === 'lib0/webcrypto') {
    return { type: 'sourceFile', filePath: path.join(appRoot, 'src/shims/lib0-webcrypto.ts') };
  }
  // libsodium falls back to Node's `crypto` only when `crypto.getRandomValues` is missing
  // (never in a browser; on native, src/polyfills.native.ts installs it from expo-crypto).
  if (moduleName === 'crypto' && /libsodium/.test(context.originModulePath)) {
    return { type: 'empty' };
  }
  return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
