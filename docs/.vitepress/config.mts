import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type DefaultTheme } from 'vitepress';

// Product naming lives here.
const BRAND = 'Maprama';
/** Site base path: `/` locally, `/maprama/` on GitHub Pages (set by `.github/workflows/docs.yml`). */
const BASE = process.env.DOCS_BASE ?? '/';
const docsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function typedocSidebar(): DefaultTheme.SidebarItem[] {
  const file = join(docsRoot, 'api', 'reference', 'typedoc-sidebar.json');
  if (!existsSync(file)) return [];
  const items = JSON.parse(readFileSync(file, 'utf8')) as DefaultTheme.SidebarItem[];
  const names: Record<string, string> = { protocol: '@maprama/protocol', 'react-native': '@maprama/react-native' };
  return items.map((item) => ({ ...item, text: names[item.text ?? ''] ?? item.text }));
}

const guide: DefaultTheme.SidebarItem[] = [
  {
    text: '시작',
    items: [
      { text: '소개와 결정', link: '/guide/' },
      { text: '설치: bare RN · Expo', link: '/guide/getting-started' },
    ],
  },
  {
    text: '지도 만들기',
    items: [
      { text: '월드 데이터와 타일', link: '/guide/world-data' },
      { text: '카메라', link: '/guide/camera' },
      { text: '콘텐츠 인셋 (바텀시트)', link: '/guide/content-inset' },
      { text: '테마', link: '/guide/themes' },
      { text: '라벨', link: '/guide/labels' },
      { text: '마커(핀)', link: '/guide/markers' },
    ],
  },
  {
    text: '게임 요소',
    items: [
      { text: '캐릭터와 모델', link: '/guide/characters' },
      { text: '위치와 이동', link: '/guide/location-travel' },
      { text: '드롭과 서버 검증', link: '/guide/drops' },
      { text: '지오펜스와 건물', link: '/guide/geofences-buildings' },
      { text: '오버레이와 멀티플레이', link: '/guide/overlays-multiplayer' },
    ],
  },
  {
    text: '깊이 들어가기',
    items: [
      { text: '성능', link: '/guide/performance' },
      { text: '엔진 구조와 로드맵', link: '/guide/architecture' },
    ],
  },
];

export default defineConfig({
  lang: 'ko-KR',
  base: BASE,
  title: BRAND,
  titleTemplate: `:title · ${BRAND}`,
  description: 'React Native를 위한 2.5D 게임 지도: 캐릭터, 이동, 드롭, 홀로그램 라벨, 지오펜스.',
  cleanUrls: true,
  lastUpdated: false,
  srcExclude: ['**/_*.md', 'README.md'],
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${BASE}logo.svg` }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&family=Jua&display=swap',
      },
    ],
    ['meta', { name: 'theme-color', content: '#2F5BEA' }],
  ],
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
  },
  themeConfig: {
    logo: { src: '/logo.svg', alt: '' },
    siteTitle: BRAND,
    nav: [
      { text: '가이드', link: '/guide/', activeMatch: '^/guide/' },
      { text: '플레이그라운드', link: '/playground/', activeMatch: '^/playground/' },
      { text: 'API', link: '/api/', activeMatch: '^/api/' },
      { text: '호스팅 서비스', link: '/service/', activeMatch: '^/service/' },
      { text: '도구', link: '/tools/', activeMatch: '^/tools/' },
    ],
    sidebar: {
      '/guide/': guide,
      '/api/': [
        { text: 'API 레퍼런스', items: [{ text: '개요', link: '/api/' }] },
        ...typedocSidebar(),
      ],
      '/service/': [
        {
          text: '호스팅 서비스',
          items: [
            { text: '개요 · 키 · 과금', link: '/service/' },
            { text: 'OpenAPI 레퍼런스', link: '/service/api-reference' },
            { text: '웹훅과 영수증 검증', link: '/service/webhooks-receipts' },
          ],
        },
      ],
      '/tools/': [
        {
          text: 'CLI 도구',
          items: [
            { text: '개요', link: '/tools/' },
            { text: 'maprama-osm (월드 빌드)', link: '/tools/osm' },
            { text: 'maprama (glTF 에셋)', link: '/tools/assets' },
          ],
        },
      ],
    },
    outline: { level: [2, 3], label: '이 페이지' },
    docFooter: { prev: '이전', next: '다음' },
    darkModeSwitchLabel: '테마',
    lightModeSwitchTitle: '라이트 모드',
    darkModeSwitchTitle: '다크 모드',
    sidebarMenuLabel: '메뉴',
    returnToTopLabel: '맨 위로',
    langMenuLabel: '언어',
    notFound: { title: '페이지를 찾을 수 없어요', quote: '주소를 확인하거나 가이드에서 다시 시작하세요.', linkText: '홈으로' },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '검색', buttonAriaLabel: '검색' },
          modal: {
            noResultsText: '결과가 없어요',
            resetButtonTitle: '지우기',
            footer: { selectText: '선택', navigateText: '이동', closeText: '닫기' },
          },
        },
      },
    },
    footer: {
      message: 'SDK 코드는 Apache-2.0 · 호스팅 서비스는 유료(무료 티어 제공) · 샘플 지도 데이터 © OpenStreetMap contributors (ODbL 1.0)',
      copyright: `Copyright 2026 The ${BRAND} Authors`,
    },
  },
  vite: {
    // The playground imports the workspace packages' built dist/ (resolved through the repo's node_modules links).
    server: { fs: { allow: [join(docsRoot, '..')] } },
    ssr: { noExternal: [] },
  },
});
