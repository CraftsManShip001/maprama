# @maprama/tile-spike

**실험용입니다. 제품 코드가 아닙니다.**
[`design/tile-format.md`](../../design/tile-format.md)의 숫자를 낸 스파이크이고, 그 숫자를 누구든
다시 재볼 수 있게 남겨 둔 것입니다. 명세가 구현으로 옮겨지고 나면 이 패키지는 지워도 됩니다.

무엇을 증명하는가:

1. `WorldData` → 타일 → **PMTiles 아카이브 하나**를 실제로 만든다.
2. 그 아카이브를 **공식 `pmtiles` 리더가 HTTP Range로** 읽고, 원래 피처가 복원된다.
3. 타일 크기·밀도·생성 시간을 재고, 남한 전역으로 외삽한다.
4. **React Native에서 HTTP Range가 실제로 되는지** 기기(시뮬레이터/에뮬레이터)에서 확인한다.

## 준비

```sh
npm install                              # 저장소 루트에서 (npm workspaces)
npm run build -w @maprama/protocol
npm run build -w @maprama/osm            # 지역 샘플을 새로 받을 때만 필요
```

## 명령

```sh
cd tools/tile-spike

node src/cli.mjs build        # 성수 샘플 -> 타일 -> .out/seongsu.z15.pmtiles
node src/cli.mjs verify       # 위 아카이브를 range 서버에 올리고 공식 리더로 되읽어 대조
node src/cli.mjs measure      # 지역별 KB/km², 줌별 타일 크기, 양자화 오차
node src/cli.mjs profiles     # detail vs overview 프로파일 (줌 레벨 결정 근거)
node src/cli.mjs extrapolate  # 남한 100,000 km² 외삽
node src/cli.mjs directory    # 전국 PMTiles 디렉터리 크기 (2단 구조 포함)
```

공통 옵션: `--zoom`, `--extent`, `--buffer`, `--profile detail|overview`.

`verify`는 아카이브를 임시 HTTP 서버에 올리고 range 요청 수와 전송 바이트를 세므로,
"조각만 받는다"가 말이 아니라 측정입니다.

## 지역 샘플

성수 샘플은 저장소에 이미 있고(`tools/osm/samples/seongsu.world.json`), 밀도 비교용 다른 지역은
Overpass에서 받습니다:

```sh
bash scripts/fetch-areas.sh      # 강남 · 분당 · 부산 · 구례 · 김제농지 · 오대산 · 한강
```

결과는 `.data/`(gitignore)에 들어갑니다. **저장소에 커밋하지 마십시오** — OSM 파생 데이터는
ODbL이고 저장소 라이선스(Apache-2.0)와 다릅니다. Overpass 사용 정책을 지키기 위해 bbox는
1 km² 정도로 작게 유지하고, 이미 받은 파일은 다시 받지 않습니다.

## RN Range 프로브

```sh
node src/range-probe-server.mjs
```

- `:8791` 오리진 — `/probe.html`(브라우저용 프로브 페이지), `/blob.bin`(8 MiB, range 지원),
  `/tile.gz`(성수에서 뽑은 **실제** MTIL 타일을 gzip한 것), `/report`(결과 수집)
- `:8792` CORS 완비 CDN, `:8793` `Access-Control-Allow-Origin`만 있는 CDN

들어오는 요청의 `Range`·`Origin` 헤더를 전부 로그로 찍고, 페이지가 보내온 결과를 `PROBE REPORT`
블록으로 출력합니다. 기기 화면을 읽을 필요가 없습니다.

**브라우저에서:** iOS 시뮬레이터 Safari는 `xcrun simctl openurl <udid> http://localhost:8791/probe.html`.

**RN 앱에서:** `probe-app/App.js`가 프로브 앱 전체입니다. Expo 빈 앱을 하나 만들어 그 파일을
`App.js`로 넣고 `react-native-webview`를 설치한 뒤 실행하면 됩니다.

```sh
npx create-expo-app@latest rnprobe --template blank
cd rnprobe && npx expo install react-native-webview
cp <repo>/tools/tile-spike/probe-app/App.js App.js
npx expo run:ios          # 또는: ANDROID_HOME=~/Library/Android/sdk npx expo run:android
```

앱은 RN JS 스레드(`fetch`, `XMLHttpRequest`)와 **Maprama가 엔진을 띄우는 것과 똑같은 설정의
WebView**(`source={{ html }}`) 양쪽에서 Range를 시험하고, range로 받은 진짜 MTIL 타일을
`DecompressionStream`으로 풀어 magic까지 확인한 뒤 결과를 `:8791/report`로 보냅니다.

측정 결과와 그 해석은 `design/tile-format.md` §6에 있습니다.

## 구조

| 파일 | |
| --- | --- |
| `src/mercator.mjs` | 웹 메르카토르 / 슬리피 타일 수학, `WorldData` 로컬 미터의 역투영 |
| `src/payload.mjs` | MTIL v1 타일 인코더/디코더 |
| `src/tiler.mjs` | `WorldData` → 타일 (앵커 소유 / 클립, overview 필터) |
| `src/pmtiles-write.mjs` | 스펙만 보고 쓴 PMTiles v3 라이터 (루트 디렉터리만) |
| `src/cli.mjs` | 위 명령들 |
| `src/range-probe-server.mjs` | Range 프로브 서버 |
| `probe-app/App.js` | RN 프로브 앱 |

## 알려진 한계

- PMTiles 라이터가 **리프 디렉터리를 만들지 않습니다.** 수만 타일까지는 괜찮지만 전국 아카이브에는
  2단 구조가 필요합니다. (`directory` 명령이 2단 크기를 계산해 주기는 합니다.)
- 줌 레벨별 기하 단순화가 없습니다. overview 프로파일은 **필터링만** 합니다.
- 오류 처리가 없습니다. 입력이 이상하면 그냥 던집니다.
