// i18n 已拆分为 i18n/ 目录（阶段 16：zh.ts / en.ts 字典 + index.ts API 实现）。
// 保留本文件做薄 re-export，既有 import 路径（"./i18n.ts"、"../i18n.ts"、"./ui/i18n"）全部不变。
export * from "./i18n/index.ts";
