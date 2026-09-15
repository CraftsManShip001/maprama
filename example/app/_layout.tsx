import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerBackTitle: 'Catalog' }}>
        <Stack.Screen name="index" options={{ title: 'Maprama Catalog' }} />
        <Stack.Screen name="themes" options={{ title: 'Themes' }} />
        <Stack.Screen name="world" options={{ title: 'Real data vs procedural' }} />
        <Stack.Screen name="character" options={{ title: 'Character & location' }} />
        <Stack.Screen name="travel" options={{ title: 'Travel' }} />
        <Stack.Screen name="drops" options={{ title: 'Drops' }} />
        <Stack.Screen name="labels" options={{ title: 'Labels' }} />
        <Stack.Screen name="buildings" options={{ title: 'Geofence & buildings' }} />
        <Stack.Screen name="multiplayer" options={{ title: 'Overlays & multiplayer' }} />
        <Stack.Screen name="native" options={{ title: 'Native engine (M2c)' }} />
        <Stack.Screen name="native-game" options={{ title: 'Native engine (M3b)' }} />
      </Stack>
    </>
  );
}
