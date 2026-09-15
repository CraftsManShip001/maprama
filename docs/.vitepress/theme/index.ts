import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import MapramaPlayground from './playground/MapramaPlayground.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      // live engine in the home hero
      'home-hero-image': () => h(MapramaPlayground, { variant: 'hero' }),
    }),
  enhanceApp({ app }) {
    app.component('MapramaPlayground', MapramaPlayground);
  },
} satisfies Theme;
