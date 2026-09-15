import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // Las librerías cambian menos que el panel: en ficheros aparte, el navegador
    // las conserva entre despliegues.
    rollupOptions: {
      output: {
        manualChunks: {
          charts: ["lightweight-charts"],
          ui: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-alert-dialog",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-tabs",
            "cmdk",
            "sonner",
            "lucide-react",
          ],
        },
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
});
