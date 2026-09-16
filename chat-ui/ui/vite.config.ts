import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";

/**
 * Strip `crossorigin` attribute from HTML output.
 * Electron loads chat-ui via loadFile (file:// protocol).
 * Chromium treats `crossorigin` on module scripts as a CORS fetch,
 * which silently fails for file:// URLs → blank page.
 */
function stripCrossorigin(): Plugin {
  return {
    name: "strip-crossorigin",
    enforce: "post",
    transformIndexHtml(html) {
      return html.replace(/ crossorigin/g, "");
    },
  };
}

/**
 * Post-validate emitted CSS: fail the build if any rule selector contains "/".
 * R85 事故防线：primitives.css 头注释结尾多写了一个斜杠（星杠之后再跟斜杠），
 * 注释剥除后游离斜杠粘到下一条规则选择器上，Chromium 静默丢弃整条规则，
 * 按钮全部退化成原生样式；构建期 esbuild 仅输出 WARNING 未拦截。
 * 合法 CSS 选择器不含斜杠，在产物上校验可捕获一切同类源码错位（含 vendor CSS）。
 */
function assertCssSelectorsValid(): Plugin {
  return {
    name: "assert-css-selectors-valid",
    enforce: "post",
    generateBundle(_, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "asset" || !fileName.endsWith(".css")) continue;
        const css = String(chunk.source);
        const re = /([^{}]+)\{/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(css))) {
          // at-rule 头（@media/@import 等）本体不校验；@import 后跟的规则
          // 会混进同一段，取最后一个 ";" 之后的真实选择器再验
          let selector = m[1];
          if (selector.trim().startsWith("@")) {
            selector = selector.slice(Math.max(0, selector.lastIndexOf(";")) + 1);
            if (selector.trim().startsWith("@")) continue;
          }
          // 带引号的属性选择器值（a[href^="https://"]）合法含斜杠，剥掉再验
          selector = selector.replace(/"[^"]*"|'[^']*'/g, "");
          if (selector.includes("/")) {
            this.error(
              `CSS 产物含非法选择器（疑似注释定界符错位，规则将被浏览器静默丢弃）: ${fileName} → ${JSON.stringify(selector.trim().slice(0, 60))}`,
            );
          }
        }
      }
    },
  };
}

// 把重量级第三方库拆成独立 chunk：首帧只需解析 entry + 用到的 vendor，
// 复用度高的 vendor 走浏览器缓存（file:// 下同 app 内每次启动仍是本地磁盘读取，
// 但拆分让主 chunk 更小、解析更快，且构建告警阈值不再误报业务代码体积）。
// R91 性能审查：hljs/katex 从 vendor-misc 再拆出——两者在源码里全是动态
// import（code-block-enhance / math-enhance 按需加载），合在 vendor-misc 会被
// modulepreload 在每次窗口创建时强制加载（katex 对纯文本会话永远用不到）。
function vendorChunks(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  // CSS 模块一律随 vendor-misc（历史行为）：把 katex.min.css 划进 vendor-katex
  // 会让 Rollup 为样式生成静态 facade import，反向把 JS chunk 拖进 HTML 的
  // modulepreload——与"动态按需加载"的初衷相悖
  if (id.endsWith(".css")) return "vendor-misc";
  if (id.includes("node_modules/lit") || id.includes("node_modules/@lit")) return "vendor-lit";
  if (id.includes("node_modules/marked")) return "vendor-marked";
  if (id.includes("node_modules/dompurify")) return "vendor-dompurify";
  if (id.includes("node_modules/@noble")) return "vendor-noble";
  if (id.includes("node_modules/highlight.js") || id.includes("node_modules/@highlightjs")) return "vendor-hljs";
  if (id.includes("node_modules/katex")) return "vendor-katex";
  return "vendor-misc";
}

export default defineConfig({
  root: ".",
  base: "./",
  plugins: [stripCrossorigin(), assertCssSelectorsValid()],
  resolve: {
    alias: {
      // The UI source references files outside ui/ via ../../../src/
      // We map these to our local copies at chat-ui/src/
    },
  },
  build: {
    outDir: resolve(__dirname, "../dist"),
    emptyOutDir: true,
    // 业务代码本体较大（多视图单页），500kB 阈值会持续误报；
    // 已用 manualChunks 把第三方库拆走，业务 chunk 阈值放宽到 700kB 便于发现真实异常增长。
    chunkSizeWarningLimit: 700,
    // 产物不打 sourcemap：file:// 本地应用用不上远程符号化，.map 约占 1.7MB 纯增体积（R6 裁剪）。
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, "index.html"),
      output: {
        manualChunks: vendorChunks,
      },
    },
  },
  server: {
    port: 5173,
    open: false,
  },
});

