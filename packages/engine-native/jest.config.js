/** @type {import('jest').Config} */
module.exports = {
  preset: '@react-native/jest-preset',
  // The preset's environment pins jest-environment-node@29; use the Jest 30 one with the same export conditions.
  testEnvironment: '<rootDir>/jest/environment.js',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  modulePathIgnorePatterns: ['<rootDir>/lib/', '<rootDir>/build/'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': ['babel-jest', { configFile: require.resolve('./babel.config.js') }],
  },
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-webview)/)'],
  moduleNameMapper: {
    // Test against the sources of the React Native package (no build needed) with its WebView fakes.
    '^@maprama/react-native$': '<rootDir>/../react-native/src/index.ts',
    '^@maprama/engine-web/engine-html$': '<rootDir>/../react-native/jest/engine-html.js',
    '^react-native-webview$': '<rootDir>/../react-native/jest/react-native-webview.tsx',
  },
};
