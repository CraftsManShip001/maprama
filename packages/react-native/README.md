# @maprama/react-native

A 2.5D game map for React Native. It supports characters, multi-mode travel, collectible drops, holographic labels, geofences and React Native views pinned to map coordinates.

The map is declarative: you describe it with components, drive it with an imperative `ref` API, and opt in to continuous values (character position, camera) through hooks. Rendering runs in a swappable **engine host**. The v1 host runs `@maprama/engine-web` inside `react-native-webview`. A future native engine can replace it without changing app code.

## Requirements

- React Native **0.76+ with the New Architecture enabled** (Fabric). The old architecture is not supported.
- iOS 15.1+, Android API 24+.
- `react` 18.3+ / 19, `react-native-webview` 13.12+.

## Install

### Bare React Native

```sh
npm i @maprama/react-native react-native-webview
cd ios && pod install
```

For `location={{ source: 'device' }}`, add the location permissions yourself:

- iOS `Info.plist`: `NSLocationWhenInUseUsageDescription`.
- Android `AndroidManifest.xml`: `android.permission.ACCESS_FINE_LOCATION` (and `ACCESS_COARSE_LOCATION`).

### Expo (development build / prebuild)

```sh
npx expo install @maprama/react-native react-native-webview
# optional, recommended for device location:
npx expo install expo-location
```

```json
{
  "expo": {
    "plugins": [
      ["@maprama/react-native", { "features": ["characters", "drops", "labels", "travel"], "locationPermissionText": "Show you on the map" }]
    ]
  }
}
```

Config plugin options:

| Option | Type | Default | Effect |
| --- | --- | --- | --- |
| `features` | `('characters' \| 'drops' \| 'labels' \| 'travel')[]` | all | Recorded in `Info.plist` (`MapramaFeatures`) and as Android `<meta-data android:name="dev.maprama.features">`. The v1 JavaScript engine ignores it; a future native engine will use it to strip unused modules. |
| `locationPermissionText` | `string` | a generic text | iOS `NSLocationWhenInUseUsageDescription`. |
| `location` | `boolean` | `true` | Adds the iOS usage description and Android `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`. Set `false` if you never use `location.source: 'device'`. |

## Quick start

```tsx
import { useRef } from 'react';
import {
  MapramaView, Character, CharacterLayer, DropLayer, Geofence, MapOverlay,
  useCharacterPosition, type MapramaViewRef,
} from '@maprama/react-native';
import urban from '@maprama/protocol/themes/urban.json'; // or simply base: 'urban'

export function GameMap() {
  const map = useRef<MapramaViewRef>(null);
  const me = useCharacterPosition(map, 'me', { throttleMs: 500 });

  return (
    <MapramaView
      ref={map}
      world={{ kind: 'url', url: 'https://api.example/v1/worlds/seoul-seongsu.json?key=...' }}
      theme={{ base: urban, timeOfDay: 'golden', buildings: { massing: 'varied', details: true }, zoomOut: 'keepGameView' }}
      labels={{
        enabled: true, style: 'holo', icons: 'auto',
        content: (label) => (label.category === 'music' ? { title: label.name, subtitle: '3 drops today', icon: 'music' } : { title: label.name }),
      }}
      ui={{ locationPuck: true, scaleBar: true, zoomButtons: true, attribution: true }}
      camera={{ pitch: 45, distance: 60, follow: 'me' }}
      location={{ source: 'device' }}
      onReady={() => console.log('ready')}
      onPress={(e) => map.current?.travel('me', e.coordinate, ['walk', 'car', 'walk'])}
      onBuildingPress={(e) => map.current?.setBuildingStyle(e.buildingId, { roof: 'gable', state: 'captured' })}
      onError={(e) => console.warn(e.code, e.message)}
      style={{ flex: 1 }}
    >
      <Character id="me" isPlayer model={require('./hero.glb')} animations={{ walk: 'Walking_Loop' }} follow="location" />
      <CharacterLayer data={nearbyPlayers} getId={(p) => p.id} getPosition={(p) => p.coord} getModel={(p) => p.avatarUrl} />
      <DropLayer id="music" data={tracks} getId={(t) => t.id} getCoordinate={(t) => t.coord} getType={() => 'cd'}
        getRarity={(t) => t.rarity} getPayload={(t) => ({ trackId: t.id })} collectRadiusMeters={15} onCollect={(e) => verifyOnServer(e)} />
      <Geofence id="plaza" center={plaza} radiusMeters={60} onEnter={() => {}} onExit={() => {}} />
      <MapOverlay coordinate={shop.coord} anchor="bottom"><ShopCard /></MapOverlay>
    </MapramaView>
  );
}
```

`world.kind` can also be `'data'` (`{ kind: 'data', world }`) or `'procedural'` (`{ kind: 'procedural', layout: 'town' }`).

## API

### Components

| Component | Purpose | Key props |
| --- | --- | --- |
| `MapramaView` | Hosts the engine and owns all children. | `world` (read at init), `theme`, `labels`, `ui` (incl. `contentInset`), `camera`, `location`, `engine`, `requestTimeoutMs`, `travelStartTimeoutMs`, `onReady`, `onPress`, `onBuildingPress`, `onError`, `style`, `testID` |
| `Character` | One character (the player or an actor). | `id`, `isPlayer`, `model`, `animations`, `follow` (`'location'` \| `'none'`), `position`, `name`, `color`, `scale`, `showNameTag` |
| `CharacterLayer` | Many characters from app data. | `data`, `getId`, `getPosition`, `getModel`, `getName`, `getColor`, `getScale`, `getAnimations`, `showNameTags` |
| `DropLayer` | Collectible drops from app data or the hosted service. | `id`, `collectRadiusMeters` (15), `collectorIds`, `onCollect`; data: `data`, `getId`, `getCoordinate`, `getType`, `getRarity`, `getValue`, `getModel`, `getPayload`; service: `source="service"`, `channel`, `apiKey`, `baseUrl`, `userId`, `radiusMeters`, `refetchDistanceMeters` (150), `characterId`, `positionThrottleMs` (1000), `onCollectVerified`, `onCollectRejected` |
| `Geofence` | Circular geofence. | `id`, `center`, `radiusMeters`, `onEnter`, `onExit` |
| `MapOverlay` | A React Native view pinned to a coordinate. | `coordinate`, `anchor` (`'bottom'`), `offset`, `hideWhenOffscreen` (true), `id`, `style`, `pointerEvents` |

Prop changes become minimal protocol commands. `theme` → `setTheme`, `labels` → `setLabels`, `ui` → `setUi`, and changed camera fields only → `setCamera`. Children register through React context. Their specs are diffed and batched into at most one command per kind per animation frame (`upsertCharacters` / `removeCharacters`, `setDropLayer` / `removeDropLayer`, `setGeofences`, `setOverlayAnchors`, `setLabelContent`). Commands issued before the engine reports `ready` are queued and flushed in order right after `init`.

`labels.content` may be a function. It is evaluated in JavaScript, never per frame: once per `labelsIndex` event (when the world loads), once when a non-function field of `labels` changes, and when you call `ref.refreshLabelContent()`. The latest function is always used, but a new function identity alone (an inline arrow) does not re-evaluate. Call `refreshLabelContent()` when data the function reads changes.

Models: `require('./hero.glb')` asset numbers are resolved with `Image.resolveAssetSource(n).uri`; strings are used as URIs.

`MapOverlay` positions come from the engine's `overlay:positions` events and are applied to `Animated` values, so overlays follow the camera without re-rendering React.

### Ref API (`MapramaViewRef`)

Available through `ref` on `MapramaView`, or through `useMapramaView()` inside it.

| Method | Returns | Notes |
| --- | --- | --- |
| `travel(characterId, to, modes?, options?)` | `Promise<TravelResult>` | Resolves on `travel:arrive`. Rejects with `MapramaError` code `travel_cancelled`, `timeout`, `engine_reloaded` or `unmounted`. `options.timeoutMs` bounds the whole trip; `startTimeoutMs` bounds the wait for `travel:start`. |
| `cancelTravel(characterId)` | `void` | |
| `setCamera(camera)` | `void` | Unset fields keep their value. Also where `minDistanceMeters` / `maxDistanceMeters` are changed after mount. |
| `pushLocation(fix)` | `void` | For `location.source: 'external'`. |
| `setBuildingStyle(buildingId, style \| null)` | `void` | |
| `project(coordinate, options?)` | `Promise<ScreenPoint>` | Request/response correlated by `requestId`; times out after `requestTimeoutMs` (5000). |
| `refreshLabelContent()` | `void` | Re-evaluates a `labels.content` function for all labels; changed entries go out with the next frame. |
| `unproject(point, options?)` | `Promise<LngLat \| null>` | |
| `snapToRoad(coordinate, maxDistanceMeters?, options?)` | `Promise<SnapToRoadResult \| null>` | |
| `route(from, to, modes?, options?)` | `Promise<RouteResult>` | |
| `fitBounds(bounds, options?)` | `Promise<FitBoundsResult>` | Frames a `{ ne, sw }` box: `padding` in dp (a number or per side), optional `pitch` / `bearing`, `orientation` (`auto` / `keep` / `reset`), `animate`. Resolves with the camera it moved to, `fitted` and `distanceLimited`. |
| `request(method, params, options?)` | `Promise<result>` | Low-level request. |
| `subscribe(topic, listener, { id?, throttleMs? })` | `() => void` | `character:position`, `camera:change`, `travel:progress`, `camera:idle`. Engine subscriptions are shared and reference-counted. |
| `addEventListener(type, listener)` | `() => void` | Any engine event. |
| `getEngineInfo()` / `isReady()` | | |

Timeouts are read from the latest `requestTimeoutMs` / `travelStartTimeoutMs` props (or the per-call options) whenever a timer is armed. A call made before the engine is ready arms the timeout right away. If the engine is not ready in time, the promise rejects with `timeout` and the queued command is dropped. When the command reaches the engine, the timeout restarts. A fatal host failure (`host_load_failed`, or no host registered for `engine`) rejects every pending request and travel with that code.

### Hooks

| Hook | Returns |
| --- | --- |
| `useMapramaView()` | The enclosing map's `MapramaViewRef` (throws outside `MapramaView`). |
| `useCharacterPosition(map, characterId, { throttleMs })` | Latest `{ coordinate, headingDeg, speedMps }` or `null`. Subscribes on mount, unsubscribes on unmount. |
| `useCameraState(map, { throttleMs })` | Latest camera state or `null`. |
| `useCameraIdle(map, { throttleMs })` | Latest `{ camera, bounds, radiusMeters, reason }` from `camera:idle`, or `null`. |

`map` may be a `useRef<MapramaViewRef>()` object, the API itself, or `null` inside `MapramaView` (uses the enclosing map). The map may mount after the hook, e.g. when it is rendered conditionally. The hooks subscribe as soon as it mounts and follow a remounted map.

### The camera stopped: `camera:idle`

`camera:change` fires all the way through a gesture. `camera:idle` fires once, 150 ms after the camera came to rest — after a gesture, a zoom button, a `setCamera` / `fitBounds` animation, or a followed character settling — and carries everything a "what is near here?" query needs:

```tsx
const idle = useCameraIdle(map, { throttleMs: 500 });
useEffect(() => {
  if (!idle) return;
  void loadPois(snapToGrid(idle.camera.center, 0.005), idle.radiusMeters);
}, [idle]);
```

- `camera` — the resting camera. `center` is the centre of the **visible** area (see `ui.contentInset`).
- `bounds` — `{ ne, sw }`, the north-aligned box around the ground the visible area covers. At a pitch above 0 that ground is a trapezoid, so the box is a superset of it.
- `radiusMeters` — always present: the distance from `camera.center` to the farthest corner of the visible area, i.e. the circle that contains everything on screen. It is the circumscribed radius on purpose, so a radius query never drops the POIs in the corners of the screen. A tilted camera looking towards the horizon is clamped to 6 × `camera.distance` (the engine's far plane), so the number is always usable.
- `reason` — `gesture` for user input (**including the engine's zoom buttons**, which the user presses and your code never issues), `api` for your own `setCamera` / `fitBounds`, `follow` for the camera catching up with a followed character.

Subscribing arms one event, so the first `camera:idle` arrives without waiting for the user to touch the map.

### App chrome over the map: `ui.contentInset`

```tsx
<MapramaView ui={{ attribution: true, contentInset: { bottom: sheetHeight } }} … />
```

The map keeps drawing across the whole view — only the *visible area* moves. That changes where a `setCamera` `center` lands, where a followed character sits, where the engine's ornaments are drawn (so **a sheet can never cover the attribution while `attribution` is on** — keep it engine-drawn instead of switching it off and copying the text, which goes stale the moment the library changes its wording or its sources), how labels and markers are placed and clamped, what `ScreenPoint.visible` means for `project` and `MapOverlay`, and the `bounds` / `radiusMeters` of `camera:idle`. `fitBounds` adds the inset to its `padding`.

It does **not** move the screen coordinate frame: `project` and `unproject` keep working in full-view pixels with the origin at the top left of the whole map view.

### Errors

`onError` receives `{ code, message, fatal }` and never throws. Engine codes pass through (`world_load_failed`, `model_load_failed`, `unsupported`, `internal`…). An engine's legacy `NOT_IMPLEMENTED` is normalised to `unsupported`. Host codes: `invalid_message` (an engine message failed protocol validation; the map keeps running), `host_crashed`, `host_load_failed`, `location_unavailable`, `location_permission_denied`, `drops_fetch_failed`, `listener_error`. Rejected promises use `MapramaError` with the same `code`.

## Device location

`location={{ source: 'device', provider?: 'auto' | 'expo-location' | 'webview' }}`

- **`expo-location` installed** (optional peer dependency, used by `auto`): the library requests foreground permission, watches the position and pushes fixes to the engine (the engine runs with the `external` source). It is loaded with a guarded `require`, so apps without it still bundle.
- **Otherwise** (`webview`): the engine reads `navigator.geolocation` inside the WebView and the host enables WebView geolocation. No additional native dependency is needed.

Either way, the platform permissions above are required.

## `DropLayer source="service"`

```tsx
<DropLayer id="coins" source="service" channel="coins" apiKey={CLIENT_KEY} baseUrl="https://api.example" userId={user.id}
  onCollect={(e) => showSparkle(e)} onCollectVerified={(e) => grant(e.receipt)} onCollectRejected={(e) => warn(e.code)} />
```

- Fetches `GET {baseUrl}/v1/drops/nearby?lng&lat&radius&channel` with `Authorization: Bearer <apiKey>` around the tracked character (`characterId`, default the `isPlayer` character, position throttled by `positionThrottleMs`). It fetches again after moving more than `refetchDistanceMeters` (150 m) from the last fetch, or when the response's `expiresAt` window ends.
- Position updates never cancel an in-flight fetch, the window-expiry timer or a pending retry. Only unmounting or changing `baseUrl`, `apiKey`, `channel`, `radiusMeters` or `userId` resets them. Changing that config also clears the layer's drops and the drops hidden on collect, so nothing carries over to the new channel. Responses are applied in request order: a response older than one already applied is ignored, but an older response is still shown until a newer one arrives.
- A failed fetch is reported through `onError` with code `drops_fetch_failed`:
  - **Retried** (`fatal: false`): network errors, `INVALID_RESPONSE`, HTTP 408, 429 and 5xx. Retries run at the latest position after 2 s, 5 s, then every 15 s. A `Retry-After` header (seconds or HTTP date) replaces the scheduled delay, with a minimum of 2 s. Only a successful fetch resets the schedule to 2 s.
  - While a retry is pending, position updates do not fetch and do not reset the backoff, even after the drop window has expired. The only exception is a move of more than `refetchDistanceMeters` from both the last attempt and the last successful fetch. That move fetches once right away, and if it fails the backoff continues from its current step.
  - **Not retried** (`fatal: true`): HTTP 400, 401, 403, 404 and other 4xx, and the codes `INVALID_KEY`, `MISSING_KEY`, `MALFORMED_AUTHORIZATION`, `FORBIDDEN_ROLE`, `QUERY_KEY_NOT_ALLOWED`, `BAD_REQUEST` and `INVALID_*`. The error is reported once, and the layer stops fetching until its service config changes. The map keeps running.
- On `drop:collect`, the drop is hidden, `onCollect` is called, then `POST {baseUrl}/v1/drops/collect` is sent with `{ dropId, collectId, userId, fix: { lng, lat, accuracyMeters, timestamp } }`. On `200`, `onCollectVerified` receives `{ receipt, replayed }`. Otherwise `onCollectRejected` receives the service error `code` (`TOO_FAR`, `ALREADY_COLLECTED`, `DROP_EXPIRED`, `STALE_FIX`, `TELEPORT`, `COLLECT_ID_CONFLICT`, `QUOTA_EXCEEDED`, …), `NETWORK_ERROR` or `INVALID_RESPONSE`, plus the HTTP `status`.
- After a rejection, the drop **reappears** for `TOO_FAR`, `TELEPORT`, `STALE_FIX`, `QUOTA_EXCEEDED`, `NETWORK_ERROR`, `INVALID_RESPONSE` and HTTP 5xx, because a later attempt may succeed. It **stays hidden** for `ALREADY_COLLECTED`, `DROP_EXPIRED`, `DROP_NOT_FOUND`, `COLLECT_ID_CONFLICT` and any other code, including after refetches (`shouldRestoreRejectedDrop(code, status)`).
- Verify receipts on your own server; a client-side verification is only a hint.

The low-level client is exported as `fetchNearbyDrops` / `verifyDropCollect`.

## Engine hosts

`MapramaView` renders the host registered for its `engine` prop (default `'web'`). A host is a React component that receives `onHost`, `onHostError` and `options`, and reports an `EngineHost`:

```ts
interface EngineHost {
  readonly kind: string;
  send(command: EngineCommand): void;               // @maprama/protocol command
  onEvent(listener: (event: EngineEvent) => void): () => void;
  readonly ready: Promise<EngineInfo>;
  destroy(): void;
}
```

- **Web host (v1)**: `WebViewEngineHost` renders a transparent, non-scrolling `WebView` with `source={{ html: ENGINE_HTML }}`. Commands go out as `webView.postMessage(encodeCommand(cmd, seq))` and arrive in the page as `message` events. The engine answers with `window.ReactNativeWebView.postMessage(encodeEvent(evt, seq))`, which is decoded and validated in `onMessage`. If the Android render process dies, the WebView is re-created; if the iOS content process terminates, it is reloaded. Either way the map re-sends `init` and all declarative state.
- **WebView hardening**: the WebView only accepts navigations to the inline engine document. `originWhitelist` is `['about:blank', 'about:srcdoc', 'data:*']`, and `onShouldStartLoadWithRequest` also refuses `data:` once the engine document has loaded. http(s) links open in the system browser through `Linking.openURL`. `file:`, `javascript:` and custom schemes are refused. The whitelist affects navigations only, not the engine's resource loads (world JSON, glTF models). `allowFileAccess` is `false`. `mixedContentMode` is `"never"`: mixed-content rules only apply to secure (https) pages, and the inline document is not one. This keeps a foreign page from replacing the engine and forging events such as `drop:collect`.
- **Custom hosts**: `registerEngineHost('native', NativeEngineHost)` and `<MapramaView engine="native">`. `createMessageChannelHost(kind, post)` builds an `EngineHost` for any string transport (JSI, WebSocket…). No other app code changes.

## Links

- [Repository and documentation](https://github.com/CraftsManShip001/maprama)
- [Changelog](https://github.com/CraftsManShip001/maprama/blob/main/CHANGELOG.md)

## License

Apache-2.0. See `LICENSE` and `NOTICE`. Map data © OpenStreetMap contributors,
ODbL: apps that show OpenStreetMap-derived worlds must display this attribution
(`ui.attribution` draws it on the map).
