// Metro configuration for the monorepo.
//
// The app consumes the workspace packages (@triangulair/data, @triangulair/osm)
// straight from their TypeScript sources in ../../packages. Each package keeps
// its own lockfile, so their runtime dependencies (@automerge/automerge,
// opening_hours) are also dependencies of this app and are resolved from
// apps/mobile/node_modules, even when a package has no node_modules of its own.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const appRoot = __dirname;
const repoRoot = path.resolve(appRoot, '../..');

const config = getDefaultConfig(appRoot);

const workspacePackages = {
  '@triangulair/data': path.join(repoRoot, 'packages/data'),
  '@triangulair/osm': path.join(repoRoot, 'packages/osm'),
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
  // Automerge on web: the "browser" entry imports a .wasm file, which Metro
  // cannot bundle. The base64 build inlines the WebAssembly module instead.
  // (Temporary: packages/data is moving from Automerge to Yjs.)
  if (platform === 'web' && moduleName === '@automerge/automerge') {
    return {
      type: 'sourceFile',
      filePath: path.join(appRoot, 'node_modules/@automerge/automerge/dist/cjs/fullfat_base64.cjs'),
    };
  }
  // sql.js (web database) has Node-only branches that are never taken in a browser.
  if (platform === 'web' && (moduleName === 'node:fs' || moduleName === 'node:crypto')) {
    return { type: 'empty' };
  }
  return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
