import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import icon from 'astro-icon';
import astrowind from './vendor/integration/index';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  site: 'https://mollytime.app',
  output: 'static',
  devToolbar: { enabled: false },
  integrations: [sitemap(), icon({ include: { tabler: ['*'], 'flat-color-icons': ['*'] } }), astrowind({ config: './src/config.yaml' })],
  image: { responsiveStyles: true },
  vite: {
    plugins: [tailwindcss()],
    resolve: { alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: { proxy: Object.fromEntries(['/api', '/manage', '/tv'].map((path) =>
      [path, process.env.MOLLYTIME_API_PROXY || 'http://127.0.0.1:8096'])) },
  },
});
