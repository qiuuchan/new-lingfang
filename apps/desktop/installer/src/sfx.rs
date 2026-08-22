//! 自解压尾部格式（design §2）。
//!
//! 布局：`[ installer.exe 原始 PE 字节 ][ payload.zip ][ 12 字节 trailer ]`
//! trailer = MAGIC(8 bytes) + payload_len(u32 little-endian)。
//!
//! 运行时读自身可执行文件 → 末尾 12 字节解析 trailer → 校验 MAGIC →
//! 用 payload_len 反推 zip 起始偏移 → zip crate 从该偏移解压。
//!
//! 没有 trailer / MAGIC 不匹配 → 裸 installer.exe（updater 副本场景或 dev 直跑），
//! locate_payload 返回 None，install 模式报错、update/uninstall 模式不需要 payload。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{anyhow, Context, Result};

/// 尾部魔数（8 字节，识别本 exe 是否携带 payload）。
pub const MAGIC: [u8; 8] = *b"LFSFX\0\0\0";

/// trailer 总长度：MAGIC(8) + payload_len(u32 = 4) = 12 字节。
pub const TRAILER_LEN: u64 = 12;

/// 解析出的尾部信息。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Trailer {
    /// payload（zip）字节长度。
    pub payload_len: u32,
}

/// 从 trailer 原始字节解析（纯函数，便于单测）。
///
/// `bytes` 必须恰好是末尾 12 字节。MAGIC 不匹配返回 None（裸 exe）。
pub fn parse_trailer(bytes: &[u8]) -> Option<Trailer> {
    if bytes.len() != TRAILER_LEN as usize {
        return None;
    }
    if bytes[0..8] != MAGIC {
        return None;
    }
    let payload_len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    Some(Trailer { payload_len })
}

/// 构造 trailer 原始字节（打包脚本/测试用）。
#[allow(dead_code)]
pub fn build_trailer(payload_len: u32) -> [u8; TRAILER_LEN as usize] {
    let mut out = [0u8; TRAILER_LEN as usize];
    out[0..8].copy_from_slice(&MAGIC);
    out[8..12].copy_from_slice(&payload_len.to_le_bytes());
    out
}

/// 由文件总长度 + trailer 反推 payload（zip）起始偏移（纯函数）。
///
/// 文件布局：`[exe][payload(payload_len)][trailer(12)]`
/// → payload 起点 = file_len - 12 - payload_len。
/// 非法（payload_len 比文件还大）返回 None。
pub fn payload_offset(file_len: u64, trailer: Trailer) -> Option<u64> {
    let payload_len = trailer.payload_len as u64;
    file_len
        .checked_sub(TRAILER_LEN)
        .and_then(|v| v.checked_sub(payload_len))
}

/// 读自身（或指定 exe）尾部 trailer。无 trailer / 文件过短返回 None。
pub fn read_trailer(exe_path: &Path) -> Result<Option<Trailer>> {
    let mut f = File::open(exe_path).with_context(|| format!("打开 {exe_path:?} 失败"))?;
    let len = f.metadata()?.len();
    if len < TRAILER_LEN {
        return Ok(None);
    }
    f.seek(SeekFrom::End(-(TRAILER_LEN as i64)))?;
    let mut buf = [0u8; TRAILER_LEN as usize];
    f.read_exact(&mut buf)?;
    Ok(parse_trailer(&buf))
}

/// 定位 payload 偏移（综合 read_trailer + payload_offset）。无 payload 返回 None。
pub fn locate_payload(exe_path: &Path) -> Result<Option<u64>> {
    let trailer = match read_trailer(exe_path)? {
        Some(t) => t,
        None => return Ok(None),
    };
    let len = File::open(exe_path)?.metadata()?.len();
    payload_offset(len, trailer)
        .map(Some)
        .ok_or_else(|| anyhow!("payload 偏移非法：payload_len 超出文件大小"))
}

/// 从 exe 尾部 payload 解压到目标目录（覆盖已存在文件）。
///
/// 流程：locate_payload → seek 到 payload 起点 → 取该段为 zip 读取 → 逐条解压。
pub fn extract_payload(exe_path: &Path, dest_dir: &Path) -> Result<usize> {
    let offset = locate_payload(exe_path)?
        .ok_or_else(|| anyhow!("本安装包不含内嵌 payload（裸 installer.exe 无法执行安装）"))?;

    let mut f = File::open(exe_path)?;
    let total_len = f.metadata()?.len();
    // payload 段长度 = total - offset - trailer。
    let payload_len = total_len - offset - TRAILER_LEN;
    f.seek(SeekFrom::Start(offset))?;

    // 把 payload 段读进内存（更新场景一次性，简单可靠；超大包可改 take+临时文件）。
    let mut payload = vec![0u8; payload_len as usize];
    f.read_exact(&mut payload)?;

    let reader = std::io::Cursor::new(payload);
    let mut archive = zip::ZipArchive::new(reader).context("payload 不是合法 zip")?;

    std::fs::create_dir_all(dest_dir)?;
    let mut count = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| anyhow!("zip 条目路径非法（疑似路径穿越）：{}", entry.name()))?;
        let out_path = dest_dir.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = File::create(&out_path).with_context(|| format!("写入 {out_path:?} 失败"))?;
        std::io::copy(&mut entry, &mut out)?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailer_roundtrip() {
        let raw = build_trailer(123_456);
        let parsed = parse_trailer(&raw).expect("应解析出 trailer");
        assert_eq!(parsed.payload_len, 123_456);
    }

    #[test]
    fn parse_trailer_rejects_bad_magic() {
        let mut raw = build_trailer(10);
        raw[0] = b'X'; // 破坏 MAGIC
        assert_eq!(parse_trailer(&raw), None);
    }

    #[test]
    fn parse_trailer_rejects_wrong_len() {
        assert_eq!(parse_trailer(&[0u8; 5]), None);
        assert_eq!(parse_trailer(&[0u8; 13]), None);
    }

    #[test]
    fn payload_offset_correct() {
        // 文件 = exe(1000) + payload(200) + trailer(12) = 1212
        let trailer = Trailer { payload_len: 200 };
        assert_eq!(payload_offset(1212, trailer), Some(1000));
    }

    #[test]
    fn payload_offset_rejects_oversized() {
        // payload_len 比文件还大 → None。
        let trailer = Trailer { payload_len: 5000 };
        assert_eq!(payload_offset(100, trailer), None);
    }

    #[test]
    fn payload_offset_exact_boundary() {
        // exe 为 0：文件 = payload(50) + trailer(12) = 62。
        let trailer = Trailer { payload_len: 50 };
        assert_eq!(payload_offset(62, trailer), Some(0));
    }

    /// 端到端：构造 [假exe][真zip][trailer] 文件 → read_trailer + extract_payload → 校验解出的文件。
    #[test]
    fn extract_payload_end_to_end() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        // 1) 用 zip crate 写一个含两文件 + 子目录的内存 zip。
        let mut zip_buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut zip_buf);
            let mut zw = zip::ZipWriter::new(cursor);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zw.start_file("lingfang-desktop.exe", opts).unwrap();
            zw.write_all(b"FAKE-MAIN-EXE").unwrap();
            zw.start_file("runtimes/python/marker.txt", opts).unwrap();
            zw.write_all(b"py-runtime").unwrap();
            zw.finish().unwrap();
        }

        // 2) 拼 [假exe前缀][zip][trailer] 写临时文件。
        let dir = std::env::temp_dir().join("lingfang-sfx-e2e");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fake_exe = dir.join("setup.exe");
        {
            let mut f = File::create(&fake_exe).unwrap();
            f.write_all(b"MZ-FAKE-PE-HEADER-PREFIX").unwrap(); // 假 exe 前缀
            f.write_all(&zip_buf).unwrap();
            f.write_all(&build_trailer(zip_buf.len() as u32)).unwrap();
        }

        // 3) read_trailer 解析正确。
        let trailer = read_trailer(&fake_exe).unwrap().expect("应读到 trailer");
        assert_eq!(trailer.payload_len as usize, zip_buf.len());

        // 4) extract_payload 解出文件。
        let out = dir.join("out");
        let count = extract_payload(&fake_exe, &out).unwrap();
        assert_eq!(count, 2, "应解出 2 个文件");
        assert_eq!(
            std::fs::read_to_string(out.join("lingfang-desktop.exe")).unwrap(),
            "FAKE-MAIN-EXE"
        );
        assert_eq!(
            std::fs::read_to_string(out.join("runtimes/python/marker.txt")).unwrap(),
            "py-runtime"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 裸 exe（无 trailer）→ locate_payload 返回 None。
    #[test]
    fn locate_payload_none_for_bare_exe() {
        use std::io::Write;
        let dir = std::env::temp_dir();
        let bare = dir.join("lingfang-sfx-bare.exe");
        {
            let mut f = File::create(&bare).unwrap();
            f.write_all(b"just an exe, no trailer here at all").unwrap();
        }
        assert_eq!(locate_payload(&bare).unwrap(), None);
        let _ = std::fs::remove_file(&bare);
    }
}
