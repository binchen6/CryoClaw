// errors.rs — 结构化错误：code 供 JS 集成层识别，message 与 JS 实现逐条对齐。
// JS 侧对 ok:false 一律回退纯 JS backend 重跑，由 JS 产生权威文案；这里的
// message 对齐是为构建期日志与 Rust 自测的可读性，不进入用户可见路径。

use std::fmt;
use std::io;

#[derive(Debug)]
pub struct ArchiveError {
    pub code: &'static str,
    pub message: String,
}

impl ArchiveError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        ArchiveError { code, message: message.into() }
    }

    // 以下 message 逐字对齐 src/openclaw-state-archive-zip.ts
    pub fn invalid_zip() -> Self {
        ArchiveError::new("invalid-zip", "不是有效的 ZIP 数据包")
    }

    pub fn invalid_zip_detail(detail: &str) -> Self {
        ArchiveError::new("invalid-zip", format!("不是有效的 ZIP 数据包: {detail}"))
    }

    pub fn multidisk() -> Self {
        ArchiveError::new("multidisk-unsupported", "ZIP 分卷数据包不受支持")
    }

    pub fn zip64() -> Self {
        ArchiveError::new("zip64-unsupported", "ZIP64 数据包不受支持")
    }

    pub fn encrypted() -> Self {
        ArchiveError::new("encrypted-unsupported", "ZIP 加密数据包不受支持")
    }

    pub fn name_encoding() -> Self {
        ArchiveError::new("name-encoding-unsupported", "ZIP 文件名编码不受支持")
    }

    pub fn crc_mismatch(name: &str) -> Self {
        ArchiveError::new("crc-mismatch", format!("ZIP CRC 校验失败: {name}"))
    }

    pub fn size_mismatch(name: &str) -> Self {
        ArchiveError::new("size-mismatch", format!("ZIP entry 长度校验失败: {name}"))
    }

    pub fn entry_too_large(name: &str) -> Self {
        ArchiveError::new("entry-too-large", format!("ZIP entry 过大: {name}"))
    }

    pub fn dir_has_data(name: &str) -> Self {
        ArchiveError::new("dir-has-data", format!("目录 entry 不能包含数据: {name}"))
    }

    pub fn containment(path: &str) -> Self {
        ArchiveError::new("containment-violation", format!("非法越界路径: {path}"))
    }
}

impl fmt::Display for ArchiveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ArchiveError {}

impl From<io::Error> for ArchiveError {
    fn from(err: io::Error) -> Self {
        // JS 侧 normalizeZipError 对非受控错误统一包一层；这里保持裸 IO 文案即可，
        // 用户可见错误最终由 JS backend 重跑产生。
        ArchiveError::new("io", err.to_string())
    }
}

pub type ArchiveResult<T> = Result<T, ArchiveError>;
