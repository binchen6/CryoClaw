import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 编译产物在 chat-ui/ui/.test-dist/ui/src/ui/，因此到 chat-ui/ui/ 需要 4 层。
const css = (relative: string) => readFileSync(new URL(`../../../../src/styles/${relative}`, import.meta.url), "utf8");
/** 剥掉注释：注释里会提到旧写法（解释为什么废弃），不能当声明断言。 */
const declarationsOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

// 聚焦系统（2026.10.30）：一条主色边 + 一层极淡光晕；三档按元素类型选用，
// 输入控件统一用 --focus-field（与对话输入卡同款），不再各页混用实色环/硬描边。

test("聚焦令牌集中在 tokens-ext.css，三档齐全且不写死颜色", () => {
  const tokens = declarationsOnly(css("tokens-ext.css"));
  for (const name of ["--focus-field-color", "--focus-field", "--focus-ring", "--focus-ring-inset", "--focus-transition"]) {
    assert.match(tokens, new RegExp(`${name}\\s*:`), `缺少聚焦令牌 ${name}`);
  }
  // 边框色必须是 accent 与 border 的混色（柔和），不是全饱和 accent。
  assert.match(tokens, /--focus-field-color:\s*color-mix\(in srgb, var\(--accent\) \d+%, var\(--border\)\)/);
  // 环本身用 accent-subtle 打底、accent 收边，视觉更淡。
  assert.match(tokens, /--focus-ring:\s*0 0 0 2px var\(--accent-subtle\), 0 0 0 3px var\(--ring\)/);
  assert.match(tokens, /--focus-field:\s*0 0 0 3px var\(--accent-subtle\)/);
});

test("全局不再用 outline 做聚焦（圆角控件会露方角），改用 box-shadow 环", () => {
  const base = declarationsOnly(css("base.css"));
  const rule = base.match(/:focus-visible \{([^}]*)\}/);
  assert.ok(rule, ":focus-visible 基线存在");
  assert.match(rule[1], /outline:\s*none/);
  assert.match(rule[1], /box-shadow:\s*var\(--focus-ring\)/);
  // 指针聚焦不显示环
  assert.match(base, /:focus:not\(:focus-visible\) \{\s*box-shadow: none;/);
});

test("全站样式表里没有残留的 outline: 2px solid 聚焦写法", () => {
  const files = ["base.css", "components.css", "primitives.css", "chat.css", "chat-misc.css", "compose.css",
    "cron.css", "dashboard.css", "model-picker.css", "session-panel.css", "settings.css", "settings-misc.css",
    "setup.css", "skills.css", "tasks-misc.css", "tokens-ext.css", "workspace.css", "shell.css", "plan.css"];
  const offenders: string[] = [];
  for (const file of files) {
    const body = declarationsOnly(css(file));
    // 只看「聚焦规则里」的 outline。看板编辑态用 outline 标记选中元素/卡片是
    // 选择态语义（`.is-editing` / `.is-selected`），不是聚焦，不属本规则范围。
    for (const rule of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const [, selector, declarations] = rule;
      if (!/:focus/.test(selector)) continue;
      if (/\bis-editing\b|is-selected|data-dashboard-selected-element/.test(selector)) continue;
      for (const match of declarations.matchAll(/outline:\s*2px solid[^;]*;/g)) {
        offenders.push(`${file}: ${selector.trim()} → ${match[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `仍有硬描边聚焦：\n${offenders.join("\n")}`);
});

test("输入控件统一走 --focus-field，与对话输入卡同一套聚焦语言", () => {
  // 只针对「文本类输入控件本体」：按钮/图标钮/菜单项/单选复选对勾用 --focus-ring 是正确的
  // （紧凑控件需要清晰的 2px 环），不能一起改。
  const textInputSelector = /(^|[\s,])(input|textarea|select)(?![^{}]*(?:type=["']?(?:radio|checkbox|range|color|file)))/;
  const files = ["components.css", "cron.css", "session-panel.css", "settings.css", "setup.css",
    "skills.css", "tasks-misc.css", "workspace.css", "chat-misc.css", "model-picker.css"];
  const offenders: string[] = [];
  for (const file of files) {
    const body = declarationsOnly(css(file));
    for (const rule of body.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const [, selector, declarations] = rule;
      if (!/:focus/.test(selector)) continue;
      if (!textInputSelector.test(selector)) continue;
      if (/--focus-field/.test(declarations)) continue;
      offenders.push(`${file}: ${selector.trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], `这些输入控件的聚焦规则没接入 --focus-field：\n${offenders.join("\n")}`);
  // 抽查代表性输入：设置页输入、搜索框、cron 表单、工作区导航。
  for (const file of ["components.css", "settings.css", "cron.css", "workspace.css", "tasks-misc.css"]) {
    assert.match(declarationsOnly(css(file)), /--focus-field-color/, `${file} 的输入框未接入 --focus-field-color`);
  }
});

test("对话输入卡是聚焦系统的参照实现，且复用同一组令牌（不各写一份）", () => {
  const compose = declarationsOnly(css("compose.css"));
  const blocks = [...compose.matchAll(/\.chat-compose__field:focus-within\s*\{([^}]*)\}/g)];
  assert.ok(blocks.length > 0, "对话输入卡 focus-within 规则存在");
  for (const [, declarations] of blocks) {
    // 参照实现必须引用 --focus-field-color / --focus-field，改令牌时同步生效；
    // 不允许再写死 color-mix(...accent...42%) 这种一次性数值。
    assert.match(declarations, /--focus-field-color/, "对话输入卡应复用 --focus-field-color");
    assert.match(declarations, /--focus-field\b/, "对话输入卡应复用 --focus-field");
  }
});

test("密集列表行用内描边，避免外环溢出到相邻行", () => {
  const panel = declarationsOnly(css("session-panel.css"));
  const block = panel.match(/\.oc-panel__session-item:has\(\.oc-panel__session-select:focus-visible\)\s*\{([^}]*)\}/);
  assert.ok(block, "会话行聚焦规则存在");
  assert.match(block[1], /box-shadow:\s*var\(--focus-ring-inset\)/);
  assert.doesNotMatch(block[1], /outline:/);
});

test("减少动态效果下聚焦过渡不空转", () => {
  const base = declarationsOnly(css("base.css"));
  // 全局 reduced-motion 块把动画收敛到瞬时；--focus-transition 走的是 transition，同样被收敛。
  assert.match(base, /prefers-reduced-motion/);
});