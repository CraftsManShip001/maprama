// React Native / Expo autolinking: the podspec sits at the package root, the Android library in android/.
module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import dev.maprama.enginenative.MapramaEnginePackage;',
        packageInstance: 'new MapramaEnginePackage()',
        componentDescriptors: ['MapramaNativeViewComponentDescriptor'],
        cmakeListsPath: 'build/generated/source/codegen/jni/CMakeLists.txt',
      },
    },
  },
};
