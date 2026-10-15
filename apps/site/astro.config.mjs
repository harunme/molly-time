import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import icon from 'astro-icon';
import astrowind from './vendor/integration/index';
import { fileURLToPath } from 'node:url';

const apiProxy = process.env.MOLLYTIME_API_PROXY || process.env.MOLLY_API_PROXY || 'http://127.0.0.1:8096';

export default defineConfig({
  site: 'https://mollytime.app',
  output: 'static',
  devToolbar: { enabled: false },
  integrations: [
    sitemap(),
    icon({ include: { tabler: ['*'], 'flat-color-icons': ['*'] } }),
    astrowind({ config: './src/config.yaml' }),
    {
      name: 'dev-app-routes',
      hooks: {
        'astro:config:setup': ({ command, updateConfig }) => {
          // AstroWind forbids trailing slashes before Vite's proxy runs, but
          // both app dev servers require /manage/ and /tv/ as their base URL.
          if (command === 'dev') updateConfig({ trailingSlash: 'ignore' });
        },
      },
    },
  ],
  image: { responsiveStyles: true },
  vite: {
    plugins: [tailwindcss()],
    resolve: { alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      strictPort: true,
      proxy: {
        '/api': { target: apiProxy },
        '/manage': { target: process.env.MOLLYTIME_WEB_PROXY || apiProxy, ws: true },
        '/tv': { target: process.env.MOLLYTIME_TV_PROXY || apiProxy, ws: true },
      },
    },
  },
});
