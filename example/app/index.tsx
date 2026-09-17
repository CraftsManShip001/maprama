import { Link, type Href } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

interface Entry {
  slug: string;
  href: Href;
  title: string;
  description: string;
}

const SCREENS: Entry[] = [
  { slug: 'themes', href: '/themes', title: '1. Themes', description: 'Presets, time of day, cinematic grading, massing, facade details and zoom-out behaviour over the Seongsu sample.' },
  { slug: 'world', href: '/world', title: '2. Real data vs procedural', description: 'world.kind url / data (bundled OSM Seongsu) / procedural town & grid.' },
  { slug: 'character', href: '/character', title: '3. Character & location', description: 'Player with a bundled CC0 glTF (data: URI), location source simulated / device / external joystick.' },
  { slug: 'travel', href: '/travel', title: '4. Travel', description: 'Tap a destination, pick walk / bike / car / mixed / plane / subway, live ETA from travel:progress.' },
  { slug: 'drops', href: '/drops', title: '5. Drops', description: 'Coin, CD, vinyl, note and model layers with rarity, onCollect toast, optional service drops.' },
  { slug: 'labels', href: '/labels', title: '6. Labels', description: 'Label styles incl. holo, icon tiles and content modes incl. a custom content function.' },
  { slug: 'buildings', href: '/buildings', title: '7. Geofence & buildings', description: 'Plaza geofence enter/exit log; press a building to edit color, roof, massing and state.' },
  { slug: 'multiplayer', href: '/multiplayer', title: '8. Overlays & multiplayer', description: 'CharacterLayer of simulated remote players (1 s ticks, interpolated) and a MapOverlay card on a POI.' },
  { slug: 'markers', href: '/markers', title: '9. Markers', description: 'MarkerLayer: 40 server POI pins in two faction colours with custom SVG icons, priority collision shared with the labels, partner pins that are never hidden, a selected pin, and a tap that opens a sheet at the reported screen point.' },
  { slug: 'camera', href: '/camera', title: '10. Camera limits & fitBounds', description: 'minDistanceMeters / maxDistanceMeters in real metres whatever the world scale, a 3,330 m wide view with the fog and shadow ranges stretched to match, fitBounds over 18 pins on a 1.6 km ring with dp padding, and the 40° field of view as visibleSpanMeters.' },
  { slug: 'sheet', href: '/sheet', title: '11. Bottom sheet: camera:idle & content inset', description: 'The tourism screen: an app bottom sheet over half the display. ui.contentInset moves the engine-drawn © OpenStreetMap attribution, the scale bar, the zoom buttons and the camera centre into the visible half, and camera:idle reports the resting camera with the ground bounds and the radius a "POIs near here" query needs, plus an honest reason (gesture / api / follow).' },
  { slug: 'info-card', href: '/info-card', title: '12. Info cards & focusOn', description: 'Holographic place cards (title, category, rating, badges, detail rows, action buttons) floating over a coordinate on a beam, and ref.focusOn to frame one. The engine draws and reports; the screen wires the tap → focusOn → card sequence itself, which is exactly what your app would do.' },
  { slug: 'view-mode', href: '/view-mode', title: '13. 2D ⇄ 2.5D view mode', description: 'The view prop and ref.setView (awaited) switching the same map between the tilted diorama and a flat 2D map: footprints instead of extruded buildings, no shadows, no distance fog, anchors on the ground, pitch locked at 0 — a setCamera pitch is refused with view_pitch_locked instead of silently ignored, and the pitch gesture does nothing.' },
  { slug: 'native', href: '/native', title: '14. Native engine (M2c)', description: 'engine="native": the Seongsu world as 3D MapLibre buildings in theme colours with a custom layer for roofs (gable / dome), facade windows and details, outlines and the captured flag, themes and time of day, a captured building, map / building presses, a MapOverlay card, map UI, camera presets and a project/unproject round trip.' },
  { slug: 'native-game', href: '/native-game', title: '15. Native engine (M3b)', description: 'engine="native" game systems with 3D models in the custom layer: the example glTF robot walking the simulated location source, the procedural player travelling to near / far presets with a route line and live ETA, 3D drops placed on the route and collected on the way, one of each drop item, a geofence with enter / exit events, the location puck, an occlusion close-up behind a building and 1 / 10 / 50 character crowds.' },
  { slug: 'tiles', href: '/tiles', title: '17. Tile world (nation-wide streaming)', description: 'world.kind "tiles": one PMTiles archive on a CDN, of which the engine fetches only the tiles the camera looks at. Fly Seoul → Busan (325 km) and the render anchor re-bases under you without anything moving on screen; zoom out to the archive\'s overview level; fly into the mountains, where the archive stores no tiles at all and the map shows empty ground rather than an error. Needs EXPO_PUBLIC_MAPRAMA_TILES_URL.' },
  { slug: 'native-m4', href: '/native-m4', title: '16. Native engine (M4)', description: 'The zoom-out game view (theme.zoomOut none / mapColors / keepGameView) near and beyond the far band, the performance scene of the native design (50 characters, 200 drops, 20 geofences, orbiting camera) and an engine toggle that renders the same scene with engine-web or engine-native.' },
];

export default function CatalogIndex() {
  return (
    <FlatList
      testID="catalog-list"
      style={styles.list}
      contentContainerStyle={styles.content}
      data={SCREENS}
      keyExtractor={(item) => item.slug}
      ListHeaderComponent={
        <Text style={styles.intro}>
          Every @maprama/react-native feature, one screen each. Map data on real-data screens: © OpenStreetMap contributors (ODbL).
        </Text>
      }
      renderItem={({ item }) => (
        <Link href={item.href} asChild>
          <Pressable testID={`nav-${item.slug}`} accessibilityRole="button" style={styles.card}>
            <View>
              <Text style={styles.title}>{item.title}</Text>
              <Text style={styles.description}>{item.description}</Text>
            </View>
          </Pressable>
        </Link>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: '#f1f5f9' },
  content: { padding: 12, gap: 10 },
  intro: { fontSize: 13, color: '#475569', marginBottom: 4 },
  card: { backgroundColor: 'white', borderRadius: 12, padding: 14, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  title: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  description: { marginTop: 4, fontSize: 13, color: '#475569' },
});
