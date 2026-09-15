const { TestEnvironment } = require('jest-environment-node');

module.exports = class ReactNativeEnv extends TestEnvironment {
  customExportConditions = ['require', 'react-native'];
};
