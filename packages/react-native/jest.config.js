/** @type {import('jest').Config} */
module.exports = {
  preset: '@react-native/jest-preset',
  // The preset's environment pins jest-environment-node@29; use the Jest 30 one with the same export conditions.
  testEnvironment: '<rootDir>/jest/environment.js',
  roots: ['<rootDir>/src', '<rootDir>/plugin'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  modulePathIgnorePatterns: ['<rootDir>/lib/', '<rootDir>/plugin/build/'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': ['babel-jest', { configFile: require.resolve('./babel.config.js') }],
  },
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-webview)/)'],
  moduleNameMapper: {
    // Keep the 757 KiB engine bundle out of unit tests.
    '^@maprama/engine-web/engine-html$': '<rootDir>/jest/engine-html.js',
    // Fake WebView that records postMessage calls and lets tests emit engine events.
    '^react-native-webview$': '<rootDir>/jest/react-native-webview.tsx',
  },
};
