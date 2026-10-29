import { defineConfig } from "vite";
import { pwaPlugin } from "./pwa-plugin";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [tailwindcss(), pwaPlugin()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  base: "/manage/",
  build: { target: "chrome90" },
  server: {
    proxy: {
      "/api": {
        target:
          process.env.MOLLYTIME_API_PROXY ||
          process.env.MOLLY_API_PROXY ||
          "http://127.0.0.1:8096",
        changeOrigin: false,
      },
    },
  },
});
