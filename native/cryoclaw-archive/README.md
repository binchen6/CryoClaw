# cryoclaw-archive

CryoClaw `.openclaw` 归档导入/导出/校验的 Rust sidecar（binary，非库）。只做**字节级 zip 读写 + CRC32**；路径白名单/条目注册表/大小上限等安全校验留在 JS 侧（`src/openclaw-state-archive*.ts`），sidecar 在解压时额外做目标路径前缀约束作为防御纵深。

## 构建

```bash
cargo build --release   # 产物 target/release/cryoclaw-archive[.exe]
cargo test              # 单元测试
```

stable 工具链即可（无 rust-toolchain 钉定），edition 2021，无 unsafe。依赖：`flate2`（miniz_oxide 纯 Rust 后端，raw deflate）、`crc32fast`、`serde`/`serde_json`。

链接器：装了 VS Build Tools 的机器用默认 msvc 工具链；无 MSVC 的机器（如本机）用
`rustup toolchain install stable-x86_64-pc-windows-gnu`，构建时
`cargo +stable-x86_64-pc-windows-gnu build --release` 且 MinGW gcc 在 PATH
（本机 `/c/mingw64/mingw64/bin`）。若 msvc 构建报 link.exe "extra operand"，
是 Git Bash 的 GNU `link` 遮蔽了 MSVC linker。

## 协议

argv 子命令 + 单行 stdin JSON command + stdout JSON Lines（进度事件 + 最终结果）。stderr 只有人类可读诊断，协议只走 stdout。

```
cryoclaw-archive --version                 # 输出 "cryoclaw-archive <semver>"（JS 握手用）
cryoclaw-archive create     < /dev/stdin   # {"cmd":"create","output":"...","entries":[...]}
cryoclaw-archive manifest   < /dev/stdin   # {"cmd":"manifest","zip":"..."}
cryoclaw-archive extract    < /dev/stdin   # {"cmd":"extract","zip":"...","outputDir":"?","entries":[...],"capture":[...],"utcOffsetMinutes":-480}
```

输出：

```
{"type":"progress","done":12,"total":3000,"entry":"sessions/x.json"}   # ≥100ms 节流
{"type":"result","ok":true,...}
{"type":"result","ok":false,"error":{"code":"invalid-zip","message":"不是有效的 ZIP 数据包"}}
```

exit code 与 `ok` 一致（0/1）。

### create 条目

```json
{ "path": "/abs/or/inline", "relPath": "state/a.txt", "kind": "file",
  "mode": 420, "dosDate": 2100571, "dosTime": 40210,
  "compression": "deflate", "contentBase64": null }
```

- 顺序即 zip 内条目顺序（JS 侧已按确定性遍历排好，sidecar 不再排序）。
- `contentBase64` 非空时写入该内联内容（归档 marker 用），`path` 忽略。
- `dosDate`/`dosTime` 由 JS 从本地时间换算，避免 sidecar 依赖本地时区库。
- 文件条目流式 deflate（level 6）+ 流式 CRC32；local header 的 CRC/长度先行占位，条目写完后回 seek 补写（不产出 data descriptor）。
- central directory：version made by = unix/2.0，external attrs = `(mode & 0o777) << 16 | (dir ? 0x10 : 0)`，与 JS fflate 产物同构（JS 读取器可无差别回读）。

### manifest / extract 条目

`manifest` 不解压：只解析 central directory + local header 一致性（签名/分卷/ZIP64/加密/压缩方式/名称编码/local-central 一致/data descriptor 形态），输出条目清单。JS 侧对清单跑路径注册表/白名单/大小校验后，把**白名单条目**（name + kind + segments）交给 `extract` 单遍流式解压：CRC32/长度逐条校验、写盘、chmod/utimes、目录元数据最深优先恢复；`capture` 条目内容以 base64 内联在结果里（单条 5MB 上限）。解压目标路径一律在 `outputDir` 规范化前缀内，越界即拒绝（zip slip 防御纵深）。

## 错误文案

`error.message` 与 JS 实现逐条对齐（如 `不是有效的 ZIP 数据包`、`ZIP CRC 校验失败: <name>`、`ZIP entry 过大: <name>`）；JS 集成层对 `ok:false` 一律回退纯 JS backend 重跑，由 JS 产生权威错误文案，双实现文案不会漂移进用户可见路径。
