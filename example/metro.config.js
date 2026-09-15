// Learn more: https://docs.expo.dev/guides/customizing-metro/
// Expo auto-configures npm-workspaces monorepos (watchFolders / nodeModulesPaths at the repo root),
// so the default config is all this app needs. The whole repo uses one copy of react / react-native.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
