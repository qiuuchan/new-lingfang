//! 运行时包管理器镜像源预置清单（pip / npm）。
//!
//! 用途：runtime_resolver 在启动插件子进程时把默认镜像源注入环境变量
//! （`PIP_INDEX_URL` / `NPM_CONFIG_REGISTRY`），让 pip / npm 走国内源加速。
//!
//! 仅注入本应用启动的子进程，不写系统全局配置（pip.ini / .npmrc），避免污染用户其它项目。
//! 运行时来源固定为软件内置资源；镜像只影响插件业务依赖安装。

use serde::{Deserialize, Serialize};

/// 镜像源选择。当前产品使用 Default，保留解析函数供内部测试与未来受控配置使用。
///
/// `*_id` 为预置源 id（见 PIP_PRESETS / NPM_PRESETS）或 `"custom"`；
/// `*_url` 仅在 `*_id == "custom"` 时使用。空 id 在 resolve 时回退到预置默认（清华 / npmmirror）。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MirrorConfig {
    #[serde(default, rename = "pipId", alias = "pipId")]
    pub pip_id: String,
    #[serde(
        default,
        rename = "pipUrl",
        alias = "pipUrl",
        skip_serializing_if = "Option::is_none"
    )]
    pub pip_url: Option<String>,
    #[serde(default, rename = "npmId", alias = "npmId")]
    pub npm_id: String,
    #[serde(
        default,
        rename = "npmUrl",
        alias = "npmUrl",
        skip_serializing_if = "Option::is_none"
    )]
    pub npm_url: Option<String>,
}

impl Default for MirrorConfig {
    fn default() -> Self {
        Self {
            pip_id: PIP_PRESETS[0].0.to_string(),
            pip_url: None,
            npm_id: NPM_PRESETS[0].0.to_string(),
            npm_url: None,
        }
    }
}

/// pip 预置源清单：(id, url)。首项为默认（清华）。
pub const PIP_PRESETS: &[(&str, &str)] = &[
    ("tsinghua", "https://pypi.tuna.tsinghua.edu.cn/simple"),
    ("aliyun", "https://mirrors.aliyun.com/pypi/simple/"),
    ("tencent", "https://mirrors.cloud.tencent.com/pypi/simple"),
    (
        "huawei",
        "https://repo.huaweicloud.com/repository/pypi/simple",
    ),
    ("official", "https://pypi.org/simple"),
];

/// npm 预置源清单：(id, url)。首项为默认（npmmirror）。
pub const NPM_PRESETS: &[(&str, &str)] = &[
    ("npmmirror", "https://registry.npmmirror.com"),
    ("huawei", "https://repo.huaweicloud.com/repository/npm/"),
    ("tencent", "https://mirrors.cloud.tencent.com/npm/"),
    ("official", "https://registry.npmjs.org"),
];

/// 自定义源 id（用户在 UI 填写 URL 时用）。
pub const CUSTOM_ID: &str = "custom";

/// 解析当前生效的 pip 源 URL。
///
/// 规则：`pip_id == "custom"` 且 `pip_url` 非空 → 用自定义 URL；
/// 否则按 `pip_id` 查 PIP_PRESETS；查无回退到预置默认（清华）。
pub fn resolve_pip_url(config: &MirrorConfig) -> String {
    if config.pip_id == CUSTOM_ID {
        if let Some(url) = config
            .pip_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return url.to_string();
        }
    }
    PIP_PRESETS
        .iter()
        .find(|(id, _)| *id == config.pip_id)
        .map(|(_, url)| url.to_string())
        .unwrap_or_else(|| PIP_PRESETS[0].1.to_string())
}

/// 解析当前生效的 npm 源 URL（语义同 resolve_pip_url）。
pub fn resolve_npm_url(config: &MirrorConfig) -> String {
    if config.npm_id == CUSTOM_ID {
        if let Some(url) = config
            .npm_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return url.to_string();
        }
    }
    NPM_PRESETS
        .iter()
        .find(|(id, _)| *id == config.npm_id)
        .map(|(_, url)| url.to_string())
        .unwrap_or_else(|| NPM_PRESETS[0].1.to_string())
}

/// 从 pip 源 URL 提取 host（用于 PIP_TRUSTED_HOST 注入）。
/// 例：`https://pypi.tuna.tsinghua.edu.cn/simple` → `pypi.tuna.tsinghua.edu.cn`。
pub fn extract_host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split('/').next()?;
    let host = host.trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_mirrors_are_tsinghua_and_npmmirror() {
        let m = MirrorConfig::default();
        assert_eq!(
            resolve_pip_url(&m),
            "https://pypi.tuna.tsinghua.edu.cn/simple"
        );
        assert_eq!(resolve_npm_url(&m), "https://registry.npmmirror.com");
    }

    #[test]
    fn custom_pip_url_wins_when_set() {
        let mut m = MirrorConfig::default();
        m.pip_id = "custom".to_string();
        m.pip_url = Some("https://my.corp/pypi".to_string());
        assert_eq!(resolve_pip_url(&m), "https://my.corp/pypi");
    }

    #[test]
    fn custom_pip_url_empty_falls_back_to_default() {
        let mut m = MirrorConfig::default();
        m.pip_id = "custom".to_string();
        m.pip_url = Some("   ".to_string());
        assert_eq!(resolve_pip_url(&m), PIP_PRESETS[0].1);
    }

    #[test]
    fn unknown_id_falls_back_to_default() {
        let mut m = MirrorConfig::default();
        m.npm_id = "ghost".to_string();
        assert_eq!(resolve_npm_url(&m), NPM_PRESETS[0].1);
    }

    #[test]
    fn extract_host_strips_scheme_and_path() {
        assert_eq!(
            extract_host("https://pypi.tuna.tsinghua.edu.cn/simple"),
            Some("pypi.tuna.tsinghua.edu.cn".to_string())
        );
        assert_eq!(
            extract_host("https://registry.npmmirror.com"),
            Some("registry.npmmirror.com".to_string())
        );
        assert_eq!(extract_host("not-a-url"), None);
    }
}
