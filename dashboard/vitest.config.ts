import { defineConfig } from "vitest/config";

// vite.config.ts のCloudflareプラグインはvitestと両立しない(Worker環境に resolve.external を
// 設定してしまい起動時エラーになる)ため、テストはプラグイン無しの設定で動かす。
// テストは純粋関数だけを対象にしており、Workerランタイムは不要。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
