import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          ui: ["@heroui/react", "lucide-react", "framer-motion"],
          charts: ["chart.js", "react-chartjs-2", "recharts"],
          realtime: ["socket.io-client"],
          data: ["axios", "@tanstack/react-query"],
          payments: ["@paypal/react-paypal-js"],
        },
      },
    },
  },
});
