package dev.maprama.enginenative

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.MapramaNativeViewManagerDelegate
import com.facebook.react.viewmanagers.MapramaNativeViewManagerInterface

/** Fabric view manager of `MapramaNativeView` (codegen spec `MapramaNativeViewNativeComponent.ts`). */
@ReactModule(name = MapramaNativeViewManager.NAME)
class MapramaNativeViewManager :
  SimpleViewManager<MapramaNativeView>(),
  MapramaNativeViewManagerInterface<MapramaNativeView> {
  private val delegate = MapramaNativeViewManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<MapramaNativeView> = delegate

  override fun getName(): String = NAME

  override fun createViewInstance(context: ThemedReactContext): MapramaNativeView = MapramaNativeView(context)

  @ReactProp(name = "engineId")
  override fun setEngineId(view: MapramaNativeView, value: String?) {
    view.setEngineId(value)
  }

  override fun onDropViewInstance(view: MapramaNativeView) {
    view.destroy()
    super.onDropViewInstance(view)
  }

  companion object {
    const val NAME = "MapramaNativeView"
  }
}
