import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ["./tests/setup.ts"],
    globalSetup: ["./tests/globalSetup.ts"],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./shared"),
      "@": path.resolve(__dirname, "./client/src"),
    },
  },
});
