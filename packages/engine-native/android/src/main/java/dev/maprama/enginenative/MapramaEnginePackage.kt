package dev.maprama.enginenative

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager

/** Autolinked package: the `MapramaEngineModule` TurboModule and the `MapramaNativeView` Fabric view. */
class MapramaEnginePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == MapramaEngineModule.NAME) MapramaEngineModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      MapramaEngineModule.NAME to
        ReactModuleInfo(
          MapramaEngineModule.NAME,
          MapramaEngineModule::class.java.name,
          false, // canOverrideExistingModule
          false, // needsEagerInit
          false, // isCxxModule
          true, // isTurboModule
        ),
    )
  }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    listOf(MapramaNativeViewManager())
}
