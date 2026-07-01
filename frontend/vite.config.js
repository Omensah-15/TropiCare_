import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

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
