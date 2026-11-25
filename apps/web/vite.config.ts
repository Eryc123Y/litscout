import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom/client"],
          "schema-vendor": ["zod"],
          // react-day-picker is left to the Days chunk: a manual chunk would
          // also collect dependencies the entry shares and force a preload.
        },
      },
    },
  },
});
