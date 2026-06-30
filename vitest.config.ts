import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        exclude: ["**/node_modules/**"],
        testTimeout: 30_000,
        hookTimeout: 30_000,
        setupFiles: ["./test/setup.ts"],
    },
});
