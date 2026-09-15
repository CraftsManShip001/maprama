import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import DioramaPlayground from './playground/DioramaPlayground.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      // live engine in the home hero
      'home-hero-image': () => h(DioramaPlayground, { variant: 'hero' }),
    }),
  enhanceApp({ app }) {
    app.component('DioramaPlayground', DioramaPlayground);
  },
} satisfies Theme;
