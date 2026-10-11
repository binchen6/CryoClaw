// main.rs — argv 子命令分发 + JSON Lines 协议入口。
//   cryoclaw-archive --version
//   cryoclaw-archive create|manifest|extract   （command JSON 从 stdin 单行读入）

mod errors;
mod extract;
mod protocol;
mod zip_reader;
mod zip_writer;

use std::io::{self, BufReader, BufWriter};
use std::process::ExitCode;

use protocol::Command;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--version") | Some("-V") | Some("--help") | Some("-h") => {
            // JS 侧握手只解析 "cryoclaw-archive <semver>" 第一行
            println!("cryoclaw-archive {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Some("create") | Some("manifest") | Some("extract") => run_command(args[1].as_str()),
        _ => {
            eprintln!("用法: cryoclaw-archive [--version] <create|manifest|extract>（JSON command 走 stdin）");
            ExitCode::FAILURE
        }
    }
}

fn run_command(subcommand: &str) -> ExitCode {
    let stdin = io::stdin();
    let reader = BufReader::new(stdin.lock());
    let command = match protocol::read_command(reader) {
        Ok(command) => command,
        Err(err) => return emit_failure(&err),
    };

    // 子命令与 stdin command 必须一致（防止 JS 侧串线）
    let mismatched = match (&command, subcommand) {
        (Command::Create(_), "create") | (Command::Manifest(_), "manifest") | (Command::Extract(_), "extract") => false,
        _ => true,
    };
    if mismatched {
        let err = errors::ArchiveError::new("protocol", format!("argv 子命令 {subcommand} 与 stdin command 不一致"));
        return emit_failure(&err);
    }

    match command {
        Command::Create(cmd) => match zip_writer::create(&cmd) {
            Ok(_bytes_written) => emit_success(None, None, None),
            Err(err) => emit_failure(&err),
        },
        Command::Manifest(cmd) => match zip_reader::parse(&cmd.zip) {
            Ok(parsed) => emit_success(Some(zip_reader::to_manifest(&parsed.entries)), None, None),
            Err(err) => emit_failure(&err),
        },
        Command::Extract(cmd) => match extract::run(&cmd) {
            Ok((entry_names, capture)) => emit_success(None, Some(entry_names), Some(capture)),
            Err(err) => emit_failure(&err),
        },
    }
}

fn emit_success(
    entries: Option<Vec<protocol::ManifestEntry>>,
    entry_names: Option<Vec<String>>,
    capture: Option<Vec<protocol::CapturedEntry>>,
) -> ExitCode {
    let mut sink = BufWriter::new(io::stdout().lock());
    let line = serde_json::to_string(&protocol::Event::Result { ok: true, entries, entry_names, capture, error: None });
    match write_result_line(&mut sink, line) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("结果写出失败: {err}");
            ExitCode::FAILURE
        }
    }
}

fn emit_failure(err: &errors::ArchiveError) -> ExitCode {
    let mut sink = BufWriter::new(io::stdout().lock());
    let line = serde_json::to_string(&protocol::Event::Result {
        ok: false,
        entries: None,
        entry_names: None,
        capture: None,
        error: Some(err.into()),
    });
    if let Err(write_err) = write_result_line(&mut sink, line) {
        eprintln!("结果写出失败: {write_err}");
    }
    ExitCode::FAILURE
}

fn write_result_line(sink: &mut BufWriter<io::StdoutLock<'_>>, line: serde_json::Result<String>) -> errors::ArchiveResult<()> {
    use std::io::Write;
    let line = line.map_err(|err| errors::ArchiveError::new("protocol", err.to_string()))?;
    writeln!(sink, "{line}").and_then(|()| sink.flush()).map_err(errors::ArchiveError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Compression, CreateCommand, CreateEntry, EntryKind, ExtractCommand, ExtractEntry};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("cryoclaw-archive-it-{tag}-{}-{nanos}", std::process::id()))
    }

    fn dos_2026() -> (u16, u16) {
        // 2026-10-08 12:00:00 墙钟（测试只做往返一致性，不涉及时区断言）
        let date = ((2026u16 - 1980) << 9) | (10 << 5) | 8;
        let time = 12u16 << 11;
        (date, time)
    }

    fn build_extract_command(zip: &str, output_dir: Option<String>, entries: Vec<ExtractEntry>) -> ExtractCommand {
        ExtractCommand { zip: zip.to_string(), output_dir, entries, capture: Vec::new(), utc_offset_minutes: 0 }
    }

    fn whitelist_of(parsed: &zip_reader::ParsedArchive) -> Vec<ExtractEntry> {
        parsed
            .entries
            .iter()
            .map(|entry| {
                let mut segments: Vec<String> = entry.name.split('/').map(|s| s.to_string()).collect();
                if segments.last().is_some_and(|s| s.is_empty()) {
                    segments.pop();
                }
                ExtractEntry { name: entry.name.clone(), kind: entry.kind, segments }
            })
            .collect()
    }

    #[test]
    fn create_manifest_extract_roundtrip() {
        let root = unique_tmp_dir("roundtrip");
        let source = root.join("source");
        let restored = root.join("restored");
        let zip_path = root.join("out.zip");
        fs::create_dir_all(source.join("nested/dir")).unwrap();
        fs::create_dir_all(&restored).unwrap();
        fs::write(source.join("hello.txt"), b"hello world").unwrap();
        fs::write(source.join("nested/dir/数据.bin"), vec![0xabu8; 100_000]).unwrap();

        let (dos_date, dos_time) = dos_2026();
        let create = CreateCommand {
            output: zip_path.to_string_lossy().into_owned(),
            entries: vec![
                CreateEntry {
                    path: String::new(),
                    rel_path: ".oneclaw-openclaw-state-archive".to_string(),
                    kind: EntryKind::File,
                    mode: 0o644,
                    dos_date: 0x21,
                    dos_time: 0,
                    compression: Compression::Store,
                    content_base64: Some("b25lY2xhdy1vcGVuY2xhdy1zdGF0ZS1hcmNoaXZlL3YxCg==".to_string()),
                },
                CreateEntry {
                    path: source.join("nested").to_string_lossy().into_owned(),
                    rel_path: "nested/".to_string(),
                    kind: EntryKind::Dir,
                    mode: 0o755,
                    dos_date,
                    dos_time,
                    compression: Compression::Store,
                    content_base64: None,
                },
                CreateEntry {
                    path: source.join("nested/dir").to_string_lossy().into_owned(),
                    rel_path: "nested/dir/".to_string(),
                    kind: EntryKind::Dir,
                    mode: 0o755,
                    dos_date,
                    dos_time,
                    compression: Compression::Store,
                    content_base64: None,
                },
                CreateEntry {
                    path: source.join("hello.txt").to_string_lossy().into_owned(),
                    rel_path: "hello.txt".to_string(),
                    kind: EntryKind::File,
                    mode: 0o644,
                    dos_date,
                    dos_time,
                    compression: Compression::Deflate,
                    content_base64: None,
                },
                CreateEntry {
                    path: source.join("nested/dir/数据.bin").to_string_lossy().into_owned(),
                    rel_path: "nested/dir/数据.bin".to_string(),
                    kind: EntryKind::File,
                    mode: 0o644,
                    dos_date,
                    dos_time,
                    compression: Compression::Deflate,
                    content_base64: None,
                },
            ],
        };
        zip_writer::create(&create).unwrap();

        // manifest：条目名/数量可解析，central 顺序与写入一致
        let parsed = zip_reader::parse(&zip_path.to_string_lossy()).unwrap();
        let names: Vec<&str> = parsed.entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(
            names,
            vec![".oneclaw-openclaw-state-archive", "nested/", "nested/dir/", "hello.txt", "nested/dir/数据.bin"]
        );
        let manifest = zip_reader::to_manifest(&parsed.entries);
        assert_eq!(manifest[3].crc32, 0x0d4a1185); // "hello world"
        assert_eq!(manifest[3].uncompressed_size, 11);

        // extract：validate 形态（无 outputDir）+ capture marker
        let zip_str = zip_path.to_string_lossy().into_owned();
        let mut validate_cmd = build_extract_command(&zip_str, None, whitelist_of(&parsed));
        validate_cmd.capture = vec![".oneclaw-openclaw-state-archive".to_string()];
        let (entry_names, captured) = extract::run(&validate_cmd).unwrap();
        assert_eq!(entry_names.len(), 5);
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].content_base64, "b25lY2xhdy1vcGVuY2xhdy1zdGF0ZS1hcmNoaXZlL3YxCg==");

        // extract：写盘形态，内容字节往返一致
        let write_cmd = build_extract_command(&zip_str, Some(restored.to_string_lossy().into_owned()), whitelist_of(&parsed));
        extract::run(&write_cmd).unwrap();
        assert_eq!(fs::read(restored.join("hello.txt")).unwrap(), b"hello world");
        assert_eq!(fs::read(restored.join("nested/dir/数据.bin")).unwrap(), vec![0xabu8; 100_000]);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn corrupt_crc_is_rejected() {
        let root = unique_tmp_dir("corrupt");
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("payload.bin"), vec![1u8; 4096]).unwrap();
        let zip_path = root.join("out.zip");
        // Store 条目：翻转任一数据字节必然导致 CRC 不匹配（deflate 流翻转
        // 可能先触发 inflate 错误，Store 保证走到 CRC 校验）
        let create = CreateCommand {
            output: zip_path.to_string_lossy().into_owned(),
            entries: vec![CreateEntry {
                path: source.join("payload.bin").to_string_lossy().into_owned(),
                rel_path: "payload.bin".to_string(),
                kind: EntryKind::File,
                mode: 0o644,
                dos_date: 0x21,
                dos_time: 0,
                compression: Compression::Store,
                content_base64: None,
            }],
        };
        zip_writer::create(&create).unwrap();

        let zip_str = zip_path.to_string_lossy().into_owned();
        let data_start = zip_reader::parse(&zip_str).unwrap().entries[0].data_start;
        let mut bytes = fs::read(&zip_path).unwrap();
        bytes[(data_start + 100) as usize] ^= 0xff;
        fs::write(&zip_path, &bytes).unwrap();

        let extract_cmd = build_extract_command(
            &zip_str,
            None,
            vec![ExtractEntry {
                name: "payload.bin".to_string(),
                kind: EntryKind::File,
                segments: vec!["payload.bin".to_string()],
            }],
        );
        let err = extract::run(&extract_cmd).err().unwrap();
        assert_eq!(err.code, "crc-mismatch");
        assert_eq!(err.message, "ZIP CRC 校验失败: payload.bin");

        fs::remove_dir_all(&root).unwrap();
    }
}
