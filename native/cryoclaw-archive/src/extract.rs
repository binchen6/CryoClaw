// extract.rs — 单遍流式解压：按 local header offset 顺序读数据流，逐条目
// CRC32/长度校验 + 写盘 + chmod/utimes；目录元数据最后按深度降序恢复。
// 目标路径一律由 JS 白名单 segments 在 output_dir 下重建，并做规范化前缀
// 约束（zip slip 防御纵深；权威白名单/注册表校验在 JS 侧）。
//
// 白名单两种供给形态：
//   - entries 随 command 行内联（旧协议，测试与单发场景用）；
//   - entries 为 null 的交互模式：解析完成后向 stdout 发 manifest 事件，
//     从 stdin 读白名单行再继续——zip 只解析一遍、文件句柄全程持有，
//     消除 manifest/extract 两次 spawn 间 zip 被替换的 TOCTOU 窗口。

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crc32fast::Hasher;
use flate2::read::DeflateDecoder;

use crate::errors::{ArchiveError, ArchiveResult};
use crate::protocol::{self, CapturedEntry, EntryKind, EventWriter, ExtractCommand, ExtractEntry};
use crate::zip_reader::{self, CentralEntry};

const ZIP_COMPRESSION_STORE: u16 = 0;
const MAX_CAPTURED_ENTRY_BYTES: u64 = 5 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 3 * 1024 * 1024 * 1024;
const MAX_ENTRY_COUNT: usize = 50_000;

#[cfg(test)]
mod output_budget_tests {
    use super::*;
    #[test]
    fn uncaptured_output_stops_at_declared_size() {
        let mut state = EntryState::begin(false);
        state.expected_size = 2;
        assert!(pump_stream(&b"abc"[..], &mut state, None, None, "data.bin").is_err());
        let mut valid = EntryState::begin(false);
        valid.expected_size = 3;
        assert!(pump_stream(&b"abc"[..], &mut valid, None, None, "data.bin").is_ok());
    }
}
const CHUNK_SIZE: usize = 64 * 1024;

pub fn run(cmd: &ExtractCommand, reader: &mut impl BufRead) -> ArchiveResult<(Vec<String>, Vec<CapturedEntry>)> {
    let parsed = zip_reader::parse(&cmd.zip)?;
    let mut total_bytes = 0u64;
    if parsed.entries.len() > MAX_ENTRY_COUNT {
        return Err(ArchiveError::new("resource-limit", "ZIP entry count exceeds resource limit"));
    }
    for entry in &parsed.entries {
        total_bytes = total_bytes.saturating_add(entry.uncompressed_size);
        if entry.uncompressed_size > MAX_ENTRY_BYTES || total_bytes > MAX_TOTAL_BYTES {
            return Err(ArchiveError::new("resource-limit", "ZIP output exceeds resource limit"));
        }
    }

    let whitelist_storage;
    let whitelist_source: &[ExtractEntry] = match &cmd.entries {
        Some(entries) => entries,
        None => {
            // 交互模式：先发 manifest（JS 侧跑白名单校验），再等 stdin 回行。
            // JS 校验失败会 kill 本进程；JS 进程死亡则 stdin 关闭、读行报错退出。
            let mut events = EventWriter::new(0);
            events.manifest(zip_reader::to_manifest(&parsed.entries))?;
            whitelist_storage = protocol::read_whitelist_line(reader)?.entries;
            &whitelist_storage
        }
    };

    // central 条目必须全部命中白名单（JS 已逐一校验；未命中 = 双实现漂移，fail closed）
    let whitelist: HashMap<&str, &ExtractEntry> =
        whitelist_source.iter().map(|entry| (entry.name.as_str(), entry)).collect();
    for entry in &parsed.entries {
        match whitelist.get(entry.name.as_str()) {
            None => {
                return Err(ArchiveError::new("whitelist-mismatch", format!("白名单缺失条目: {}", entry.name)));
            }
            Some(allowed) if allowed.kind != entry.kind => {
                // 白名单 kind 与 central 不一致 = JS/Rust 语义漂移，fail closed
                return Err(ArchiveError::new("whitelist-mismatch", format!("白名单条目类型不一致: {}", entry.name)));
            }
            Some(_) => {}
        }
    }
    let capture: HashSet<&str> = cmd.capture.iter().map(String::as_str).collect();
    let output_root = match &cmd.output_dir {
        Some(dir) => Some(prepare_output_root(Path::new(dir))?),
        None => None,
    };

    let mut events = EventWriter::new(parsed.entries.len() as u64);
    let mut capture_out: Vec<CapturedEntry> = Vec::new();
    // 目录元数据收集（entry 借用随 parsed 生命周期，足够覆盖恢复阶段）
    let mut dir_metadata: Vec<(PathBuf, &CentralEntry)> = Vec::new();
    // 已验证包含性的父目录缓存：同目录数百个文件只 canonicalize 一次（Windows 上
    // canonicalize 是重 syscall）。词法 parent → canonical 的映射在会话内稳定：
    // 目标树由本进程单线程创建/重建，无第三方并发写入。
    let mut verified_parents: HashSet<PathBuf> = HashSet::new();
    let mut done: u64 = 0;

    for entry in parsed.entries_by_local_offset() {
        let target = whitelist.get(entry.name.as_str()).expect("whitelist checked above");
        if entry.kind.is_dir() && entry.uncompressed_size > 0 {
            return Err(ArchiveError::dir_has_data(&entry.name));
        }
        if capture.contains(entry.name.as_str()) && entry.uncompressed_size > MAX_CAPTURED_ENTRY_BYTES {
            return Err(ArchiveError::entry_too_large(&entry.name));
        }

        let write_target = match (&output_root, entry.kind) {
            (Some(root), EntryKind::Dir) => {
                let dir = resolve_target(root, &target.segments, &entry.name)?;
                // 与文件分支同一防御纵深：父链可能被盘上既有 junction/符号链接
                // 重定向——规范化后必须在根内，否则 create_dir_all 会穿透到根外
                if let Some(parent) = dir.parent() {
                    ensure_parent_contained(root, parent, &mut verified_parents, &entry.name)?;
                }
                ensure_dir_target(&dir)?;
                dir_metadata.push((dir.clone(), entry));
                Some(dir)
            }
            (Some(root), EntryKind::File) => {
                let target_path = resolve_target(root, &target.segments, &entry.name)?;
                if let Some(parent) = target_path.parent() {
                    // 父目录可能被既有符号链接重定向：规范化后必须在根内
                    ensure_parent_contained(root, parent, &mut verified_parents, &entry.name)?;
                }
                ensure_file_target(&target_path)?;
                Some(target_path)
            }
            (None, _) => None,
        };

        // 数据泵：store 直接拷，deflate 经 DeflateDecoder；validate 形态（无
        // output_dir）只校验不落盘；目录条目只校验（且任何数据字节都拒绝）
        let mut state = EntryState::begin(capture.contains(entry.name.as_str()));
        state.expected_size = entry.uncompressed_size;
        {
            let mut file = &parsed.file;
            file.seek(SeekFrom::Start(entry.data_start))?;
            let limited = file.take(entry.compressed_size);
            let file_target = match entry.kind {
                EntryKind::File => write_target.as_deref(),
                EntryKind::Dir => None,
            };
            let dir_guard = match entry.kind {
                EntryKind::Dir => Some(entry.name.as_str()),
                EntryKind::File => None,
            };
            match entry.compression {
                ZIP_COMPRESSION_STORE => pump_stream(limited, &mut state, file_target, dir_guard, &entry.name)?,
                _ => pump_stream(DeflateDecoder::new(limited), &mut state, file_target, dir_guard, &entry.name)?,
            }
        }
        if let Some(target_path) = &write_target {
            if entry.kind == EntryKind::File {
                apply_file_metadata(target_path, entry, cmd.utc_offset_minutes);
            }
        }
        state.finish(entry, &mut capture_out)?;

        done += 1;
        events.progress(done, &entry.name)?;
    }

    // 目录元数据：最深（路径段最多）优先，与 JS restoreDirectoryMetadata 一致
    dir_metadata.sort_by_key(|(_, entry)| std::cmp::Reverse(segment_count(entry)));
    for (dir, entry) in dir_metadata {
        apply_file_metadata(&dir, entry, cmd.utc_offset_minutes);
    }

    Ok((parsed.entries.iter().map(|entry| entry.name.clone()).collect(), capture_out))
}

struct EntryState {
    expected_size: u64,
    hasher: Hasher,
    size: u64,
    captured: Option<Vec<u8>>,
}

impl EntryState {
    fn begin(want_capture: bool) -> Self {
        EntryState {
            expected_size: 0,
            hasher: Hasher::new(),
            size: 0,
            captured: if want_capture { Some(Vec::new()) } else { None },
        }
    }

    fn finish(self, entry: &CentralEntry, capture_out: &mut Vec<CapturedEntry>) -> ArchiveResult<()> {
        if self.size != entry.uncompressed_size {
            return Err(ArchiveError::size_mismatch(&entry.name));
        }
        if self.hasher.finalize() != entry.crc32 {
            return Err(ArchiveError::crc_mismatch(&entry.name));
        }
        if let Some(bytes) = self.captured {
            capture_out.push(CapturedEntry {
                name: entry.name.clone(),
                content_base64: base64_encode(&bytes),
            });
        }
        Ok(())
    }
}

fn pump_stream(
    mut reader: impl Read,
    state: &mut EntryState,
    target: Option<&Path>,
    dir_guard: Option<&str>,
    entry_name: &str,
) -> ArchiveResult<()> {
    let mut writer = match target {
        Some(path) => Some(BufWriter::new(OpenOptions::new().write(true).create(true).truncate(true).open(path)?)),
        None => None,
    };
    let mut buf = [0u8; CHUNK_SIZE];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        if let Some(name) = dir_guard {
            return Err(ArchiveError::dir_has_data(name));
        }
        state.hasher.update(&buf[..n]);
        state.size += n as u64;
        if state.size > state.expected_size {
            return Err(ArchiveError::size_mismatch(entry_name));
        }
        if let Some(bytes) = state.captured.as_mut() {
            bytes.extend_from_slice(&buf[..n]);
            // 流式上限：central 声明的 uncompressed_size 可为伪造小值（JS 的 5MB
            // 预检基于它），实际 deflate 流可展开出任意大的输出——泵内不设上限会
            // 被 decompression bomb 打爆 sidecar 内存（JS backend 逐 chunk 检查）
            if bytes.len() as u64 > MAX_CAPTURED_ENTRY_BYTES {
                return Err(ArchiveError::entry_too_large(entry_name));
            }
        }
        if let Some(writer) = writer.as_mut() {
            writer.write_all(&buf[..n])?;
        }
    }
    if let Some(writer) = writer.as_mut() {
        writer.flush()?;
    }
    Ok(())
}

fn ensure_parent_contained(
    root: &Path,
    parent: &Path,
    verified: &mut HashSet<PathBuf>,
    entry_name: &str,
) -> ArchiveResult<()> {
    if verified.contains(parent) {
        return Ok(());
    }
    fs::create_dir_all(parent)?;
    let canonical_parent = fs::canonicalize(parent)?;
    if !canonical_parent.starts_with(root) {
        return Err(ArchiveError::containment(entry_name));
    }
    verified.insert(parent.to_path_buf());
    Ok(())
}

fn prepare_output_root(dir: &Path) -> ArchiveResult<PathBuf> {
    // 与 JS ensureOutputRootDir 同语义：不存在则建（递归），存在则必须是真目录
    match fs::symlink_metadata(dir) {
        Ok(meta) => {
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err(ArchiveError::new("output-root-invalid", format!(".openclaw 不是目录: {}", dir.display())));
            }
            Ok(fs::canonicalize(dir)?)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(dir)?;
            Ok(fs::canonicalize(dir)?)
        }
        Err(err) => Err(ArchiveError::from(err)),
    }
}

fn resolve_target(root: &Path, segments: &[String], name: &str) -> ArchiveResult<PathBuf> {
    if segments.is_empty() {
        return Err(ArchiveError::containment(name));
    }
    let mut target = root.to_path_buf();
    for segment in segments {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains(std::path::is_separator) {
            return Err(ArchiveError::containment(name));
        }
        target.push(segment);
    }
    // 词法前缀约束（segments 已由 JS 校验不含盘符/反斜杠/越界段；这里双保险）
    if !target.starts_with(root) {
        return Err(ArchiveError::containment(name));
    }
    Ok(target)
}

fn ensure_dir_target(target: &Path) -> ArchiveResult<()> {
    // 与 JS ensureDirectoryOutputTarget 同语义：已是真目录则返回；
    // 符号链接/文件等占用一律移除后重建
    match fs::symlink_metadata(target) {
        Ok(meta) => {
            if meta.is_dir() && !meta.file_type().is_symlink() {
                return Ok(());
            }
            remove_existing(target, &meta)?;
            fs::create_dir_all(target)?;
            Ok(())
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(target)?;
            Ok(())
        }
        Err(err) => Err(ArchiveError::from(err)),
    }
}

fn ensure_file_target(target: &Path) -> ArchiveResult<()> {
    // 与 JS ensureFileOutputTarget 同语义：真文件保留（open 时截断）；
    // 目录/符号链接等占用一律移除
    match fs::symlink_metadata(target) {
        Ok(meta) => {
            if meta.is_file() && !meta.file_type().is_symlink() {
                return Ok(());
            }
            remove_existing(target, &meta)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(ArchiveError::from(err)),
    }
}

fn remove_existing(target: &Path, meta: &fs::Metadata) -> ArchiveResult<()> {
    if meta.is_dir() && !meta.file_type().is_symlink() {
        fs::remove_dir_all(target)?;
    } else {
        fs::remove_file(target)?;
    }
    Ok(())
}

fn apply_file_metadata(target: &Path, entry: &CentralEntry, utc_offset_minutes: i32) {
    // chmod 仅在 unix 属性来源（originOs 3/19）且 mode>0 时尝试；失败静默
    // （Windows 上 chmod 语义弱，对齐 JS try/catch）。utimes 一律 best-effort。
    let origin_os = entry.version_made_by >> 8;
    if (origin_os == 3 || origin_os == 19) && (entry.external_attrs >> 16) & 0o777 > 0 {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = (entry.external_attrs >> 16) & 0o777;
            let _ = fs::set_permissions(target, fs::Permissions::from_mode(mode));
        }
    }
    if let Ok(mtime) = dos_to_system_time(entry.dos_date, entry.dos_time, utc_offset_minutes) {
        if let Ok(file) = open_for_metadata_write(target) {
            let _ = file.set_modified(mtime);
        }
    }
}

// set_modified（Windows SetFileTime）要求句柄带 FILE_WRITE_ATTRIBUTES——File::open
// 的 GENERIC_READ 不含该权限，且普通 CreateFile 打不开目录句柄（需
// FILE_FLAG_BACKUP_SEMANTICS）；只读打开会让 mtime 恢复在 Windows 上静默失败
// （JS backend 的 fs.utimesSync 无此限制），双实现因此漂移。Windows 专用打开修复。
#[cfg(windows)]
fn open_for_metadata_write(target: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_WRITE_ATTRIBUTES: u32 = 0x100;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    OpenOptions::new()
        .access_mode(FILE_WRITE_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(target)
}

#[cfg(not(windows))]
fn open_for_metadata_write(target: &Path) -> std::io::Result<File> {
    File::open(target)
}

fn dos_to_system_time(dos_date: u16, dos_time: u16, utc_offset_minutes: i32) -> ArchiveResult<SystemTime> {
    if dos_date == 0 {
        // 对齐 JS dateFromDos：dosDate=0 读作 new Date(0)
        return Ok(UNIX_EPOCH);
    }
    let year = ((dos_date >> 9) & 0x7f) as i64 + 1980;
    let month = ((dos_date >> 5) & 0x0f) as i64;
    let day = (dos_date & 0x1f) as i64;
    let hour = ((dos_time >> 11) & 0x1f) as i64;
    let minute = ((dos_time >> 5) & 0x3f) as i64;
    let second = ((dos_time & 0x1f) as i64) * 2;
    let days = days_from_civil(year, month.max(1), day.max(1));
    let wall_clock_as_utc = days * 86_400 + hour * 3_600 + minute * 60 + second;
    // DOS 存本地墙钟：wall = utc - offset（getTimezoneOffset = UTC - 本地）
    let epoch = wall_clock_as_utc + utc_offset_minutes as i64 * 60;
    if epoch < 0 {
        return Ok(UNIX_EPOCH);
    }
    Ok(UNIX_EPOCH + std::time::Duration::from_secs(epoch as u64))
}

/// Howard Hinnant 的 days_from_civil 算法（公历，无第三方依赖）。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn segment_count(entry: &CentralEntry) -> usize {
    entry.name.matches('/').count()
}

// base64 编码（RFC 4648，含 padding），不引第三方库。
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let acc = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(acc >> 18) as usize & 0x3f] as char);
        out.push(TABLE[(acc >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 { TABLE[(acc >> 6) as usize & 0x3f] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[acc as usize & 0x3f] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_from_civil_matches_known_epochs() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1980, 1, 1), 3652); // DOS 纪元
        assert_eq!(days_from_civil(2026, 10, 8), 20_734);
    }

    #[test]
    fn base64_encodes_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn dos_time_zero_round_trips_to_epoch() {
        assert_eq!(dos_to_system_time(0, 0, 0).unwrap(), UNIX_EPOCH);
    }
}
