import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      // Matches this project's existing layout (public/sw.js) -- these
      // two are actually vite-plugin-pwa's own defaults, listed
      // explicitly so this config stays correct even if that default
      // ever changes.
      srcDir: "public",
      filename: "sw.js",
      injectManifest: {
        // Globs the REAL build output in dist/ on every build -- this is
        // the actual offline fix. The list can never drift from what was
        // really deployed, unlike a hand-typed filename list.
        globPatterns: ["**/*.{js,css,html,png,svg,json}"],
        globIgnores: ["sw.js"], // don't let the worker try to precache itself
      },
      manifest: false,       // keep the hand-written public/manifest.json as-is
      injectRegister: false, // App.jsx already registers the SW itself on boot
      devOptions: { enabled: false },
    }),
  ],

  optimizeDeps: {
    include: ["jspdf", "leaflet"],
  },

  build: {
    chunkSizeWarningLimit: 1000,

    commonjsOptions: {
      include: [/node_modules/, /jspdf/],
    },
  },
});
