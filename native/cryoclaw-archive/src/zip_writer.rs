// zip_writer.rs — 流式 zip 创建。local header 的 CRC/长度先行占位，条目数据
// 写完后回 seek 补写（不产出 data descriptor）；产物与 JS fflate 写入器同构：
// version made by = unix/2.0，UTF-8 名称标记，external attrs = mode<<16 | dirflag。

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

use crc32fast::Hasher;
use flate2::{Compression, write::DeflateEncoder};

use crate::errors::{ArchiveError, ArchiveResult};
use crate::protocol::{Compression as EntryCompression, CreateCommand, CreateEntry};

const LOCAL_FILE_SIGNATURE: u32 = 0x04034b50;
const CENTRAL_FILE_SIGNATURE: u32 = 0x02014b50;
const EOCD_SIGNATURE: u32 = 0x06054b50;
const VERSION: u16 = 20;
const FLAG_UTF8: u16 = 1 << 11;
const METHOD_STORE: u16 = 0;
const METHOD_DEFLATE: u16 = 8;
const CHUNK_SIZE: usize = 64 * 1024;

struct CentralRecord {
    name: Vec<u8>,
    method: u16,
    dos_time: u16,
    dos_date: u16,
    crc32: u32,
    compressed_size: u64,
    uncompressed_size: u64,
    external_attrs: u32,
    local_header_offset: u64,
}

pub fn create(cmd: &CreateCommand) -> ArchiveResult<u64> {
    let output = Path::new(&cmd.output);
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }

    let mut file = File::create(output)?;
    let mut central: Vec<CentralRecord> = Vec::with_capacity(cmd.entries.len());

    for entry in &cmd.entries {
        central.push(write_entry(&mut file, entry)?);
    }

    let central_offset = file.stream_position()?;
    for record in &central {
        write_central_record(&mut file, record)?;
    }
    let central_size = file.stream_position()? - central_offset;

    // EOCD（非 ZIP64：条目数/尺寸均有 u16/u32 上限，超出即拒绝——与 JS 读取器
    // 的 ZIP64 拒绝策略互补，保证产物可被 JS 无差别回读）
    let count = u16::try_from(central.len()).map_err(|_| ArchiveError::zip64())?;
    let central_offset32 = u32::try_from(central_offset).map_err(|_| ArchiveError::zip64())?;
    let central_size32 = u32::try_from(central_size).map_err(|_| ArchiveError::zip64())?;

    let mut eocd = Vec::with_capacity(22);
    eocd.extend_from_slice(&EOCD_SIGNATURE.to_le_bytes());
    eocd.extend_from_slice(&0u16.to_le_bytes()); // disk number
    eocd.extend_from_slice(&0u16.to_le_bytes()); // central dir disk
    eocd.extend_from_slice(&count.to_le_bytes());
    eocd.extend_from_slice(&count.to_le_bytes());
    eocd.extend_from_slice(&central_size32.to_le_bytes());
    eocd.extend_from_slice(&central_offset32.to_le_bytes());
    eocd.extend_from_slice(&0u16.to_le_bytes()); // comment length
    file.write_all(&eocd)?;
    file.flush()?;

    Ok(central_offset + central_size + eocd.len() as u64)
}

fn write_entry(file: &mut File, entry: &CreateEntry) -> ArchiveResult<CentralRecord> {
    let name = entry.rel_path.as_bytes().to_vec();
    if entry.rel_path.is_empty() || entry.rel_path.contains('\\') {
        return Err(ArchiveError::invalid_zip_detail("条目名为空或含反斜杠"));
    }
    // u16 截断会让 header 声明的 name_length 与实际写出的名字字节不一致（zip 结构
    // 损坏且导出无回读校验拦截）：超限一律 fail closed
    let name_len = u16::try_from(name.len())
        .map_err(|_| ArchiveError::invalid_zip_detail("条目名超过 65535 字节"))?;
    let method = match entry.compression {
        EntryCompression::Store => METHOD_STORE,
        EntryCompression::Deflate => METHOD_DEFLATE,
    };
    let kind = entry.kind;
    if kind.is_dir() && !entry.rel_path.ends_with('/') {
        return Err(ArchiveError::invalid_zip_detail("目录条目名缺少尾部 /"));
    }
    if !kind.is_dir() && entry.rel_path.ends_with('/') {
        return Err(ArchiveError::invalid_zip_detail("文件条目名带尾部 /"));
    }

    let local_header_offset = file.stream_position()?;
    // local header（crc/sizes 占位，条目写完后回 seek 补写）
    let mut header = Vec::with_capacity(30 + name.len());
    header.extend_from_slice(&LOCAL_FILE_SIGNATURE.to_le_bytes());
    header.extend_from_slice(&VERSION.to_le_bytes());
    header.extend_from_slice(&FLAG_UTF8.to_le_bytes());
    header.extend_from_slice(&method.to_le_bytes());
    header.extend_from_slice(&entry.dos_time.to_le_bytes());
    header.extend_from_slice(&entry.dos_date.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes()); // crc32 placeholder
    header.extend_from_slice(&0u32.to_le_bytes()); // compressed size placeholder
    header.extend_from_slice(&0u32.to_le_bytes()); // uncompressed size placeholder
    header.extend_from_slice(&name_len.to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes()); // extra length
    header.extend_from_slice(&name);
    file.write_all(&header)?;

    let (crc32, compressed_size, uncompressed_size) = if kind.is_dir() {
        if entry.content_base64.is_some() {
            return Err(ArchiveError::dir_has_data(&entry.rel_path));
        }
        (0u32, 0u64, 0u64)
    } else {
        write_file_data(file, entry, method)?
    };

    // 回 seek 补写 crc/sizes
    file.seek(SeekFrom::Start(local_header_offset + 14))?;
    file.write_all(&crc32.to_le_bytes())?;
    file.write_all(&u32::try_from(compressed_size).map_err(|_| ArchiveError::zip64())?.to_le_bytes())?;
    file.write_all(&u32::try_from(uncompressed_size).map_err(|_| ArchiveError::zip64())?.to_le_bytes())?;
    file.seek(SeekFrom::Start(local_header_offset + 30 + name.len() as u64 + compressed_size))?;

    let permission_bits = entry.mode & 0o777;
    let directory_flag: u32 = if kind.is_dir() { 0x10 } else { 0 };
    Ok(CentralRecord {
        name,
        method,
        dos_time: entry.dos_time,
        dos_date: entry.dos_date,
        crc32,
        compressed_size,
        uncompressed_size,
        external_attrs: (permission_bits << 16) | directory_flag,
        local_header_offset,
    })
}

fn write_file_data(file: &mut File, entry: &CreateEntry, method: u16) -> ArchiveResult<(u32, u64, u64)> {
    let mut hasher = Hasher::new();
    let data_start = file.stream_position()?;
    let uncompressed_size: u64;

    if let Some(content_base64) = &entry.content_base64 {
        let content = base64_decode(content_base64)?;
        hasher.update(&content);
        uncompressed_size = content.len() as u64;
        match method {
            METHOD_STORE => file.write_all(&content)?,
            _ => {
                let mut encoder = DeflateEncoder::new(&mut *file, Compression::new(6));
                encoder.write_all(&content)?;
                encoder.finish()?;
            }
        }
    } else {
        let mut source = File::open(Path::new(&entry.path))?;
        let mut total: u64 = 0;
        match method {
            METHOD_STORE => {
                let mut buf = [0u8; CHUNK_SIZE];
                loop {
                    let n = source.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buf[..n]);
                    file.write_all(&buf[..n])?;
                    total += n as u64;
                }
            }
            _ => {
                // DeflateEncoder 直接包输出文件：流式压缩、O(1) 内存；
                // finish 后借用归还，继续 tell 位置算 compressed size
                let mut encoder = DeflateEncoder::new(&mut *file, Compression::new(6));
                let mut buf = [0u8; CHUNK_SIZE];
                loop {
                    let n = source.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buf[..n]);
                    encoder.write_all(&buf[..n])?;
                    total += n as u64;
                }
                encoder.finish()?;
            }
        }
        uncompressed_size = total;
    }

    let compressed_size = file.stream_position()? - data_start;
    Ok((hasher.finalize(), compressed_size, uncompressed_size))
}

fn write_central_record(file: &mut File, record: &CentralRecord) -> ArchiveResult<()> {
    let mut out = Vec::with_capacity(46 + record.name.len());
    out.extend_from_slice(&CENTRAL_FILE_SIGNATURE.to_le_bytes());
    out.extend_from_slice(&((3u16 << 8) | VERSION).to_le_bytes()); // version made by: unix
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&FLAG_UTF8.to_le_bytes());
    out.extend_from_slice(&record.method.to_le_bytes());
    out.extend_from_slice(&record.dos_time.to_le_bytes());
    out.extend_from_slice(&record.dos_date.to_le_bytes());
    out.extend_from_slice(&record.crc32.to_le_bytes());
    out.extend_from_slice(&u32::try_from(record.compressed_size).map_err(|_| ArchiveError::zip64())?.to_le_bytes());
    out.extend_from_slice(&u32::try_from(record.uncompressed_size).map_err(|_| ArchiveError::zip64())?.to_le_bytes());
    // name 长度已在 write_entry 处 fail-closed 校验，这里 try_from 双保险
    out.extend_from_slice(
        &u16::try_from(record.name.len())
            .map_err(|_| ArchiveError::invalid_zip_detail("条目名超过 65535 字节"))?
            .to_le_bytes(),
    );
    out.extend_from_slice(&0u16.to_le_bytes()); // extra length
    out.extend_from_slice(&0u16.to_le_bytes()); // comment length
    out.extend_from_slice(&0u16.to_le_bytes()); // disk number start
    out.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
    out.extend_from_slice(&record.external_attrs.to_le_bytes());
    out.extend_from_slice(&u32::try_from(record.local_header_offset).map_err(|_| ArchiveError::zip64())?.to_le_bytes());
    out.extend_from_slice(&record.name);
    file.write_all(&out)?;
    Ok(())
}

// 内联内容（marker）的 base64 解码——不引第三方库，按 RFC 4648 实现。
fn base64_decode(input: &str) -> ArchiveResult<Vec<u8>> {
    fn value_of(byte: u8) -> Option<u32> {
        match byte {
            b'A'..=b'Z' => Some((byte - b'A') as u32),
            b'a'..=b'z' => Some((byte - b'a' + 26) as u32),
            b'0'..=b'9' => Some((byte - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &byte in bytes {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let value = value_of(byte).ok_or_else(|| ArchiveError::new("protocol", "contentBase64 含非法字符"))?;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::base64_decode;

    #[test]
    fn base64_decodes_rfc4648_vectors() {
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
        assert_eq!(base64_decode("Zm9vYg==").unwrap(), b"foob");
        assert_eq!(base64_decode("b25lY2xhdy1vcGVuY2xhdy1zdGF0ZS1hcmNoaXZlL3YxCg==").unwrap(), b"oneclaw-openclaw-state-archive/v1\n");
        assert!(base64_decode("Zm9v!bad").is_err());
    }
}
