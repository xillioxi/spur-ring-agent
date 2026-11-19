const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const fs = require('fs');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  // Windows subst drives shorten native build paths, while Node resolves real paths.
  projectRoot: fs.realpathSync.native(__dirname),
  watchFolders: [fs.realpathSync.native(__dirname)],
  maxWorkers: 4,
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
