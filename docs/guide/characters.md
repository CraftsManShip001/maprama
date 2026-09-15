# 캐릭터와 모델

캐릭터는 플레이어 아바타든 NPC든 **어떤 glTF 2.0 / GLB 모델**이든 됩니다. 모델이 없거나, 아직 로드 중이거나, 로드에 실패하면 엔진 기본 아바타(절차 생성 캐릭터)를 씁니다.

## `Character`

```tsx
<MapramaView world={world}>
  <Character
    id="me"
    isPlayer
    model="https://cdn.example.com/avatars/hero.glb"
    animations={{ walk: 'Walking_Loop', run: 'Run', idle: 'Idle' }}
    follow="location"
    name="나"
    color="#2F5BEA"
    scale={1}
    showNameTag
  />
</MapramaView>
```

| prop | 설명 |
| --- | --- |
| `id` | 캐릭터 전체에서 고유 |
| `isPlayer` | 로컬 플레이어 (최대 1명. 둘 이상이면 엔진이 `invalid_character` 오류). 드롭의 기본 수집자 |
| `model` | URI 문자열, `{ uri }`, 또는 `require()` 자산 번호. [모델 파일 넘기기](#모델-파일-넘기기) |
| `animations` | 관례 이름 → 모델의 클립 이름 |
| `follow` | `location`: 위치 소스를 따라감 · `none`: `travel`과 `position`으로만 이동. 생략하면 `none` |
| `position` | 초기 위치. 바꾸면 순간이동 |
| `name`, `color`, `scale`, `showNameTag` | 이름표 텍스트, 강조 색(CSS hex), 크기 배율, 이름표 표시 |

모델 로드에 실패하면 `onError`로 `model_load_failed`가 오고 기본 아바타가 남습니다.

## 모델 파일 넘기기

| 형태 | 처리 |
| --- | --- |
| `'https://…/hero.glb'` | 그대로 URI로 씀 (**권장**) |
| `'data:model/gltf-binary;base64,…'` | 그대로 URI로 씀. 작은 모델을 앱에 넣을 때 |
| `require('./hero.glb')` | `Image.resolveAssetSource(n).uri`로 바꾼 URI를 엔진이 불러옴 |

::: warning 번들 자산과 릴리스 빌드
엔진은 인라인 문서로 뜬 WebView 안에서 모델을 불러오고, 이 WebView는 `allowFileAccess={false}`입니다. 개발 빌드에서는 `require()` 자산이 Metro 서버의 http URL이라 읽히지만, 릴리스 빌드에서는 번들 안의 파일 URI가 되어 **읽히지 않을 수 있습니다.** 운영에서는 https URL이나 `data:` URI를 쓰세요.
:::

## 여러 캐릭터: `CharacterLayer`

앱 데이터 배열에서 캐릭터를 만듭니다. 멀티플레이의 다른 플레이어에 씁니다.

```tsx
<CharacterLayer
  data={nearbyPlayers}
  getId={(p) => p.id}
  getPosition={(p) => p.coord}
  getModel={(p) => p.avatarUrl}
  getName={(p) => p.nickname}
  showNameTags
/>
```

변경은 프레임당 한 번의 `upsertCharacters` / `removeCharacters`로 묶여 나갑니다. `getPosition` 값이 바뀌면 캐릭터는 그 위치로 **순간이동**합니다. 부드러운 움직임은 [오버레이와 멀티플레이](./overlays-multiplayer#멀티플레이)를 보세요.

캐릭터를 제거하면 진행 중인 이동이 취소되고, 카메라가 그 캐릭터를 따라가고 있었다면 멈춥니다. 지오펜스 `exit` 이벤트는 오지 않습니다.

## 모델 규칙

| 항목 | 규칙 |
| --- | --- |
| 앞쪽 | `+Z` (glTF 기본 전방. 모델이 +Z를 바라봐야 함) |
| 위쪽 | `+Y` |
| 원점과 크기 | 엔진이 발밑이 원점에 오도록 가운데 맞추고, 기본 아바타 키(1.9 월드 단위)에 맞춘 뒤 `scale`을 곱합니다 |
| 애니메이션 클립 | `idle`, `walk`, `run`, `ride`, `wave` (또는 `animations`로 매핑) |
| 압축 | Draco, Meshopt 지원 ([압축](#압축)) |

### 애니메이션 클립

**클립 찾기.** 관례 이름마다 다음 순서로 클립을 찾습니다.

1. `animations`에 매핑이 있고 모델에 그 클립이 있으면 그 클립
2. 관례 이름과 똑같은 이름의 클립
3. 대소문자를 무시하고 같은 이름의 클립
4. `Armature|Walk`, `run_fast`처럼 `|`, `:`, `/`, `.`, 공백, `_`, `-`로 나눈 단어 중 하나가 관례 이름인 클립

**클립 고르기.** 엔진이 이동 수단과 속도로 클립을 고르고 크로스페이드합니다.

| 상황 | 클립 (없으면 다음 후보) |
| --- | --- |
| 도보, 멈춤 | `idle` |
| 도보 | `walk` → `run` → `idle`. 걷기 속도의 1.6배를 넘으면 `run` → `walk` → `idle`. 재생 속도는 캐릭터 크기에 대한 화면 속 이동 속도에 맞춤 (크기 1인 캐릭터가 초당 3.2 월드 단위로 움직일 때 1배, 최소 0.5배 · 최대 2.2배). 실제 속도로 이동하면(`timeScale` 1) 화면에서는 느리므로 최소 속도로 걷습니다 |
| 자전거(올라탄 뒤), 자동차 | `ride` → `idle` |
| 비행기, 지하철 | `idle` |

자동차, 비행기, 지하철 구간에서는 탈것이 나타나고 캐릭터 몸은 가려집니다. 자전거 구간에서는 캐릭터가 자전거 위에 앉아 보입니다. `wave`는 한 번 재생하는 동작입니다.

## CLI로 검사하고 최적화하기

`maprama` CLI가 규칙에 맞는지 검사하고, 크기를 줄이고, 클립 매핑을 제안합니다.

```sh
maprama inspect hero.glb
maprama optimize hero.glb -o hero.opt.glb --center-feet --scale-to-height 1.8 --face +z
```

`optimize` 결과에 `suggestedAnimations`가 있으면 그대로 `animations` prop에 넣으세요.

```json
"suggestedAnimations": { "walk": "Armature|Walking" }
```

옵션 전체는 [maprama (glTF 에셋)](/tools/assets)에 있어요.

### 압축

- **Meshopt**: 디코더가 엔진에 들어 있어서 추가 다운로드가 없습니다.
- **Draco**: 디코더를 `https://www.gstatic.com/draco/versioned/decoders/1.5.7/`에서 받습니다. Draco로 압축한 모델을 불러올 때만 받지만, **네트워크가 필요**합니다. 오프라인에서도 동작해야 하면 Meshopt나 무압축을 쓰세요.

## 건물 뒤의 캐릭터

건물에 가려진 캐릭터는 건물을 통과해 캐릭터 색의 실루엣으로 그립니다. 렌더러의 실루엣 패스가 가림막 뒤의 깊이에서만 그리므로, 도시 한가운데서도 내 캐릭터를 잃어버리지 않아요.

## 네이티브 엔진에서는

v2 엔진은 cgltf로 워커 스레드에서 모델을 읽고, 캐릭터당 최대 64개 관절의 GPU 선형 블렌드 스키닝과 150 ms 크로스페이드를 계획하고 있습니다. 동시에 스키닝하는 캐릭터 목표치는 32명입니다 (측정 전 목표).
