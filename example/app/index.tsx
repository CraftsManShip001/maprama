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
  { slug: 'native', href: '/native', title: '9. Native engine (M2c)', description: 'engine="native": the Seongsu world as 3D MapLibre buildings in theme colours with a custom layer for roofs (gable / dome), facade windows and details, outlines and the captured flag, themes and time of day, a captured building, map / building presses, a MapOverlay card, map UI, camera presets and a project/unproject round trip.' },
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
