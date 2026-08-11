/**
 * rm-rec.js — Windows 健壮的递归目录删除
 *
 * 背景：Node 24 在 Windows 上的 fs.rmSync({ recursive:true, force:true }) 偶发静默
 * 失败——调用返回不抛错，但目标目录及其内容仍在原处（参见
 * https://github.com/nodejs/node/issues/49530 及 CryoClaw 内部复现记录）。
 * 这会导致 pruneOpenclawSkills 等清理逻辑误以为已删除，后续 injectBuiltinSkills
 * 等步骤因 dest 仍存在而 die。
 *
 * 此处先试 fs.rmSync（带 maxRetries/retryDelay，对 macOS/Linux 仍是最优路径），
 * 再用 existsSync 验证；若仍存在则降级到手动递归 unlink/rmdir（逐项 chmod 防止
 * 只读文件阻塞），保证目录最终被删除。
 *
 * 调用方可传入自定义 fs 模块（如 Electron 的 original-fs）；默认使用 require("fs")。
 */
"use strict";

module.exports = function createRmRecursive(fsModule) {
  const fs = fsModule || require("fs");
  const path = require("path");

  function manualRm(target) {
    if (!fs.existsSync(target)) return;
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(target, { withFileTypes: true });
      } catch {
        // 目录不可读或已不存在，直接尝试 rmdir
      }
      for (const entry of entries) {
        manualRm(path.join(target, entry.name));
      }
      try { fs.chmodSync(target, 0o666); } catch {}
      try { fs.rmdirSync(target); } catch {}
    } else {
      try { fs.chmodSync(target, 0o666); } catch {}
      try { fs.unlinkSync(target); } catch {}
    }
  }

  return function rmRecursive(target) {
    if (!fs.existsSync(target)) return;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // 忽略，由手动 fallback 处理
    }
    if (fs.existsSync(target)) {
      manualRm(target);
    }
  };
};
