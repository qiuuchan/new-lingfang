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
//!
//! B3→C（P2）：payload 现内嵌完整 runtimes/（>1.5GB），解压必须流式进行——
//! 通过 SegmentReader 把 [offset, offset+payload_len) 映射为独立 Read+Seek 流，
//! 不再把 payload 整段读进内存。trailer 长度字段仍为 u32（上限 ≈4GiB），
//! 打包脚本负责在越界时拒绝拼接。

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
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

/// 把 exe 内 [base, base+len) 区间映射为独立 Read+Seek 流（B3→C：流式解压）。
///
/// 读写均被钳制在区间内：越界 seek 饱和到边界，read 到达区间末尾返回 Ok(0)。
/// 这样 zip crate 可以直接在「exe 的一个切片」上工作，无需把 >1.5GB payload
/// 整段读进内存（旧实现 `vec![0u8; payload_len]` 在内嵌 runtimes 后必然 OOM）。
struct SegmentReader {
    file: File,
    /// payload 起始的绝对偏移。
    base: u64,
    /// payload 段长度。
    len: u64,
    /// 段内相对游标。
    pos: u64,
}

impl SegmentReader {
    fn new(file: File, base: u64, len: u64) -> Self {
        Self { file, base, len, pos: 0 }
    }
}

impl Read for SegmentReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let remaining = (self.len - self.pos) as usize;
        if remaining == 0 {
            return Ok(0);
        }
        let want = buf.len().min(remaining);
        self.file.seek(SeekFrom::Start(self.base + self.pos))?;
        let n = self.file.read(&mut buf[..want])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for SegmentReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let target = match pos {
            SeekFrom::Start(p) => Some(p),
            SeekFrom::End(delta) => {
                let v = self.len as i64 + delta;
                (v >= 0).then(|| v as u64)
            }
            SeekFrom::Current(delta) => {
                let v = self.pos as i64 + delta;
                (v >= 0).then(|| v as u64)
            }
        };
        let target = target.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek 到 payload 段起点之前",
            )
        })?;
        self.pos = target.min(self.len);
        Ok(self.pos)
    }
}

/// 从 exe 尾部 payload 解压到目标目录（覆盖已存在文件）。
///
/// 流程：locate_payload → 定位 payload 起点 → SegmentReader 提供该段流式视图 →
/// zip crate 从该视图逐条解压（不整段驻留内存，支持 >1.5GB 的 runtimes payload）。
pub fn extract_payload(exe_path: &Path, dest_dir: &Path) -> Result<usize> {
    let offset = locate_payload(exe_path)?
        .ok_or_else(|| anyhow!("本安装包不含内嵌 payload（裸 installer.exe 无法执行安装）"))?;

    let f = File::open(exe_path)?;
    let total_len = f.metadata()?.len();
    // payload 段长度 = total - offset - trailer。
    let payload_len = total_len - offset - TRAILER_LEN;

    let reader = SegmentReader::new(f, offset, payload_len);
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
            zw.start_file("qianxia-desktop.exe", opts).unwrap();
            zw.write_all(b"FAKE-MAIN-EXE").unwrap();
            zw.start_file("runtimes/python/marker.txt", opts).unwrap();
            zw.write_all(b"py-runtime").unwrap();
            zw.finish().unwrap();
        }

        // 2) 拼 [假exe前缀][zip][trailer] 写临时文件。
        let dir = std::env::temp_dir().join("qianxia-sfx-e2e");
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
            std::fs::read_to_string(out.join("qianxia-desktop.exe")).unwrap(),
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
        let bare = dir.join("qianxia-sfx-bare.exe");
        {
            let mut f = File::create(&bare).unwrap();
            f.write_all(b"just an exe, no trailer here at all").unwrap();
        }
        assert_eq!(locate_payload(&bare).unwrap(), None);
        let _ = std::fs::remove_file(&bare);
    }

    // ── SegmentReader（B3→C：payload 流式视图）───────────────────────────

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        use std::io::Write;
        let path = std::env::temp_dir().join(name);
        let mut f = File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path
    }

    /// 只暴露 [base, base+len) 区间；区间外字节（前缀/尾部）不可见，读尽返回 0。
    #[test]
    fn segment_reader_bounded_to_range() {
        use std::io::Write;
        // 布局：前缀(6) + payload(b"PAYLOAD") + 尾部(4)。
        let mut raw = Vec::new();
        raw.extend_from_slice(b"PREFIX");
        raw.extend_from_slice(b"PAYLOAD");
        raw.extend_from_slice(b"TAIL");
        let path = temp_file("qianxia-sfx-segment.bin", &raw);

        let f = File::open(&path).unwrap();
        let mut seg = SegmentReader::new(f, 6, 7);

        let mut buf = vec![0u8; 16];
        let n1 = seg.read(&mut buf).unwrap();
        assert_eq!(&buf[..n1], b"PAYLOAD", "应恰好读出段内容且不含前后缀");
        assert_eq!(seg.read(&mut buf).unwrap(), 0, "段读尽后返回 Ok(0)");
        let _ = std::fs::remove_file(&path);
    }

    /// 越界 seek 饱和到边界；负向越界报 InvalidInput。
    #[test]
    fn segment_reader_seek_clamps_and_rejects() {
        use std::io::{Seek, SeekFrom};
        let path = temp_file("qianxia-sfx-seek.bin", b"0123456789");
        let f = File::open(&path).unwrap();
        let mut seg = SegmentReader::new(f, 2, 5); // 可见区间 b"23456"

        assert_eq!(seg.seek(SeekFrom::Start(100)).unwrap(), 5, "Start 越界饱和到段尾");
        assert_eq!(seg.seek(SeekFrom::End(-2)).unwrap(), 3);
        assert_eq!(seg.seek(SeekFrom::Current(-3)).unwrap(), 0);
        assert!(seg.seek(SeekFrom::Current(-1)).is_err(), "seek 到段起点之前应报错");
        assert_eq!(seg.seek(SeekFrom::End(-100)).is_err(), true);
        let _ = std::fs::remove_file(&path);
    }

    /// 端到端（大偏移）：真实 exe 前缀 + payload + trailer 的布局下，
    /// SegmentReader 视图与 Cursor 全量读取结果一致（回归旧实现的语义）。
    #[test]
    fn segment_reader_matches_full_read() {
        use std::io::Write;
        let mut raw = Vec::new();
        raw.extend_from_slice(b"MZ-FAKE-PE-HEADER-PREFIX"); // exe 前缀
        raw.extend_from_slice(b"\x50\x4b\x03\x04zip-bytes-here"); // zip 首部特征
        raw.extend_from_slice(&[0u8; 64]);
        let path = temp_file("qianxia-sfx-compare.bin", &raw);
        let base = 25u64; // 前缀长度
        let len = raw.len() as u64 - base;

        let expected = raw[base as usize..].to_vec();

        let f = File::open(&path).unwrap();
        let mut seg = SegmentReader::new(f, base, len);
        let mut got = Vec::new();
        seg.read_to_end(&mut got).unwrap();
        assert_eq!(got, expected);
        let _ = std::fs::remove_file(&path);
    }
}
