// extract-archive.js — 纯 JS 归档解压（零 shell 子进程）：
//   - extractZipArchive:   .zip（fflate unzipSync）
//   - extractTarGzArchive: .tar.gz / .tgz（fflate gunzipSync + 内置最小 tar 读取器）
// 取代 tar/unzip execFileSync 调用，彻底移除构建期的外部解压工具依赖
//（同时消除 CWE-88 命令选项注入面）。
//
// 安全设计：
//   - 条目名规范化（反斜杠归一）后逐段校验：拒绝绝对路径、盘符、".." 上跳段、
//     NUL —— 解压结果必须全部落在目标目录内（CWE-22 根边界防护）；
//   - 只处理文件/目录条目；tar 符号链接（typeflag '1'/'2'）按包内目标内容
//     实体化复制（npm 的 .bin 链接指向包内脚本），包外链接一律拒绝；
//   - 解压在临时目录进行，由调用方负责生命周期。
"use strict";

const fs = require("fs");
const path = require("path");
const { unzipSync, gunzipSync } = require("fflate");

// 校验归档条目相对路径：拒绝绝对路径/盘符/上跳段/NUL，返回规范化斜杠后的相对路径
function safeEntryRelPath(rawName) {
  const name = String(rawName).replace(/\\/g, "/").replace(/\0+$/, "").trim();
  if (!name || name.endsWith("/")) return name; // 目录条目（保留尾斜杠判断由调用方处理）
  if (/^\/+/.test(name) || /^[A-Za-z]:/.test(name) || name.includes("\0")) {
    throw new Error(`拒绝归档内的绝对路径条目: ${name}`);
  }
  const segments = name.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(`拒绝归档内的上跳路径段: ${name}`);
    }
  }
  return name;
}

function ensureWithinDest(destDir, absPath) {
  const rel = path.relative(destDir, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`解压结果越出目标目录: ${absPath}`);
  }
}

function writeEntryFile(destDir, relPath, content) {
  const abs = path.join(destDir, ...relPath.split("/"));
  ensureWithinDest(destDir, abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function writeEntryDir(destDir, relPath) {
  const abs = path.join(destDir, ...relPath.split("/"));
  ensureWithinDest(destDir, abs);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

// ── zip ──
function extractZipArchive(archivePath, destDir) {
  const zipped = unzipSync(new Uint8Array(fs.readFileSync(archivePath)));
  for (const [rawName, content] of Object.entries(zipped)) {
    const isDir = rawName.endsWith("/") || (content && content.length === 0 && !rawName.includes("."));
    const rel = safeEntryRelPath(rawName);
    if (!rel) continue;
    if (isDir) {
      writeEntryDir(destDir, rel);
    } else {
      writeEntryFile(destDir, rel, content);
    }
  }
}

// ── tar（512 字节头；支持 ustar prefix 与 GNU longname 'L'） ──
function parseTarHeader(block, offset) {
  // 注意：Uint8Array.toString() 忽略参数并返回逗号数字串，必须经 Buffer 转码
  const str = (start, len) => {
    const slice = block.subarray(offset + start, offset + start + len);
    const nul = slice.indexOf(0);
    return Buffer.from(slice.subarray(0, nul === -1 ? len : nul)).toString("utf8");
  };
  const name = str(0, 100);
  const size = parseInt(str(124, 12).replace(/[^0-7]/g, ""), 8) || 0;
  const typeflag = String.fromCharCode(block[offset + 156]) || "0";
  const magic = str(257, 6);
  const prefix = magic.startsWith("ustar") ? str(345, 155) : "";
  const linkname = str(157, 100);
  return { name, size, typeflag, prefix, linkname, dataStart: offset + 512, dataEnd: offset + 512 + size };
}

function extractTarGzArchive(archivePath, destDir) {
  const tar = gunzipSync(new Uint8Array(fs.readFileSync(archivePath)));
  const symlinks = []; // { relPath, linkname }：两遍法，最后按包内目标实体化
  let offset = 0;
  let pendingLongName = null;

  while (offset + 512 <= tar.length) {
    const block = tar;
    // 结束块：全零头
    if (block.subarray(offset, offset + 512).every((b) => b === 0)) break;

    const header = parseTarHeader(block, offset);
    let name = pendingLongName !== null ? pendingLongName : header.name;
    pendingLongName = null;
    if (header.prefix) name = `${header.prefix}/${name}`;

    const data = tar.subarray(header.dataStart, header.dataEnd);
    // 数据块按 512 对齐推进：下一头部 = 数据起始 + ceil(size/512)*512
    offset = header.dataStart + Math.ceil(header.size / 512) * 512;

    if (header.typeflag === "L") {
      // GNU long name：数据块是下一个条目的真实名字
      pendingLongName = Buffer.from(data).toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (header.typeflag === "K") {
      // GNU long linkname：后续条目的链接目标，跳过（不支持包外链接）
      continue;
    }

    const rel = safeEntryRelPath(name);
    if (!rel) continue;

    if (header.typeflag === "5") {
      writeEntryDir(destDir, rel.replace(/\/+$/, ""));
      continue;
    }
    if (header.typeflag === "1" || header.typeflag === "2") {
      // 硬链接/符号链接：记录后统一实体化（拒绝指向包外的链接）
      symlinks.push({ relPath: rel, linkname: header.linkname });
      continue;
    }
    if (header.typeflag === "0" || header.typeflag === "\0" || header.typeflag === "7") {
      writeEntryFile(destDir, rel, Buffer.from(data));
      continue;
    }
    // 其余类型（char device/block/fifo 等）不应出现在运行时/插件包内，跳过
  }

  // 符号链接实体化：只允许指向包内条目（复制目标内容为普通文件）
  for (const { relPath, linkname } of symlinks) {
    const targetRel = safeEntryRelPath(path.posix.join(path.posix.dirname(relPath), linkname));
    const targetAbs = path.join(destDir, ...targetRel.split("/"));
    ensureWithinDest(destDir, targetAbs);
    if (fs.existsSync(targetAbs) && fs.statSync(targetAbs).isFile()) {
      writeEntryFile(destDir, relPath, fs.readFileSync(targetAbs));
    }
  }
}

module.exports = { extractZipArchive, extractTarGzArchive };
