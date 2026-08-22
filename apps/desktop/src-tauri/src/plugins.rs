//! 内置插件加载器：从本机安装账本选出的 release 目录解析 manifest 并注册能力。

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::capability::{expand_path, CapabilityRegistry, DeclaredCapability};

#[derive(Clone, Debug, Serialize)]
pub struct LoadedPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub entry: String,
    pub runtime_type: String,
    pub capabilities: Vec<DeclaredCapability>,
    /// 插件资源目录的绝对路径（用于壳加载 entry HTML）。
    pub dir: String,
    pub builtin: bool,
}

/// 解析单个插件目录的 manifest.json。
fn parse_manifest(dir: &Path) -> Option<(LoadedPlugin, Vec<DeclaredCapability>)> {
    let manifest_path = dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;

    let id = v.get("id")?.as_str()?.to_string();
    let name = v.get("name")?.as_str()?.to_string();
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let description = v
        .get("description")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let entry = v
        .get("entry")
        .and_then(|x| x.as_str())
        .unwrap_or("index.html")
        .to_string();
    let runtime_type = v
        .get("runtime_type")
        .and_then(|x| x.as_str())
        .unwrap_or("client")
        .to_string();

    // 解析 capabilities，并展开 fs.* 的路径模板。
    let mut caps = Vec::new();
    if let Some(arr) = v.get("capabilities").and_then(|x| x.as_array()) {
        for c in arr {
            let kind = match c.get("kind").and_then(|x| x.as_str()) {
                Some(k) => k.to_string(),
                None => continue,
            };
            let paths = c
                .get("paths")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|p| p.as_str())
                        .map(expand_path)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            caps.push(DeclaredCapability { kind, paths });
        }
    }

    let plugin = LoadedPlugin {
        id,
        name,
        version,
        description,
        entry,
        runtime_type,
        capabilities: caps.clone(),
        dir: dir.to_string_lossy().to_string(),
        builtin: true,
    };
    Some((plugin, caps))
}

/// 从安装账本给出的不可变 release 目录加载内置插件。
pub fn load_builtin_plugins_from_dirs(
    mut release_dirs: Vec<PathBuf>,
    registry: &CapabilityRegistry,
) -> Vec<LoadedPlugin> {
    let mut result = Vec::new();
    release_dirs.sort();
    for path in release_dirs {
        match parse_manifest(&path) {
            Some((plugin, caps)) => {
                registry.register(&plugin.id, caps);
                result.push(plugin);
            }
            None => {
                eprintln!(
                    "已安装内置插件加载失败（manifest 解析失败，目录 {:?}）",
                    path.to_string_lossy()
                );
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_manifest_exports_runtime_type() {
        let dir = std::env::temp_dir().join(format!(
            "lf-builtin-plugin-runtime-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            r#"{"id":"builtin.test","name":"Test","entry":"main.py","runtime_type":"python"}"#,
        )
        .unwrap();

        let (plugin, _) = parse_manifest(&dir).expect("manifest should parse");

        assert_eq!(plugin.runtime_type, "python");
        assert_eq!(plugin.entry, "main.py");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
