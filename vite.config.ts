import { defineConfig } from 'vite'

// Served from https://lukemeyer.github.io/trickplayer-g2/ — assets need the
// repo name as a base path. Local dev/preview stay at "/".
export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/trickplayer-g2/' : '/',
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
})
