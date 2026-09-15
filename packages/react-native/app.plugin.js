// Expo config plugin entry: `plugins: [['@diorama/react-native', { features: ['drops'] }]]`.
const plugin = require('./plugin/build');

module.exports = plugin.default || plugin;
