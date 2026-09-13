// CSS 源码语法审计（2026.9.13 R85 QA 事故防线）：
// 事故复盘：primitives.css 头注释结尾多写了一个斜杠（星杠定界符之后再跟斜杠），
// 注释剥除后游离斜杠粘到下一条规则选择器上 → 压缩产物出现非法选择器
// → 浏览器静默丢弃整条 `.btn` 基础规则 → 全应用按钮退化成原生样式
// （构建期 esbuild 只给了一条 WARNING 未拦截）。本测试把这类问题挡在 CI：
//   1. 注释定界符配对（`/*` 与 `*/` 数量一致）；
//   2. 剥注释后任何规则选择器不得包含斜杠（合法选择器不含斜杠，
//      能捕获定界符错位等一切把垃圾字符漏进选择器的形态）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// 与 layout-qa.test.ts 同目录同解析方式：编译产物在 .test-dist/ui/src/ui/ 下，
// 四级回到 chat-ui/ui 根再进 src/styles（见该文件 css() 助手）。
const STYLES_DIR = new URL("../../../../src/styles/", import.meta.url);

function listCssFiles(): Array<{ name: string; raw: string }> {
  const files: Array<{ name: string; raw: string }> = [];
  for (const name of readdirSync(STYLES_DIR)) {
    if (name.endsWith(".css")) {
      files.push({ name: `styles/${name}`, raw: readFileSync(new URL(name, STYLES_DIR), "utf8") });
    }
  }
  return files;
}

test("CSS 注释定界符配对且选择器位置无游离斜杠", () => {
  for (const { name, raw } of listCssFiles()) {
    const opens = (raw.match(/\/\*/g) ?? []).length;
    const closes = (raw.match(/\*\//g) ?? []).length;
    assert.equal(opens, closes, `${name}: /* 与 */ 数量不一致（${opens} vs ${closes}）`);

    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    // 规则形态「选择器{声明}」：逐块取选择器段断言无 `/`（与 vite.config.ts
    // assertCssSelectorsValid 插件同构：at-rule 取末段 + 剥引号属性值豁免）。
    const re = /([^{}]+)\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped))) {
      let selector = m[1];
      if (selector.trim().startsWith("@")) {
        selector = selector.slice(Math.max(0, selector.lastIndexOf(";")) + 1);
        if (selector.trim().startsWith("@")) continue;
      }
      selector = selector.replace(/"[^"]*"|'[^']*'/g, "");
      assert.ok(
        !selector.includes("/"),
        `${name}: 选择器包含非法字符 "/"（疑似注释定界符错位）→ ${JSON.stringify(selector.trim().slice(0, 60))}`,
      );
    }
  }
});
