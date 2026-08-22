//! SHA-256 完整性校验（PRD R1）。
//!
//! 自制更新器下载安装包后，用本模块流式算 SHA-256，与后端 `/api/releases/latest`
//! 返回的 asset.sha256 比对。一致才安装，不一致拒绝（防下载途中损坏/篡改）。
//!
//! 注：主程序（src-tauri/update.rs）也独立做一份下载校验；本模块供 updater 在运行 setup
//! 前做防御性二次校验，及作为打包脚本生成 sha256 的参考实现。允许暂未被全部调用。
#![allow(dead_code)]

use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

/// 流式计算文件 SHA-256，返回小写十六进制字符串。
///
/// 流式读取（64 KiB 缓冲），避免把上百 MB 安装包一次性读进内存。
pub fn sha256_hex(path: &Path) -> Result<String> {
    let mut f = File::open(path).with_context(|| format!("打开 {path:?} 计算 SHA-256 失败"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

/// 校验文件 SHA-256 是否匹配期望值（大小写不敏感）。
///
/// `expected` 为后端返回的十六进制摘要。空字符串视为「未登记哈希」→ 返回 false（拒绝安装）。
pub fn verify_sha256(path: &Path, expected: &str) -> Result<bool> {
    if expected.trim().is_empty() {
        return Ok(false);
    }
    let actual = sha256_hex(path)?;
    Ok(actual.eq_ignore_ascii_case(expected.trim()))
}

/// 字节切片转小写十六进制（不引第三方 hex crate，纯逻辑便于单测）。
fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn hex_encode_correct() {
        assert_eq!(hex_encode(&[0x00, 0xff, 0x1a]), "00ff1a");
    }

    /// 写临时文件算 SHA-256，与已知值（echo -n "abc" | sha256sum）比对。
    #[test]
    fn sha256_of_known_content() {
        // "abc" 的 SHA-256 是固定已知值。
        let dir = std::env::temp_dir();
        let path = dir.join("lingfang-installer-test-abc.bin");
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(b"abc").unwrap();
        }
        let hex = sha256_hex(&path).unwrap();
        assert_eq!(
            hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn verify_matches_and_rejects() {
        let dir = std::env::temp_dir();
        let path = dir.join("lingfang-installer-test-verify.bin");
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(b"abc").unwrap();
        }
        let good = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        // 大写也应匹配（大小写不敏感）。
        assert!(verify_sha256(&path, good).unwrap());
        assert!(verify_sha256(&path, &good.to_uppercase()).unwrap());
        // 错误哈希拒绝。
        assert!(!verify_sha256(&path, "deadbeef").unwrap());
        // 空哈希拒绝（未登记）。
        assert!(!verify_sha256(&path, "").unwrap());
        let _ = std::fs::remove_file(&path);
    }
}
