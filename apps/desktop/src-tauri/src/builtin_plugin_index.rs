use std::collections::HashSet;

use serde::{Deserialize, Serialize};

pub(crate) const INDEX_FORMAT: &str = "qianxia-builtin-plugin-index";
pub(crate) const INDEX_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BuiltinArtifactIndex {
    pub(crate) format: String,
    pub(crate) format_version: u32,
    pub(crate) artifacts: Vec<BuiltinArtifactIndexEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BuiltinArtifactIndexEntry {
    pub(crate) package_id: String,
    pub(crate) release_id: String,
    pub(crate) manifest_id: String,
    pub(crate) version: String,
    pub(crate) artifact_file: String,
    pub(crate) sha256: String,
    pub(crate) size_bytes: u64,
}

pub(crate) fn parse_builtin_index(json: &str) -> Result<BuiltinArtifactIndex, String> {
    let index: BuiltinArtifactIndex =
        serde_json::from_str(json).map_err(|error| format!("内置插件索引格式错误：{error}"))?;
    if index.format != INDEX_FORMAT || index.format_version != INDEX_VERSION {
        return Err("内置插件索引版本不受支持".to_string());
    }
    if index.artifacts.is_empty() {
        return Err("内置插件索引不能为空".to_string());
    }

    let mut manifest_ids = HashSet::new();
    let mut release_ids = HashSet::new();
    let mut artifact_files = HashSet::new();
    let mut previous_manifest_id: Option<&str> = None;
    for artifact in &index.artifacts {
        let manifest_id = artifact.manifest_id.trim();
        if manifest_id.is_empty() || manifest_id != artifact.manifest_id {
            return Err("内置插件 manifestId 不能为空或包含首尾空白".to_string());
        }
        if previous_manifest_id.is_some_and(|previous| previous >= manifest_id) {
            return Err("内置插件索引必须按 manifestId 严格排序".to_string());
        }
        previous_manifest_id = Some(manifest_id);
        if !manifest_ids.insert(manifest_id) {
            return Err(format!("内置插件索引包含重复 manifestId：{manifest_id}"));
        }
        semver::Version::parse(&artifact.version)
            .map_err(|_| format!("内置插件版本不是严格 SemVer：{}", artifact.version))?;
        if artifact.package_id != format!("builtin:{manifest_id}") {
            return Err(format!(
                "内置插件 packageId 与 manifestId 不匹配：{manifest_id}"
            ));
        }
        if artifact.release_id != format!("builtin-{}", artifact.sha256) {
            return Err(format!("内置插件 releaseId 与制品不匹配：{manifest_id}"));
        }
        if !release_ids.insert(artifact.release_id.as_str()) {
            return Err(format!(
                "内置插件索引包含重复 releaseId：{}",
                artifact.release_id
            ));
        }
        if artifact.sha256.len() != 64
            || !artifact
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(format!("内置插件 SHA-256 格式错误：{manifest_id}"));
        }
        if artifact.artifact_file != format!("{}.qplugin", artifact.sha256)
            || artifact.artifact_file.contains(['/', '\\'])
        {
            return Err(format!("内置插件制品文件名非法：{manifest_id}"));
        }
        if !artifact_files.insert(artifact.artifact_file.as_str()) {
            return Err(format!(
                "内置插件索引包含重复制品：{}",
                artifact.artifact_file
            ));
        }
        if artifact.size_bytes == 0 {
            return Err(format!("内置插件制品大小非法：{manifest_id}"));
        }
    }
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_index() -> String {
        let sha = "a".repeat(64);
        format!(
            r#"{{"format":"qianxia-builtin-plugin-index","formatVersion":1,"artifacts":[{{"packageId":"builtin:builtin.demo","releaseId":"builtin-{sha}","manifestId":"builtin.demo","version":"1.0.0","artifactFile":"{sha}.qplugin","sha256":"{sha}","sizeBytes":42}}]}}"#
        )
    }

    #[test]
    fn parses_valid_sha_index() {
        let parsed = parse_builtin_index(&valid_index()).unwrap();
        assert_eq!(parsed.artifacts[0].manifest_id, "builtin.demo");
    }

    #[test]
    fn rejects_artifact_path_and_checksum_mismatch() {
        let invalid = valid_index().replace(
            &format!("{}.qplugin", "a".repeat(64)),
            "../builtin.demo.qplugin",
        );
        assert!(parse_builtin_index(&invalid).is_err());

        let invalid = valid_index().replace(&"a".repeat(64), &"A".repeat(64));
        assert!(parse_builtin_index(&invalid).is_err());
    }
}
