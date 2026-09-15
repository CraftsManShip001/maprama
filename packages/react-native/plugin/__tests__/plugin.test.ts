import { describe, expect, it } from '@jest/globals';
import type { ExpoConfig } from '@expo/config-types';
import withMaprama, {
  ANDROID_FEATURES_META,
  DEFAULT_LOCATION_PERMISSION_TEXT,
  IOS_FEATURES_KEY,
  applyAndroidManifest,
  applyInfoPlist,
} from '../src';

type Manifest = Parameters<typeof applyAndroidManifest>[0];

const emptyManifest = (): Manifest => ({
  manifest: {
    $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
    'uses-permission': [],
    queries: [],
    application: [{ $: { 'android:name': '.MainApplication' } }],
  },
});

describe('Info.plist', () => {
  it('adds the location usage description and features', () => {
    const plist = applyInfoPlist({}, { features: ['drops', 'travel'], locationPermissionText: 'Show you on the map' });
    expect(plist.NSLocationWhenInUseUsageDescription).toBe('Show you on the map');
    expect(plist[IOS_FEATURES_KEY]).toEqual(['drops', 'travel']);
  });

  it('keeps an existing description when no text is given, defaults otherwise', () => {
    expect(applyInfoPlist({ NSLocationWhenInUseUsageDescription: 'mine' }, {}).NSLocationWhenInUseUsageDescription).toBe('mine');
    const plist = applyInfoPlist({}, undefined);
    expect(plist.NSLocationWhenInUseUsageDescription).toBe(DEFAULT_LOCATION_PERMISSION_TEXT);
    expect(plist[IOS_FEATURES_KEY]).toEqual(['characters', 'drops', 'labels', 'travel']);
  });

  it('skips location with location: false', () => {
    expect(applyInfoPlist({}, { location: false }).NSLocationWhenInUseUsageDescription).toBeUndefined();
  });

  it('rejects unknown features', () => {
    expect(() => applyInfoPlist({}, { features: ['teleport' as never] })).toThrow(/unknown feature "teleport"/);
  });
});

describe('AndroidManifest', () => {
  it('adds location permissions and the features meta-data', () => {
    const manifest = applyAndroidManifest(emptyManifest(), { features: ['characters', 'labels'] });
    const permissions = manifest.manifest['uses-permission']!.map((p) => p.$['android:name']);
    expect(permissions).toEqual(['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION']);
    const meta = manifest.manifest.application![0]!['meta-data']!;
    expect(meta).toEqual([{ $: { 'android:name': ANDROID_FEATURES_META, 'android:value': 'characters,labels' } }]);

    // Idempotent.
    applyAndroidManifest(manifest, { features: ['characters', 'labels'] });
    expect(manifest.manifest['uses-permission']).toHaveLength(2);
    expect(manifest.manifest.application![0]!['meta-data']).toHaveLength(1);
  });

  it('skips permissions with location: false', () => {
    const manifest = applyAndroidManifest(emptyManifest(), { location: false });
    expect(manifest.manifest['uses-permission']).toEqual([]);
  });
});

describe('config plugin', () => {
  it('registers iOS and Android mods that apply the changes', async () => {
    const base: ExpoConfig = { name: 'app', slug: 'app' };
    const config = withMaprama(base, { features: ['drops'], locationPermissionText: 'Find drops near you' }) as ExpoConfig & {
      mods: { ios: { infoPlist: (c: unknown) => Promise<{ modResults: Record<string, unknown> }> }; android: { manifest: (c: unknown) => Promise<{ modResults: Manifest }> } };
    };
    const ios = await config.mods.ios.infoPlist({ ...config, modResults: {}, modRequest: { platform: 'ios', projectRoot: '/tmp', platformProjectRoot: '/tmp/ios', modName: 'infoPlist', introspect: false } });
    expect(ios.modResults.NSLocationWhenInUseUsageDescription).toBe('Find drops near you');
    expect(ios.modResults[IOS_FEATURES_KEY]).toEqual(['drops']);

    const android = await config.mods.android.manifest({ ...config, modResults: emptyManifest(), modRequest: { platform: 'android', projectRoot: '/tmp', platformProjectRoot: '/tmp/android', modName: 'manifest', introspect: false } });
    expect(android.modResults.manifest['uses-permission']!.map((p) => p.$['android:name'])).toContain('android.permission.ACCESS_FINE_LOCATION');
  });

  it('throws on invalid options when applied', () => {
    expect(() => withMaprama({ name: 'app', slug: 'app' }, { features: 'drops' as never })).toThrow(/must be an array/);
  });
});
