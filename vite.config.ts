import { defineConfig } from 'vite'

// Served from https://lukemeyer.github.io/even-plex-bif-viewer/ — assets
// need the repo name as a base path. Local dev/preview stay at "/".
export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/even-plex-bif-viewer/' : '/',
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
})
