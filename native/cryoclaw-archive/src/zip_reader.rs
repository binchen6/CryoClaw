// zip_reader.rs — central directory 解析 + local header 一致性校验。
// 校验规则逐条镜像 src/openclaw-state-archive-zip.ts 的 readCentralDirectory /
// validateLocalHeaders：只接受单盘、非 ZIP64、central directory 在 EOF 的
// 简单子集；data descriptor 两种形态（带/不带签名）都支持但要求紧贴数据。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::errors::{ArchiveError, ArchiveResult};
use crate::protocol::{EntryKind, ManifestEntry};

const LOCAL_FILE_SIGNATURE: u32 = 0x04034b50;
const EOCD_SIGNATURE: u32 = 0x06054b50;
const CENTRAL_FILE_SIGNATURE: u32 = 0x02014b50;
const DATA_DESCRIPTOR_SIGNATURE: u32 = 0x08074b50;
const ZIP64_SENTINEL_16: u16 = 0xffff;
const ZIP64_SENTINEL_32: u32 = 0xffffffff;
const ZIP_COMPRESSION_STORE: u16 = 0;
const ZIP_COMPRESSION_DEFLATE: u16 = 8;
const ZIP_FLAG_ENCRYPTED: u16 = 1;
const ZIP_FLAG_DATA_DESCRIPTOR: u16 = 1 << 3;
const ZIP_FLAG_UTF8: u16 = 1 << 11;
const EOCD_MIN_LENGTH: u64 = 22;
const EOCD_MAX_SCAN: u64 = 22 + 65535;

#[derive(Debug, Clone)]
pub struct CentralEntry {
    pub name: String,
    pub kind: EntryKind,
    pub compression: u16,
    pub crc32: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub local_header_offset: u64,
    pub version_made_by: u16,
    pub external_attrs: u32,
    pub dos_time: u16,
    pub dos_date: u16,
    pub data_start: u64,
}

pub struct ParsedArchive {
    pub file: File,
    pub entries: Vec<CentralEntry>, // central directory 顺序
}

impl ParsedArchive {
    /// 按 local header offset 排序后的条目（解压读取顺序，与 JS 流式读取顺序一致）。
    pub fn entries_by_local_offset(&self) -> Vec<&CentralEntry> {
        let mut sorted: Vec<&CentralEntry> = self.entries.iter().collect();
        sorted.sort_by_key(|entry| entry.local_header_offset);
        sorted
    }
}

pub fn parse(zip_path: &str) -> ArchiveResult<ParsedArchive> {
    let path = Path::new(zip_path);
    let mut file = File::open(path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            ArchiveError::new("zip-not-found", "ZIP 文件不存在")
        } else {
            ArchiveError::from(err)
        }
    })?;
    let stat_size = file.metadata()?.len();
    if stat_size < EOCD_MIN_LENGTH {
        return Err(ArchiveError::invalid_zip());
    }

    // EOCD：在尾部 22+65535 窗口内从后向前扫描，且要求 comment 长度恰好落到窗口尾
    let tail_length = stat_size.min(EOCD_MAX_SCAN);
    let tail_offset = stat_size - tail_length;
    let mut tail = vec![0u8; tail_length as usize];
    file.seek(SeekFrom::Start(tail_offset))?;
    file.read_exact(&mut tail)?;
    let eocd_tail_offset = find_eocd(&tail).ok_or_else(ArchiveError::invalid_zip)?;

    let read_u16 = |buf: &[u8], at: usize| u16::from_le_bytes([buf[at], buf[at + 1]]);
    let read_u32 = |buf: &[u8], at: usize| u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);

    let eocd_offset = tail_offset + eocd_tail_offset as u64;
    let disk_number = read_u16(&tail, eocd_tail_offset + 4);
    let central_disk = read_u16(&tail, eocd_tail_offset + 6);
    let disk_entry_count = read_u16(&tail, eocd_tail_offset + 8);
    let total_entry_count = read_u16(&tail, eocd_tail_offset + 10);
    let central_size = read_u32(&tail, eocd_tail_offset + 12);
    let central_offset = read_u32(&tail, eocd_tail_offset + 16);

    if disk_number != 0 || central_disk != 0 || disk_entry_count != total_entry_count {
        return Err(ArchiveError::multidisk());
    }
    if total_entry_count == ZIP64_SENTINEL_16 || central_size == ZIP64_SENTINEL_32 || central_offset == ZIP64_SENTINEL_32 {
        return Err(ArchiveError::zip64());
    }
    let central_size = central_size as u64;
    let central_offset = central_offset as u64;
    if central_offset + central_size != eocd_offset || central_offset > stat_size || central_size > stat_size {
        return Err(ArchiveError::invalid_zip());
    }

    let mut central = vec![0u8; central_size as usize];
    file.seek(SeekFrom::Start(central_offset))?;
    file.read_exact(&mut central)?;

    let mut entries: Vec<CentralEntry> = Vec::with_capacity(total_entry_count as usize);
    let mut offset = 0usize;
    for _ in 0..total_entry_count {
        if offset + 46 > central.len() || read_u32(&central, offset) != CENTRAL_FILE_SIGNATURE {
            return Err(ArchiveError::invalid_zip());
        }
        let version_made_by = read_u16(&central, offset + 4);
        let flags = read_u16(&central, offset + 8);
        let compression = read_u16(&central, offset + 10);
        let dos_time = read_u16(&central, offset + 12);
        let dos_date = read_u16(&central, offset + 14);
        let crc32 = read_u32(&central, offset + 16);
        let compressed_size = read_u32(&central, offset + 20);
        let uncompressed_size = read_u32(&central, offset + 24);
        let name_length = read_u16(&central, offset + 28) as usize;
        let extra_length = read_u16(&central, offset + 30) as usize;
        let comment_length = read_u16(&central, offset + 32) as usize;
        let disk_start = read_u16(&central, offset + 34);
        let external_attrs = read_u32(&central, offset + 38);
        let local_header_offset = read_u32(&central, offset + 42);
        let entry_end = offset + 46 + name_length + extra_length + comment_length;

        if entry_end > central.len() {
            return Err(ArchiveError::invalid_zip());
        }
        if disk_start != 0 {
            return Err(ArchiveError::multidisk());
        }
        if compressed_size == ZIP64_SENTINEL_32 || uncompressed_size == ZIP64_SENTINEL_32 || local_header_offset == ZIP64_SENTINEL_32 {
            return Err(ArchiveError::zip64());
        }
        if (local_header_offset as u64) >= central_offset {
            return Err(ArchiveError::invalid_zip());
        }
        if (flags & ZIP_FLAG_ENCRYPTED) != 0 {
            return Err(ArchiveError::encrypted());
        }
        if compression != ZIP_COMPRESSION_STORE && compression != ZIP_COMPRESSION_DEFLATE {
            // central 解析阶段的拒绝文案不带条目名（对齐 JS readCentralDirectory；
            // 带名的 `ZIP 压缩方式不受支持: <name>` 是流式阶段的校验）
            return Err(ArchiveError::new("compression-unsupported", "ZIP 压缩方式不受支持"));
        }

        let name_bytes = &central[offset + 46..offset + 46 + name_length];
        let name = decode_name(name_bytes, flags)?;
        let kind = if name.ends_with('/') { EntryKind::Dir } else { EntryKind::File };

        entries.push(CentralEntry {
            name,
            kind,
            compression,
            crc32,
            compressed_size: compressed_size as u64,
            uncompressed_size: uncompressed_size as u64,
            local_header_offset: local_header_offset as u64,
            version_made_by,
            external_attrs,
            dos_time,
            dos_date,
            data_start: 0, // validate_local_headers 填充
        });
        offset = entry_end;
    }
    if offset != central.len() {
        return Err(ArchiveError::invalid_zip());
    }

    validate_local_headers(&mut file, &mut entries, central_offset)?;
    Ok(ParsedArchive { file, entries })
}

fn validate_local_headers(file: &mut File, entries: &mut [CentralEntry], central_offset: u64) -> ArchiveResult<()> {
    // local header 不单独采信：必须与 central directory 一致且恰好占据分配给
    // 条目的字节区间（与 JS validateLocalHeaders 同规则）。
    let mut sorted: Vec<usize> = (0..entries.len()).collect();
    sorted.sort_by_key(|&i| entries[i].local_header_offset);

    let read_u16 = |buf: &[u8], at: usize| u16::from_le_bytes([buf[at], buf[at + 1]]);
    let read_u32 = |buf: &[u8], at: usize| u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);

    for pos in 0..sorted.len() {
        let index = sorted[pos];
        let entry = &entries[index];
        let next_offset = if pos + 1 < sorted.len() {
            entries[sorted[pos + 1]].local_header_offset
        } else {
            central_offset
        };
        if next_offset <= entry.local_header_offset {
            return Err(ArchiveError::invalid_zip());
        }

        let mut header = [0u8; 30];
        file.seek(SeekFrom::Start(entry.local_header_offset))?;
        file.read_exact(&mut header)?;
        if read_u32(&header, 0) != LOCAL_FILE_SIGNATURE {
            return Err(ArchiveError::invalid_zip());
        }
        let flags = read_u16(&header, 6);
        let compression = read_u16(&header, 8);
        let local_crc32 = read_u32(&header, 14);
        let local_compressed_size = read_u32(&header, 18);
        let local_uncompressed_size = read_u32(&header, 22);
        let name_length = read_u16(&header, 26) as u64;
        let extra_length = read_u16(&header, 28) as u64;
        let data_start = entry.local_header_offset + 30 + name_length + extra_length;

        if data_start > next_offset || data_start > central_offset {
            return Err(ArchiveError::invalid_zip());
        }
        if (flags & ZIP_FLAG_ENCRYPTED) != 0 {
            return Err(ArchiveError::encrypted());
        }
        if compression != entry.compression {
            return Err(ArchiveError::invalid_zip());
        }

        let mut name_bytes = vec![0u8; name_length as usize];
        file.seek(SeekFrom::Start(entry.local_header_offset + 30))?;
        file.read_exact(&mut name_bytes)?;
        if decode_name(&name_bytes, flags)? != entry.name {
            return Err(ArchiveError::invalid_zip());
        }

        if (flags & ZIP_FLAG_DATA_DESCRIPTOR) == 0 {
            let data_end = data_start + entry.compressed_size;
            if local_crc32 != entry.crc32
                || local_compressed_size as u64 != entry.compressed_size
                || local_uncompressed_size as u64 != entry.uncompressed_size
                || next_offset != data_end
            {
                return Err(ArchiveError::invalid_zip());
            }
        } else {
            validate_data_descriptor(file, entry, data_start, next_offset)?;
        }
        entries[index].data_start = data_start;
    }
    Ok(())
}

fn validate_data_descriptor(
    file: &mut File,
    entry: &CentralEntry,
    data_start: u64,
    next_offset: u64,
) -> ArchiveResult<()> {
    // 流式写入器常把 CRC/长度放在数据之后：两种形态（12 字节无签名 / 16 字节带
    // 签名）都支持，但 descriptor 必须紧贴数据尾部（对齐 JS validateDataDescriptor）。
    let read_u32_at = |file: &mut File, at: u64| -> ArchiveResult<u32> {
        let mut buf = [0u8; 4];
        file.seek(SeekFrom::Start(at))?;
        file.read_exact(&mut buf)?;
        Ok(u32::from_le_bytes(buf))
    };

    if next_offset - data_start >= 16 {
        let descriptor_offset = next_offset - 16;
        if read_u32_at(file, descriptor_offset)? == DATA_DESCRIPTOR_SIGNATURE {
            validate_descriptor_values(
                entry,
                read_u32_at(file, descriptor_offset + 4)?,
                read_u32_at(file, descriptor_offset + 8)?,
                read_u32_at(file, descriptor_offset + 12)?,
            )?;
            if descriptor_offset - data_start != entry.compressed_size {
                return Err(ArchiveError::invalid_zip());
            }
            return Ok(());
        }
    }

    if next_offset - data_start >= 12 {
        let descriptor_offset = next_offset - 12;
        validate_descriptor_values(
            entry,
            read_u32_at(file, descriptor_offset)?,
            read_u32_at(file, descriptor_offset + 4)?,
            read_u32_at(file, descriptor_offset + 8)?,
        )?;
        if descriptor_offset - data_start != entry.compressed_size {
            return Err(ArchiveError::invalid_zip());
        }
        return Ok(());
    }

    Err(ArchiveError::invalid_zip())
}

fn validate_descriptor_values(entry: &CentralEntry, crc32: u32, compressed_size: u32, uncompressed_size: u32) -> ArchiveResult<()> {
    if crc32 != entry.crc32 {
        return Err(ArchiveError::crc_mismatch(&entry.name));
    }
    if compressed_size as u64 != entry.compressed_size || uncompressed_size as u64 != entry.uncompressed_size {
        return Err(ArchiveError::invalid_zip());
    }
    Ok(())
}

fn decode_name(name_bytes: &[u8], flags: u16) -> ArchiveResult<String> {
    // 不做 CP437/本地化解码：非 ASCII 名称必须带 UTF-8 标记（对齐 JS decodeZipName）。
    if (flags & ZIP_FLAG_UTF8) == 0 && name_bytes.iter().any(|&byte| byte > 0x7f) {
        return Err(ArchiveError::name_encoding());
    }
    String::from_utf8(name_bytes.to_vec()).map_err(|_| ArchiveError::name_encoding())
}

fn find_eocd(tail: &[u8]) -> Option<usize> {
    if tail.len() < EOCD_MIN_LENGTH as usize {
        return None;
    }
    for offset in (0..=tail.len() - EOCD_MIN_LENGTH as usize).rev() {
        if u32::from_le_bytes([tail[offset], tail[offset + 1], tail[offset + 2], tail[offset + 3]]) != EOCD_SIGNATURE {
            continue;
        }
        let comment_length = u16::from_le_bytes([tail[offset + 20], tail[offset + 21]]) as usize;
        if offset + 22 + comment_length == tail.len() {
            return Some(offset);
        }
    }
    None
}

pub fn to_manifest(entries: &[CentralEntry]) -> Vec<ManifestEntry> {
    entries
        .iter()
        .map(|entry| ManifestEntry {
            name: entry.name.clone(),
            kind: entry.kind,
            compression: entry.compression,
            crc32: entry.crc32,
            compressed_size: entry.compressed_size,
            uncompressed_size: entry.uncompressed_size,
            version_made_by: entry.version_made_by,
            external_attrs: entry.external_attrs,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eocd_scan_rejects_trailing_garbage_and_fake_signatures() {
        // EOCD + 3 字节注释：comment 长度不符 → 拒绝
        let mut tail = vec![0u8; 30];
        tail[0..4].copy_from_slice(&EOCD_SIGNATURE.to_le_bytes());
        tail[20..22].copy_from_slice(&5u16.to_le_bytes()); // 宣称 5 字节注释，实际 8
        assert!(find_eocd(&tail).is_none());

        // 合法：22 字节 EOCD、无注释
        let mut exact = vec![0u8; 22];
        exact[0..4].copy_from_slice(&EOCD_SIGNATURE.to_le_bytes());
        assert_eq!(find_eocd(&exact), Some(0));

        // EOCD 签名出现在中间、尾部另有合法 EOCD → 取尾部那个
        let mut dup = vec![0u8; 44];
        dup[0..4].copy_from_slice(&EOCD_SIGNATURE.to_le_bytes());
        dup[22..26].copy_from_slice(&EOCD_SIGNATURE.to_le_bytes());
        assert_eq!(find_eocd(&dup), Some(22));
    }
}
