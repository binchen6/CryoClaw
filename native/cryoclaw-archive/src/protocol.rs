// protocol.rs — stdin/stdout JSON Lines 协议。
// 输入：单行 JSON command（create 的条目清单可能很大，单行大 JSON 避免双向
// 管道死锁——JS 侧异步写 stdin 并并发读 stdout）。输出：progress 事件（≥100ms
// 节流）+ 最终 result 行；exit code 与 result.ok 一致。

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Read, Write};
use std::time::{Duration, Instant};

use crate::errors::{ArchiveError, ArchiveResult};

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum Command {
    Create(CreateCommand),
    Manifest(ManifestCommand),
    Extract(ExtractCommand),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommand {
    pub output: String,
    pub entries: Vec<CreateEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEntry {
    /// 源文件绝对路径（内联条目忽略）。
    pub path: String,
    /// zip 内条目名（目录带尾部 "/"）。
    pub rel_path: String,
    pub kind: EntryKind,
    /// unix 权限位（0o777 掩码）。
    pub mode: u32,
    /// JS 侧从本地时间换算好的 DOS 日期/时间（sidecar 不依赖本地时区库）。
    pub dos_date: u16,
    pub dos_time: u16,
    #[serde(default)]
    pub compression: Compression,
    /// 非空时写入内联内容（归档 marker），path 忽略。
    #[serde(default)]
    pub content_base64: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

impl EntryKind {
    pub fn is_dir(self) -> bool {
        matches!(self, EntryKind::Dir)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Compression {
    #[default]
    Deflate,
    Store,
}

#[derive(Debug, Deserialize)]
pub struct ManifestCommand {
    pub zip: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractCommand {
    pub zip: String,
    /// None = 只校验不落地（validate 形态）。
    #[serde(default)]
    pub output_dir: Option<String>,
    /// JS 白名单条目（已经过路径注册表/类型/大小校验），name 匹配 central 条目，
    /// segments 用于在 output_dir 下重建目标路径（不信任 zip 内名称做拼接）。
    /// None = 交互模式：sidecar 解析后先向 stdout 发 manifest 事件，再从 stdin
    /// 读一行白名单 JSON 继续——单进程单解析，文件句柄持有（消除 manifest 与
    /// extract 两次调用间 zip 被替换的 TOCTOU 窗口）。
    #[serde(default)]
    pub entries: Option<Vec<ExtractEntry>>,
    #[serde(default)]
    pub capture: Vec<String>,
    /// JS 侧 `new Date().getTimezoneOffset()`（UTC-本地，分钟）。DOS 时间为本地
    /// 墙钟，换算 SystemTime 时需补回该偏移，保证与 JS backend 的 utimes 语义一致。
    pub utc_offset_minutes: i32,
}

/// 交互模式 stdin 第二行：JS 对 manifest 事件跑完白名单校验后回写。
#[derive(Debug, Deserialize)]
pub struct WhitelistLine {
    pub entries: Vec<ExtractEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ExtractEntry {
    pub name: String,
    pub kind: EntryKind,
    pub segments: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub name: String,
    pub kind: EntryKind,
    pub compression: u16,
    pub crc32: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub version_made_by: u16,
    pub external_attrs: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedEntry {
    pub name: String,
    pub content_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename = "progress")]
    Progress { done: u64, total: u64, entry: String },
    /// 交互模式 extract：解析完成、等待 stdin 白名单行前发出（不节流）。
    #[serde(rename = "manifest")]
    Manifest { entries: Vec<ManifestEntry> },
    #[serde(rename = "result")]
    Result {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        entries: Option<Vec<ManifestEntry>>,
        #[serde(rename = "entryNames", skip_serializing_if = "Option::is_none")]
        entry_names: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        capture: Option<Vec<CapturedEntry>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<ErrorBody>,
    },
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
}

impl From<&ArchiveError> for ErrorBody {
    fn from(err: &ArchiveError) -> Self {
        ErrorBody { code: err.code.to_string(), message: err.message.clone() }
    }
}

pub fn read_command<R: BufRead>(mut reader: R) -> ArchiveResult<Command> {
    let line = read_protocol_line(&mut reader, "command")?;
    serde_json::from_str(line.trim()).map_err(|err| ArchiveError::new("protocol", format!("command JSON 解析失败: {err}")))
}

/// 交互模式 stdin 第二行（白名单）。JS 进程死亡时管道关闭、read_line 返回 0，
/// 报 protocol 错退出——不会永久阻塞。
pub fn read_whitelist_line<R: BufRead>(mut reader: R) -> ArchiveResult<WhitelistLine> {
    let line = read_protocol_line(&mut reader, "whitelist")?;
    serde_json::from_str(line.trim()).map_err(|err| ArchiveError::new("protocol", format!("whitelist JSON 解析失败: {err}")))
}

fn read_protocol_line<R: BufRead>(reader: &mut R, what: &str) -> ArchiveResult<String> {
    let mut line = String::new();
    // 条目清单上限 256MB——远超实际归档规模，只防恶意管道无限流。
    const MAX_COMMAND_BYTES: u64 = 256 * 1024 * 1024;
    // UFCS 显式取 &mut R 的 take（Read 为 &mut R 有 blanket impl），避免移动 R
    let mut limited = Read::take(&mut *reader, MAX_COMMAND_BYTES);
    let read = limited.read_line(&mut line).map_err(|err| {
        if err.kind() == io::ErrorKind::UnexpectedEof {
            ArchiveError::new("protocol", format!("{what} 行缺失或超过 256MB 上限"))
        } else {
            ArchiveError::from(err)
        }
    })?;
    if read == 0 {
        return Err(ArchiveError::new("protocol", format!("stdin 为空：缺少 JSON {what} 行")));
    }
    Ok(line)
}

/// stdout 事件写出器；progress 节流（距上次 ≥100ms 或最后一条才发）。
pub struct EventWriter {
    out: io::Stdout,
    total: u64,
    last_flush: Instant,
}

impl EventWriter {
    pub fn new(total: u64) -> Self {
        EventWriter { out: io::stdout(), total, last_flush: Instant::now() - Duration::from_millis(200) }
    }

    pub fn progress(&mut self, done: u64, entry: &str) -> ArchiveResult<()> {
        if self.last_flush.elapsed() < Duration::from_millis(100) && done < self.total {
            return Ok(());
        }
        self.last_flush = Instant::now();
        self.emit(&Event::Progress { done, total: self.total, entry: entry.to_string() })
    }

    /// manifest 事件：交互模式的握手，必须立即发出（不节流）。
    pub fn manifest(&mut self, entries: Vec<ManifestEntry>) -> ArchiveResult<()> {
        self.emit(&Event::Manifest { entries })
    }

    fn emit(&mut self, event: &Event) -> ArchiveResult<()> {
        let line = serde_json::to_string(event).map_err(|err| ArchiveError::new("protocol", err.to_string()))?;
        writeln!(self.out, "{line}").and_then(|()| self.out.flush()).map_err(ArchiveError::from)
    }
}
