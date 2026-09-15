/**
 * Expo config plugin for `@maprama/react-native`.
 *
 * ```json
 * { "expo": { "plugins": [["@maprama/react-native", { "features": ["characters", "drops"], "locationPermissionText": "Show you on the map" }]] } }
 * ```
 *
 * - Adds iOS `NSLocationWhenInUseUsageDescription` and Android
 *   `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` for `location.source: 'device'`
 *   (opt out with `location: false`).
 * - Records `features` in `Info.plist` (`MapramaFeatures`) and the Android
 *   manifest (`dev.maprama.features` meta-data). The v1 engine is JavaScript and
 *   ignores them; a future native engine uses them to strip unused modules.
 */

import {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withInfoPlist,
  type ConfigPlugin,
  type InfoPlist,
} from '@expo/config-plugins';

/** Optional engine feature modules. */
export const MAPRAMA_FEATURES = ['characters', 'drops', 'labels', 'travel'] as const;
/** An optional engine feature module. */
export type MapramaFeature = (typeof MAPRAMA_FEATURES)[number];

/** Plugin options. */
export interface MapramaPluginProps {
  /** Engine features the app uses. Default: all. */
  features?: MapramaFeature[];
  /** iOS location permission text. */
  locationPermissionText?: string;
  /** Add location permissions (needed for `location.source: 'device'`). Default true. */
  location?: boolean;
}

/** Default iOS permission text. */
export const DEFAULT_LOCATION_PERMISSION_TEXT = 'Allow $(PRODUCT_NAME) to use your location to show you on the map.';
/** Info.plist key holding the feature list. */
export const IOS_FEATURES_KEY = 'MapramaFeatures';
/** Android `<meta-data>` name holding the comma-separated feature list. */
export const ANDROID_FEATURES_META = 'dev.maprama.features';
/** Android permissions added for device location. */
export const ANDROID_LOCATION_PERMISSIONS = ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'];

/** Validates options and fills defaults. */
export function normalizeProps(props: MapramaPluginProps | void | null): Required<Omit<MapramaPluginProps, 'locationPermissionText'>> & Pick<MapramaPluginProps, 'locationPermissionText'> {
  const features = props?.features ?? [...MAPRAMA_FEATURES];
  if (!Array.isArray(features)) throw new Error('@maprama/react-native: "features" must be an array');
  for (const feature of features) {
    if (!(MAPRAMA_FEATURES as readonly string[]).includes(feature)) {
      throw new Error(`@maprama/react-native: unknown feature "${String(feature)}" (expected one of ${MAPRAMA_FEATURES.join(', ')})`);
    }
  }
  if (props?.locationPermissionText !== undefined && typeof props.locationPermissionText !== 'string') {
    throw new Error('@maprama/react-native: "locationPermissionText" must be a string');
  }
  return {
    features: [...new Set(features)],
    location: props?.location !== false,
    ...(props?.locationPermissionText !== undefined ? { locationPermissionText: props.locationPermissionText } : {}),
  };
}

/** Applies the plugin to an Info.plist object (mutates and returns it). */
export function applyInfoPlist(infoPlist: InfoPlist, props: MapramaPluginProps | void | null): InfoPlist {
  const options = normalizeProps(props);
  if (options.location) {
    infoPlist.NSLocationWhenInUseUsageDescription =
      options.locationPermissionText ?? infoPlist.NSLocationWhenInUseUsageDescription ?? DEFAULT_LOCATION_PERMISSION_TEXT;
  }
  infoPlist[IOS_FEATURES_KEY] = options.features;
  return infoPlist;
}

/** Applies the plugin to a parsed AndroidManifest (mutates and returns it). */
export function applyAndroidManifest(
  manifest: AndroidConfig.Manifest.AndroidManifest,
  props: MapramaPluginProps | void | null,
): AndroidConfig.Manifest.AndroidManifest {
  const options = normalizeProps(props);
  if (options.location) AndroidConfig.Permissions.ensurePermissions(manifest, ANDROID_LOCATION_PERMISSIONS);
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  AndroidConfig.Manifest.addMetaDataItemToMainApplication(application, ANDROID_FEATURES_META, options.features.join(','));
  return manifest;
}

const withMaprama: ConfigPlugin<MapramaPluginProps | void> = (config, props) => {
  normalizeProps(props); // fail fast on invalid options
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults = applyInfoPlist(cfg.modResults, props);
    return cfg;
  });
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applyAndroidManifest(cfg.modResults, props);
    return cfg;
  });
  return config;
};

export default createRunOncePlugin(withMaprama, '@maprama/react-native', '0.0.0');
