import { defineConfig } from 'vite'

// Served from https://lukemeyer.github.io/trickplayer-g2/ — assets need the
// repo name as a base path. Local dev/preview stay at "/".
export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/trickplayer-g2/' : '/',
  server: { host: true, port: 5173 },
  build: {
    target: 'esnext',
    // TWO entry points: the app, and the same app with the link recorder
    // attached. A separate page rather than a flag, so nobody who is only
    // watching something pays for a measurement they will never read.
    rollupOptions: {
      input: {
        main: 'index.html',
        telemetry: 'telemetry.html',
      },
    },
  },
})
