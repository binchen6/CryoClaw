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

// 把重量级第三方库拆成独立 chunk：首帧只需解析 entry + 用到的 vendor，
// 复用度高的 vendor 走浏览器缓存（file:// 下同 app 内每次启动仍是本地磁盘读取，
// 但拆分让主 chunk 更小、解析更快，且构建告警阈值不再误报业务代码体积）。
function vendorChunks(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (id.includes("node_modules/lit") || id.includes("node_modules/@lit")) return "vendor-lit";
  if (id.includes("node_modules/marked")) return "vendor-marked";
  if (id.includes("node_modules/dompurify")) return "vendor-dompurify";
  if (id.includes("node_modules/@noble")) return "vendor-noble";
  return "vendor-misc";
}

export default defineConfig({
  root: ".",
  base: "./",
  plugins: [stripCrossorigin()],
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

