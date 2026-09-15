import { useState, type ReactNode, type RefObject } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MapramaView, type MapramaErrorEvent, type MapramaViewProps, type MapramaViewRef } from '@maprama/react-native';

export interface DemoMapProps extends Omit<MapramaViewProps, 'style' | 'testID' | 'children'> {
  mapRef?: RefObject<MapramaViewRef | null>;
  children?: ReactNode;
}

/**
 * `MapramaView` plus a status badge used by the Maestro flows: the text of
 * `testID="engine-status"` becomes `engine ready` after `onReady`. The last
 * error is shown under it (`testID="engine-last-error"`).
 */
export function DemoMap({ mapRef, onReady, onError, ui, children, ...rest }: DemoMapProps) {
  const [status, setStatus] = useState('engine loading');
  const [lastError, setLastError] = useState<MapramaErrorEvent | null>(null);
  return (
    <View style={styles.wrap}>
      <MapramaView
        {...rest}
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        testID="maprama-map"
        ui={{ attribution: true, scaleBar: true, ...ui }}
        onReady={(event) => {
          setStatus('engine ready');
          onReady?.(event);
        }}
        onError={(event) => {
          setLastError(event);
          if (event.fatal && event.code !== 'drops_fetch_failed') setStatus(`engine error: ${event.code}`);
          onError?.(event);
        }}
      >
        {children}
      </MapramaView>
      <View pointerEvents="none" style={styles.badge}>
        <Text testID="engine-status" style={styles.badgeText}>
          {status}
        </Text>
        {lastError ? (
          <Text testID="engine-last-error" style={styles.errorText} numberOfLines={2}>
            {lastError.code}: {lastError.message}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#dfe6ee' },
  badge: { position: 'absolute', top: 8, left: 8, right: 8, alignItems: 'flex-start' },
  badgeText: {
    backgroundColor: 'rgba(15,23,42,0.75)',
    color: 'white',
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: 'hidden',
  },
  errorText: {
    marginTop: 4,
    backgroundColor: 'rgba(185,28,28,0.85)',
    color: 'white',
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
    maxWidth: '100%',
  },
});
