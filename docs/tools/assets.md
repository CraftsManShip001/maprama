# maprama (glTF 에셋)

`maprama`는 캐릭터, 드롭, 탈것, 랜드마크로 쓸 glTF 2.0 / GLB 모델을 검사하고 최적화하는 CLI입니다. [glTF Transform](https://gltf-transform.dev), meshoptimizer, Draco, sharp를 씁니다.

## 엔진 규칙

| | 규칙 |
| --- | --- |
| 단위 | 미터 |
| 위쪽 | `+Y` |
| 앞쪽 | `+Z` |
| 원점 | 발밑 (바운딩 박스 바닥 중앙) |
| 애니메이션 클립 | `idle`, `walk`, `run`, `ride`, `wave` (또는 `CharacterSpec.animations`로 매핑) |

## `maprama inspect <model.glb>`

JSON 보고서를 stdout에, 경고를 stderr에 씁니다.

| 필드 | 내용 |
| --- | --- |
| `bounds` | 기본 씬의 `min`, `max`, `size`, `center` (미터, 노드 변환 적용) |
| `axes` | 바운딩 박스 비율로 추정한 `up`/`forward`와 `confidence`. 힌트로만 쓰세요 |
| `triangles`, `vertices`, `meshes`, `primitives`, `materials`, `nodes` | 지오메트리와 씬 개수 |
| `textures[]` | 이름, URI, MIME, 크기, 바이트 |
| `animations[]` | 클립 이름, 길이, 채널 수 |
| `clips` | `found`, `missing`, `mappingNeeded`, `suggestedMapping`, `unmatched` |
| `skinned`, `skins`, `joints`, `morphTargets` | 스키닝과 모프 타깃 |
| `extensionsUsed`, `warnings` | 사용 확장과 경고 |

매핑 제안에 쓰는 동의어 예: `idle` ← Standing, Breathing · `run` ← Jog, Sprint · `ride` ← Bike, Bicycle, Cycling, Drive, Sitting · `wave` ← Hello, Greet. `Armature|mixamo.com|Walk` 같은 이름은 마지막 조각으로 비교합니다.

## `maprama optimize <in.glb> -o <out.glb> [options]`

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `--max-triangles <n>` | `20000` | 씬 전체 삼각형 예산 (meshoptimizer 단순화) |
| `--max-texture <px>` | `1024` | 이보다 큰 텍스처를 비율 유지하며 축소 |
| `--draco` / `--meshopt` | 없음 | 지오메트리 압축 (둘 중 하나) |
| `--center-feet` | 끔 | 원점을 바운딩 박스 바닥 중앙으로 |
| `--face +z\|-z\|+x\|-x` | `+z` | **원본** 모델이 바라보는 방향. +Y 축으로 돌려 +Z를 보게 함 |
| `--scale-to-height <m>` | | 이 높이로 균일 스케일 |
| `--verbose` | | 단순화 과정 로그 |

처리 순서:

1. `dedup`, `prune`, `weld`, (애니메이션이 있으면) `resample`
2. 정규화: +Z로 회전 → 높이 스케일 → 원점을 발밑으로. 모든 루트를 `maprama_root` 노드로 감싸 스킨과 애니메이션 채널을 보존
3. 삼각형 예산을 넘으면 오차 한계를 늘려 가며 `simplify` (모프 타깃 등으로 못 맞추면 경고)
4. 큰 텍스처를 sharp로 축소 (원래 형식 유지)
5. `prune`, `dedup` 다시
6. 요청 시 Draco 또는 Meshopt 압축

결과를 다시 읽어 검사하고, 전후 바이트·삼각형·바운딩·텍스처와 경고를 JSON으로 출력합니다. 클립 이름이 규칙과 다르면 `suggestedAnimations`가 붙습니다.

```jsonc
// maprama optimize hero.glb -o hero.opt.glb --center-feet --scale-to-height 1.8
"warnings": [
  "animation clip \"Armature|Walking\" does not match idle|walk|run|ride|wave",
  "suggested CharacterSpec.animations mapping: {\"walk\":\"Armature|Walking\"}"
],
"suggestedAnimations": { "walk": "Armature|Walking" }
```

앱에서는 이렇게 씁니다.

```tsx
<Character id="me" isPlayer model="https://example.com/hero.opt.glb" animations={{ walk: 'Armature|Walking' }} />
```

## 주의

- **압축한 결과는 엔진에 디코더가 필요합니다.** Draco는 Draco 디코더(three.js `DRACOLoader` 등), Meshopt는 `MeshoptDecoder`. 대상 엔진에 디코더가 없으면 압축을 끄세요.
- **KTX2/Basis 텍스처 압축은 없습니다.** 네이티브 `toktx` 도구가 필요하기 때문입니다.
- **스키닝 메시의 바운딩은 바인드 포즈 기준**이라, 아마추어 노드에 자체 스케일이 있는 리그(FBX → glTF 변환에서 흔함)는 `--center-feet`와 `--scale-to-height`가 근사치입니다. 결과를 다시 `inspect`하세요.
- **Z-up 모델**은 `inspect`가 표시하지만 `optimize`는 돌리지 않습니다. +Y up으로 다시 내보내세요.
