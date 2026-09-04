// vitest 配置：只有依赖 vi.stubEnv / vi.resetModules / vi.mock 的测试走 vitest，
// 其余 src 测试统一走 node:test（编译到 .test-dist/ 后由 node --test 运行）。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/docker-check.test.ts",
      "src/kimi-config.test.ts",
      "src/kernel-updater.test.ts",
      "src/cryoclaw-config.test.ts",
      "src/openclaw-config-migration.test.ts",
      "src/openclaw-health-state.test.ts",
      "src/startup-ownership.test.ts",
      "src/openclaw-state-archive.test.ts",
      "src/openclaw-state-import-lifecycle.test.ts",
    ],
  },
});
