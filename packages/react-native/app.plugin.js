// Expo config plugin entry: `plugins: [['@maprama/react-native', { features: ['drops'] }]]`.
const plugin = require('./plugin/build');

module.exports = plugin.default || plugin;
