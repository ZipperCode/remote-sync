import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: new URL("./test/obsidian-mock.ts", import.meta.url).pathname
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
