//! 插件持久化目录管理（task 06-16-plugin-system-rebuild 组A）。
//!
//! 新架构下插件文件不再写入临时 sandbox，而是持久化在可配置的插件根目录下：
//! `<plugins_root>/<plugin_id>/`，每个插件独立文件夹，重启软件后仍在。
//!
//! 本模块职责（组A 范围）：
//! - `PluginStore`：插件根目录配置读写（app_data/plugins/.lingfang/config.json，原子写）+ 目录定位。
//! - `get_plugins_root` / `set_plugins_root` / `read_local_plugin_file` 命令。
//! - `scan_plugin_status` 命令：扫描 plugins_root 下全部子目录，解析 manifest.json 判定
//!   动态状态（ready/incomplete/error），并合并组B 的 PluginProcessTable 判定 running/stopped 态。
//!   状态不落 DB，每次实时扫描文件系统 + 查询内存进程表（PRD 需求 2 / AC2）。
//!
//! 与组B（plugin_runner.rs）的协作（跨组集成）：
//! - 组B 的 PluginProcessTable 是内存态进程表（plugin_id → Child 句柄），start_plugin/stop_plugin 维护。
//! - 组A 的 scan_plugin_status 查询该内存表判定 running（不存 DB，重启后从文件系统重判 ready）。
//! - 组B 的 start_plugin 复用组A 的 PluginStore.plugins_root() 解析插件目录（组B 注释明确邀请替换其占位实现）。
//!
//! 目录布局（PRD 需求 6）：
//! ```text
//! app_data/plugins/                      ← plugins_root（默认；设置页可配置）
//! ├── .lingfang/                         ← PluginStore 配置（隐藏，扫描跳过）
//! │   └── config.json                    ← pluginsRootPath 用户自定义路径
//! ├── <plugin_id>/                       ← 各插件独立文件夹
//! │   ├── manifest.json
//! │   ├── main.py / index.js / ui/index.html
//! │   ├── .venv/                         ← Python venv（组B 创建）
//! │   ├── data/                          ← 运行数据持久化（PRD 需求 4）
//! │   └── node_modules/                  ← Node 依赖（组B pnpm install）
//! └── ...
//! ```
//!
//! 安全：plugin_id 走段级白名单（[A-Za-z0-9_-]，与 plugin_script/plugin_runner 同款），
//! canonicalize 前缀断言防路径穿越，扫描跳过隐藏目录（.lingfang 等）与非白名单目录名。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// 容忍 std::sync::Mutex poison（与 code_assistant::lock_or_recover 同款策略）：
// poison 后 unwrap 二次 panic 会令整个插件目录子系统永久不可用。into_inner 拿到的数据仍有效。
fn lock_or_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// 隐藏的 PluginStore 元数据子目录名（相对 plugins_root）。
///
/// 存放 config.json（用户自定义路径）+ runtime/（预留）。以 `.` 开头确保 scan 时被
/// sanitize_plugin_id 拒绝（隐藏段）从而跳过，不误判为插件目录。
const META_DIR: &str = ".lingfang";

/// 插件根目录配置（plugins_root 路径，None = 用默认 app_data/plugins/）。
///
/// 落盘到 plugins_root/.lingfang/config.json。default 保证旧配置缺失时不报错。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct PluginStoreConfig {
    /// 用户自定义的插件根目录绝对路径。None 表示使用默认 app_data/plugins/（首次启动）。
    /// trim 后空串视同 None（防止脏值）。
    #[serde(default, alias = "pluginsRootPath", rename = "pluginsRootPath")]
    pub plugins_root_path: Option<String>,

    /// 用户配置的 relay api_base（平台模型服务地址）。None 表示未配置。
    /// 仅供宿主侧读取并注入 BridgeSession，iframe 客户端插件永不持有此凭证。
    #[serde(default)]
    pub relay_api_base: Option<String>,

    /// 用户配置的 relay auth_token（Bearer 凭证）。None 表示未配置。
    #[serde(default)]
    pub relay_auth_token: Option<String>,
}

/// relay 设置（前端读取/写入，与 PluginStoreConfig 的 relay_* 字段对应）。
///
/// 全部 Option：未配置时为 None，前端据此提示「请先在设置中配置」。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct RelaySettings {
    #[serde(default)]
    pub api_base: Option<String>,
    #[serde(default)]
    pub auth_token: Option<String>,
}

/// 插件动态状态（PRD 需求 2 / AC2）。
///
/// serde lowercase 对齐前端 PluginStatus 联合类型字面量（ready/incomplete/error/running/stopped）。
/// - ready/incomplete/error：由文件系统扫描判定（manifest + 入口文件）。
/// - running/stopped：由组B PluginProcessTable 内存进程表判定。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginStatus {
    /// 有完整入口文件 + manifest（可运行/可打开）。
    Ready,
    /// 缺入口文件或 manifest（AI 生成中断或部分产出）。
    #[default]
    Incomplete,
    /// manifest 解析失败（JSON 非法 / 缺 id|name）。
    Error,
    /// 插件正作为独立进程运行（仅 Python/Node；HTML 无进程概念，永不为此态）。
    Running,
    /// 插件进程已停止（仅 Python/Node 历史；重启软件后从 ready 起算）。
    Stopped,
}

/// 插件运行时类型（与契约 RuntimeType 子集对齐：客户端 HTML / Node.js / Python）。
///
/// serde lowercase 对齐前端 PluginRuntime。未知/缺失值兜底为 client（HTML iframe）。
/// cloud 不在桌面本地运行范围，扫描时归一为 client（前端不会对本地 cloud 插件展示运行按钮）。
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginRuntime {
    #[default]
    Client,
    Nodejs,
    Python,
}

/// 单个插件的状态扫描结果（scan_plugin_status 返回项，snake_case 对齐前端 LocalPluginStatus）。
///
/// id = 插件目录名（持久化 plugin_id），name = 用户命名（manifest.title，缺失回退 manifest.name，再缺失回退 id）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PluginMeta {
    /// 插件目录名（plugin_id，与持久化目录 plugins_root/<id>/ 对应）。
    pub id: String,
    /// 插件展示名（用户命名，来源 manifest.title，缺失回退 manifest.name，再缺失回退 id）。
    pub name: String,
    /// 动态状态（文件系统扫描 + 组B 进程表合并判定，见 PluginStatus）。
    pub status: PluginStatus,
    /// 运行时类型（从 manifest.runtime_type 解析，缺失/未知视为 client）。
    pub runtime: PluginRuntime,
    /// manifest 的 entry 字段（client=ui/index.html / nodejs=index.js / python=main.py）。
    pub entry: String,
    /// 插件描述（manifest.description，缺失为空串）。
    pub description: String,
    /// 插件版本（manifest.version，缺失为 '0.0.0'）。
    pub version: String,
    /// 插件图标（manifest.icon，缺失为 None；前端 PluginIcon 回退默认 🧩）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// 运行进程 pid（仅 status==='running' 时有意义；其余为 None）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// 启动时间 ISO 字符串（仅 running/stopped 态有值）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// 状态诊断说明（缺文件/解析失败的具体原因，便于 UI 展示 incomplete/error 的修复引导）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 是否为未发布草稿（manifest.draft===true）。AI 创建器统一写入 plugins_root，
    /// 用 draft 标记区分"未发布草稿"与"已安装的团队/市场插件"，替代旧的 plugins-draft 双轨目录。
    pub draft: bool,
}

/// 插件目录存储：负责配置读写 + 目录定位 + 状态扫描。
///
/// 与 code_assistant::AssistantStore 同款：内嵌 Mutex 串行化所有读-改-写（config.json），
/// Arc 共享支持 Clone 进 tauri::State。原子写用 tmp+rename（同 code_assistant::store）。
#[derive(Clone, Debug)]
pub struct PluginStore {
    /// app_data_dir/plugins（默认 plugins_root + 元数据目录均在此）。
    ///
    /// 注意：用户可在设置页把 pluginsRootPath 改为任意路径，此时插件落在自定义路径下，
    /// 但 PluginStore 的元数据（config.json）始终落在 app_data_dir/plugins/.lingfang/（固定锚点），
    /// 否则改了 plugins_root 后就找不到 config.json 自身（鸡生蛋问题）。
    anchor_root: PathBuf,
    file_lock: Arc<Mutex<()>>,
}

impl PluginStore {
    pub(crate) fn metadata_root(&self) -> PathBuf {
        self.anchor_root.join(META_DIR)
    }

    /// 构造存储：创建 anchor_root（app_data_dir/plugins）+ 默认 plugins_root（app_data/plugins）。
    /// 失败返回字符串错误（启动期调用）。
    pub fn new(app_data_dir: &Path) -> Result<Self, String> {
        let anchor_root = app_data_dir.join("plugins");
        fs::create_dir_all(&anchor_root).map_err(|e| format!("创建插件目录失败：{e}"))?;
        // 元数据目录（.lingfang/config.json）固定锚点：不随 plugins_root 自定义路径变，
        // 否则改了 plugins_root 后找不到 config 自身。plugins_root 默认即 anchor_root。
        fs::create_dir_all(anchor_root.join(META_DIR))
            .map_err(|e| format!("创建插件元数据目录失败：{e}"))?;
        let store = Self {
            anchor_root,
            file_lock: Arc::new(Mutex::new(())),
        };
        // 清理创建期 AI 会话失败/中断残留的空 temp-<id> 目录（无 manifest 无文件，无保留价值）。
        // files≥1 但无 manifest 的 temp 目录保留（可能有用户产出，由前端草稿恢复校验引导处理）。
        store.cleanup_empty_temp_dirs();
        Ok(store)
    }

    /// 清理 plugins_root 下 temp-* 空目录。
    ///
    /// 创建期无 plugin_id 时用 temp-<secs>-<nanos> 作临时 plugin_id 建目录（main.rs），
    /// AI 会话失败/中断会留下空目录。重启后这些目录无 manifest，草稿恢复指向它们会报错。
    /// 此处在启动时清理完全空目录（无任何文件/子目录），避免残留。
    ///
    /// 安全：用 `remove_dir`（非 `remove_dir_all`）只删空目录，非空目录报错忽略，
    /// 绝不误删有内容的目录。仅匹配 `temp-` 前缀，不碰正式插件目录。
    fn cleanup_empty_temp_dirs(&self) {
        let root = self.plugins_root();
        let Ok(entries) = fs::read_dir(&root) else {
            return; // plugins_root 不存在或无权限，静默跳过（启动不阻断）。
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            if !name_str.starts_with("temp-") {
                continue;
            }
            let path = entry.path();
            // 仅清理完全空目录（无任何文件/子目录）。
            let Ok(inner) = fs::read_dir(&path) else {
                continue;
            };
            if inner.count() == 0 {
                let _ = fs::remove_dir(&path); // 非空会失败，忽略（保守不删）。
            }
        }
    }

    /// 配置文件路径（固定锚点：app_data/plugins/.lingfang/config.json）。
    ///
    /// 不随 plugins_root 自定义路径变（否则改了 plugins_root 后找不到 config 自身）。
    fn config_path(&self) -> PathBuf {
        self.anchor_root.join(META_DIR).join("config.json")
    }

    /// 读取配置（文件缺失或解析失败返回 default，不报错）。
    pub fn read_config(&self) -> PluginStoreConfig {
        read_json(&self.config_path()).unwrap_or_default()
    }

    /// 写入配置（原子替换，锁内串行化）。
    pub fn write_config(&self, config: &PluginStoreConfig) -> Result<(), String> {
        let _guard = lock_or_recover(&self.file_lock);
        write_json(&self.config_path(), config)
    }

    /// 读取当前 relay 设置（api_base / auth_token，未配置为 None）。
    ///
    /// 仅供宿主侧（client_ai_proxy）读取并注入 BridgeSession；客户端 iframe 永不持有凭证。
    pub fn relay_settings(&self) -> RelaySettings {
        let cfg = self.read_config();
        RelaySettings {
            api_base: cfg.relay_api_base.filter(|s| !s.trim().is_empty()),
            auth_token: cfg.relay_auth_token.filter(|s| !s.trim().is_empty()),
        }
    }

    /// 更新 relay 设置（api_base / auth_token）。
    ///
    /// 读-改-写回 config.json（原子）。trim 后空串归一为 None（视为未配置）。
    pub fn set_relay_settings(
        &self,
        api_base: Option<String>,
        auth_token: Option<String>,
    ) -> Result<(), String> {
        let api_base = api_base.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let auth_token = auth_token
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let mut cfg = self.read_config();
        cfg.relay_api_base = api_base;
        cfg.relay_auth_token = auth_token;
        self.write_config(&cfg)
    }

    /// 插件根目录（plugins_root）：用户自定义优先，否则默认 app_data/plugins/（与组B + 前端契约一致）。
    ///
    /// 返回未规范化的路径（调用方按需 canonicalize）。配置脏值（空串）归一为默认。
    pub fn plugins_root(&self) -> PathBuf {
        let cfg = self.read_config();
        match cfg
            .plugins_root_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(custom) => PathBuf::from(custom),
            None => self.anchor_root.clone(),
        }
    }

    /// 单个插件目录：plugins_root/<plugin_id>/。plugin_id 走段级白名单校验防路径穿越。
    pub fn plugin_dir(&self, plugin_id: &str) -> Result<PathBuf, String> {
        let safe_id = sanitize_plugin_id(plugin_id)?;
        let root = self.plugins_root();
        let workspace = root.join("workspaces").join(&safe_id);
        if workspace.is_dir() {
            return Ok(workspace);
        }
        Ok(root.join(safe_id))
    }

    /// 确保插件目录存在（不存在则 create_dir_all）。返回规范化的插件目录绝对路径。
    /// 同时创建 data/ 子目录（PRD 需求 4 / AC4）：插件运行数据（JSON/SQLite/文件等）统一存这里，
    /// 子进程 cwd 即插件目录，可经相对路径 data/ 读写，框架保证目录存在（不依赖插件作者自觉 mkdir）。
    pub fn ensure_plugin_dir(&self, plugin_id: &str) -> Result<PathBuf, String> {
        let dir = self.plugin_dir(plugin_id)?;
        fs::create_dir_all(dir.join("data")).map_err(|e| format!("创建插件 data 目录失败：{e}"))?;
        dir.canonicalize()
            .map_err(|e| format!("插件目录无法访问：{e}"))
    }

    /// rename 插件目录为正式目录名，并可选地把用户命名写入 manifest.title（PRD 需求 1 / AC1）。
    ///
    /// rename_plugin_dir 命令的底层实现，抽出为方法便于单测（无需构造 tauri::State）。
    /// - old_id/new_id 经 sanitize_plugin_id 白名单校验（防穿越）。
    /// - 原目录不存在或目标已存在 → 报错。
    /// - title 非空 → 写入新目录 manifest.json 的 title 字段（保留其它字段），缺失则不动 manifest。
    /// 返回 sanitize 后的正式目录名（= 新 plugin_id）。
    pub fn rename_and_title(
        &self,
        old_id: &str,
        new_id: &str,
        title: Option<&str>,
    ) -> Result<String, String> {
        let safe_new = sanitize_plugin_id(new_id)?;
        let old_dir = self.plugin_dir(old_id)?;
        let new_dir = self.plugin_dir(&safe_new)?;
        if !old_dir.exists() {
            return Err(format!("原插件目录不存在：{old_id}"));
        }
        if new_dir.exists() {
            return Err(format!("目标插件名已存在：{safe_new}"));
        }
        fs::rename(&old_dir, &new_dir).map_err(|e| format!("重命名插件目录失败：{e}"))?;
        if let Some(t) = title.map(str::trim).filter(|s| !s.is_empty()) {
            let manifest_path = new_dir.join("manifest.json");
            if let Ok(content) = fs::read_to_string(&manifest_path) {
                // 解析为通用 JSON Value 改 title 字段后写回，保留其它字段与顺序。
                if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&content) {
                    if v.get("title").and_then(|x| x.as_str()) != Some(t) {
                        v["title"] = serde_json::Value::String(t.to_string());
                        if let Ok(pretty) = serde_json::to_string_pretty(&v) {
                            let _ = fs::write(&manifest_path, pretty);
                        }
                    }
                }
            }
            // manifest 不存在或读取失败：不阻断 rename（目录已改名成功），title 写入跳过。
        }
        Ok(safe_new)
    }
    ///
    /// 扫描 plugins_root 下全部子目录，产出每个插件的 PluginMeta（PRD 需求 2 / AC2）。
    ///
    /// 仅判定文件系统状态（ready/incomplete/error）；running/stopped 由 scan_plugin_status
    /// 命令层合并组B PluginProcessTable（本方法不查进程表，保持纯文件系统逻辑便于单测）。
    ///
    /// 流程：
    /// 1. plugins_root 不存在或读取失败 → 返回空 Vec（前端降级为空状态引导，不报错）。
    /// 2. 每个子目录：目录名通过 sanitize_plugin_id（跳过 .lingfang 等隐藏目录 + 非白名单目录名）。
    /// 3. 解析 manifest.json 判定 ready/incomplete/error（scan_one_plugin）。
    /// 4. 按 name（缺失按 id）字典序排序（前端列表稳定）。
    pub fn list_plugins(&self) -> Vec<PluginMeta> {
        let root = self.plugins_root();
        let entries = match fs::read_dir(&root) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        let mut metas: Vec<PluginMeta> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // 目录名作为 plugin_id（仅处理通过 sanitize 的合法目录名，跳过 .lingfang 等隐藏目录）。
            let dir_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if matches!(
                dir_name.as_str(),
                "installed" | "cache" | "workspaces" | ".lingfang-staging"
            ) {
                continue;
            }
            if sanitize_plugin_id(&dir_name).is_err() {
                // 隐藏目录（.lingfang）/含非法字符目录名：跳过，避免误解析。
                continue;
            }
            metas.push(scan_one_plugin(&path, &dir_name));
        }
        // 排序：name 优先，缺失按 id，稳定字典序。
        metas.sort_by_key(sort_key);
        metas
    }

    /// 读取插件目录下指定文件内容（read_local_plugin_file 命令底层）。
    ///
    /// 防路径穿越：canonicalize 目标后断言以插件目录为前缀（与 main.rs read_plugin_file 同款）。
    /// 二进制文件（非 UTF-8，如 PNG/ICO 图标）返回占位标记而非报错——
    /// 草稿加载/扫描会遍历目录全部文件，二进制报错会让整个加载失败（videodl-gui 等
    /// 含图标资源的插件无法编辑）。占位标记让前端能跳过二进制继续加载文本文件。
    pub fn read_plugin_file(&self, plugin_id: &str, file: &str) -> Result<String, String> {
        let file = file.trim();
        if file.is_empty() {
            return Err("文件路径不能为空".to_string());
        }
        let dir = self.plugin_dir(plugin_id)?;
        let base = dir
            .canonicalize()
            .map_err(|e| format!("插件目录不存在：{e}"))?;
        let target = base
            .join(file)
            .canonicalize()
            .map_err(|e| format!("文件不存在：{e}"))?;
        if !target.starts_with(&base) {
            return Err("非法文件路径".to_string());
        }
        if target.is_dir() {
            return Err(format!("目标不是文件：{file}"));
        }
        // 先读字节，再尝试 UTF-8 解码。失败说明是二进制文件（图标/图片等），
        // 返回占位标记让前端能识别并跳过，而不是让整个草稿加载失败。
        let bytes = fs::read(&target).map_err(|e| format!("读取文件失败：{e}"))?;
        match String::from_utf8(bytes.clone()) {
            Ok(text) => Ok(text),
            Err(_) => {
                // 二进制文件：返回占位标记（含大小信息，便于前端展示/跳过）。
                let size = bytes.len();
                Ok(format!(
                    "[binary file, {size} bytes, non-UTF-8 — 已跳过读取]"
                ))
            }
        }
    }

    /// 批量写插件文件到 plugins_root/<plugin_id>/（修改已有插件时落盘云端 files）。
    ///
    /// 与 read_plugin_file 对称的写操作。path 白名单防穿越：
    /// - 不含 `..` 段（防越出 plugin_dir）。
    /// - 非绝对路径（仅相对 plugin_dir）。
    /// - join 后 canonicalize 父目录校验仍在 base 内（文件可能不存在，校验其父目录）。
    /// 幂等：覆盖同名文件（保证云端最新版本）。自动创建子目录（如 ui/）。
    pub fn write_files(&self, plugin_id: &str, files: &[(String, String)]) -> Result<(), String> {
        let base = self.ensure_plugin_dir(plugin_id)?;
        for (path, content) in files {
            let target = self.resolve_write_target(&base, path)?;
            // 创建子目录（如 ui/）。
            if let Some(parent_dir) = target.parent() {
                fs::create_dir_all(parent_dir).map_err(|e| format!("创建文件目录失败：{e}"))?;
            }
            fs::write(&target, content).map_err(|e| format!("写入文件失败（{path}）：{e}"))?;
        }
        Ok(())
    }

    /// 写单个文件的**字节**（二进制文件，如字体/图片/音频）。
    /// 与 write_files 同款 path 白名单，仅 content 是 &[u8] 而非 &str。
    /// .lfplugin v3 导入路径：二进制文件经前端 base64 解码后走此方法（见 write_plugin_file_bytes 命令）。
    pub fn write_file_bytes(
        &self,
        plugin_id: &str,
        path: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        let base = self.ensure_plugin_dir(plugin_id)?;
        let target = self.resolve_write_target(&base, path)?;
        if let Some(parent_dir) = target.parent() {
            fs::create_dir_all(parent_dir).map_err(|e| format!("创建文件目录失败：{e}"))?;
        }
        fs::write(&target, bytes).map_err(|e| format!("写入文件失败（{path}）：{e}"))?;
        Ok(())
    }

    /// 读取插件目录下指定文件的**字节**（base64 编码返回），对称于 read_plugin_file。
    /// 用于 .lfplugin 导出：二进制文件需读真实字节而非占位标记。
    pub fn read_plugin_file_bytes(&self, plugin_id: &str, file: &str) -> Result<String, String> {
        let file = file.trim();
        if file.is_empty() {
            return Err("文件路径不能为空".to_string());
        }
        let dir = self.plugin_dir(plugin_id)?;
        let base = dir
            .canonicalize()
            .map_err(|e| format!("插件目录不存在：{e}"))?;
        let target = base
            .join(file)
            .canonicalize()
            .map_err(|e| format!("文件不存在：{e}"))?;
        if !target.starts_with(&base) {
            return Err("非法文件路径".to_string());
        }
        if target.is_dir() {
            return Err(format!("目标不是文件：{file}"));
        }
        let bytes = fs::read(&target).map_err(|e| format!("读取文件失败：{e}"))?;
        // base64 标准编码（无换行），前端用 atob / base64 解码。
        use base64::{engine::general_purpose, Engine as _};
        Ok(general_purpose::STANDARD.encode(&bytes))
    }

    /// 解析写操作的合法目标路径（write_files / write_file_bytes 共用）。
    /// path 白名单：拒空、绝对路径、含 `..`、越出插件目录（防穿越与符号链接绕过）。
    fn resolve_write_target(
        &self,
        base: &std::path::Path,
        path: &str,
    ) -> Result<std::path::PathBuf, String> {
        if path.is_empty() {
            return Err(format!("非法文件路径：{path}"));
        }
        let p = std::path::Path::new(path);
        // 绝对路径（Windows 盘符 C:\ 或 Unix /）一律拒。
        if p.is_absolute() || path.starts_with('/') || path.starts_with('\\') || path.contains(':')
        {
            return Err(format!("非法文件路径（绝对路径）：{path}"));
        }
        // 段级校验：任一段为 .. 视为穿越。
        if p.components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("非法文件路径（含 ..）：{path}"));
        }
        let target = base.join(p);
        // 校验规范化后仍在 base 内（防符号链接等绕过）。
        let parent = target.parent().unwrap_or(std::path::Path::new(""));
        if let Ok(parent_canon) = parent.canonicalize() {
            if !parent_canon.starts_with(base) {
                return Err(format!("非法文件路径（越出插件目录）：{path}"));
            }
        }
        Ok(target)
    }

    /// 删除插件目录下的单个文件（delete_plugin_file 命令底层）。
    ///
    /// 防路径穿越：与 read_plugin_file 同款 canonicalize + starts_with 断言（文件须已存在，
    /// canonicalize 不会失败）。文件不存在返回错误（让调用方感知，而非静默成功）。
    /// 不允许删除目录（避免误删整个子树；目录级删除走 delete_plugin）。
    pub fn delete_plugin_file(&self, plugin_id: &str, file: &str) -> Result<(), String> {
        let file = file.trim();
        if file.is_empty() {
            return Err("文件路径不能为空".to_string());
        }
        let dir = self.plugin_dir(plugin_id)?;
        let base = dir
            .canonicalize()
            .map_err(|e| format!("插件目录不存在：{e}"))?;
        let target = base
            .join(file)
            .canonicalize()
            .map_err(|e| format!("文件不存在：{e}"))?;
        if !target.starts_with(&base) {
            return Err("非法文件路径".to_string());
        }
        if target.is_dir() {
            return Err(format!(
                "目标是目录而非文件（删除目录请用 delete_plugin）：{file}"
            ));
        }
        fs::remove_file(&target).map_err(|e| format!("删除文件失败（{file}）：{e}"))
    }

    /// 移动/重命名插件目录下的文件（move_plugin_file 命令底层）。
    ///
    /// 防路径穿越：与 write_files 同款段级校验（无 .. / 绝对路径）+ canonicalize 父目录前缀断言。
    /// 源文件须存在（canonicalize 校验）；目标若已存在则覆盖（rename 语义，对重构场景合理）。
    /// 自动创建目标子目录。不允许移动到目录（目标是目录时报错）。
    pub fn move_plugin_file(&self, plugin_id: &str, from: &str, to: &str) -> Result<(), String> {
        let from = from.trim();
        let to = to.trim();
        if from.is_empty() || to.is_empty() {
            return Err("文件路径不能为空".to_string());
        }
        if from == to {
            return Err("源路径与目标路径相同".to_string());
        }
        let dir = self.plugin_dir(plugin_id)?;
        let base = dir
            .canonicalize()
            .map_err(|e| format!("插件目录不存在：{e}"))?;
        // 源文件须存在 + 在 base 内。
        let src = base
            .join(from)
            .canonicalize()
            .map_err(|e| format!("源文件不存在：{e}"))?;
        if !src.starts_with(&base) {
            return Err("非法源路径".to_string());
        }
        if src.is_dir() {
            return Err(format!("源是目录而非文件（移动目录暂不支持）：{from}"));
        }
        // 目标路径段级校验（防穿越，与 write_files 一致）。
        let to_p = std::path::Path::new(to);
        if to_p.is_absolute() || to.starts_with('/') || to.starts_with('\\') || to.contains(':') {
            return Err(format!("非法目标路径（绝对路径）：{to}"));
        }
        if to_p
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(format!("非法目标路径（含 ..）：{to}"));
        }
        let dst = base.join(to_p);
        let dst_parent = dst.parent().unwrap_or(std::path::Path::new(""));
        if let Ok(parent_canon) = dst_parent.canonicalize() {
            if !parent_canon.starts_with(&base) {
                return Err(format!("非法目标路径（越出插件目录）：{to}"));
            }
        }
        // 创建目标子目录（如 ui/）。
        if let Some(parent_dir) = dst.parent() {
            fs::create_dir_all(parent_dir).map_err(|e| format!("创建目标目录失败：{e}"))?;
        }
        fs::rename(&src, &dst).map_err(|e| format!("移动文件失败（{from} → {to}）：{e}"))
    }

    /// 列出插件目录下的所有源文件相对路径（递归，跳过运行时副产物目录）。
    ///
    /// Agent 的 Glob/列文件树工具底层。跳过 data/.venv/node_modules/.git 等运行时目录，
    /// 只返回插件作者关心的源文件，避免把上千个依赖文件塞给模型。返回相对插件目录的正斜杠路径。
    pub fn list_files(&self, plugin_id: &str) -> Result<Vec<String>, String> {
        let dir = self.plugin_dir(plugin_id)?;
        let base = dir
            .canonicalize()
            .map_err(|e| format!("插件目录不存在：{e}"))?;
        let mut out: Vec<String> = Vec::new();
        collect_source_paths(&base, &base, &mut out);
        out.sort();
        Ok(out)
    }

    /// 写单个文件到插件目录（Agent 的 Write 工具底层）。复用 write_files 的路径白名单校验。
    pub fn write_single_file(
        &self,
        plugin_id: &str,
        path: &str,
        content: &str,
    ) -> Result<(), String> {
        self.write_files(plugin_id, &[(path.to_string(), content.to_string())])
    }

    /// 设置插件 manifest 的 draft 标记（发布后置 false，转为正式插件）。
    ///
    /// 读 manifest.json → 改 draft 字段 → 写回（保留其它字段）。manifest 缺失/非法报错。
    pub fn set_draft_flag(&self, plugin_id: &str, draft: bool) -> Result<(), String> {
        let dir = self.plugin_dir(plugin_id)?;
        let manifest_path = dir.join("manifest.json");
        let raw =
            fs::read_to_string(&manifest_path).map_err(|e| format!("读取 manifest 失败：{e}"))?;
        let mut v: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("解析 manifest 失败：{e}"))?;
        v["draft"] = serde_json::Value::Bool(draft);
        let pretty =
            serde_json::to_string_pretty(&v).map_err(|e| format!("序列化 manifest 失败：{e}"))?;
        fs::write(&manifest_path, pretty).map_err(|e| format!("写入 manifest 失败：{e}"))?;
        Ok(())
    }
}

/// 递归收集插件目录下的源文件相对路径（list_files 底层）。
///
/// 跳过运行时副产物目录（data/.venv/venv/node_modules/__pycache__/.git）与隐藏文件，
/// 只保留插件作者编写的源文件。相对路径用正斜杠（跨平台一致，与 manifest entry 对齐）。
fn collect_source_paths(base: &Path, dir: &Path, out: &mut Vec<String>) {
    const SKIP_DIRS: [&str; 6] = [
        "data",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        ".git",
    ];
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if path.is_dir() {
            if SKIP_DIRS.contains(&name) || name.starts_with('.') {
                continue;
            }
            collect_source_paths(base, &path, out);
        } else if path.is_file() {
            // 隐藏文件（.meta.json 等）跳过；其余按相对路径正斜杠收集。
            if name.starts_with('.') {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(base) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
}

/// 扫描单个插件目录，判定 ready/incomplete/error（不含运行态，由命令层合并组B 进程表）。
///
/// 判定规则（PRD 需求 2）：
/// - manifest.json 不存在 → incomplete（detail 说明缺 manifest）。
/// - manifest.json 存在但 JSON 解析失败 → error（detail 说明解析错误）。
/// - manifest 解析成功但缺 id 或 name → error（detail 说明缺字段）。
/// - manifest 合法但入口文件不存在 → incomplete（detail 说明缺 entry）。
/// - manifest 合法且入口存在 → ready。
fn scan_one_plugin(dir: &Path, plugin_id: &str) -> PluginMeta {
    let manifest_path = dir.join("manifest.json");
    let raw = match fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(_) => {
            return PluginMeta {
                id: plugin_id.to_string(),
                name: plugin_id.to_string(),
                status: PluginStatus::Incomplete,
                runtime: PluginRuntime::Client,
                entry: String::new(),
                description: String::new(),
                version: "0.0.0".to_string(),
                icon: None,
                pid: None,
                started_at: None,
                detail: Some("缺少 manifest.json（AI 生成未完成）".to_string()),
                draft: false,
            };
        }
    };
    let v: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return PluginMeta {
                id: plugin_id.to_string(),
                name: plugin_id.to_string(),
                status: PluginStatus::Error,
                runtime: PluginRuntime::Client,
                entry: String::new(),
                description: String::new(),
                version: "0.0.0".to_string(),
                icon: None,
                pid: None,
                started_at: None,
                detail: Some(format!("manifest.json 解析失败：{e}")),
                draft: false,
            };
        }
    };
    // 缺 id 或 name → error（与 plugins.rs parse_manifest 同款强约束）。
    // 注意：PluginMeta.id 始终用目录名（plugin_id），不用 manifest.id —— 文件系统操作
    // （delete/read/start/rename）以目录名为准，manifest.id 仅是声明，可能与目录名不同
    // （用户上传命名 safePluginId 与 manifest.id 常不一致）。若用 manifest.id 作 id，
    // delete 会指向不存在的目录幂等 Ok 但没删（实战 bug）。
    let id_field = v.get("id").and_then(|x| x.as_str());
    let name_field = v.get("name").and_then(|x| x.as_str());
    let runtime = parse_runtime(v.get("runtime_type"));
    if id_field.is_none() || name_field.is_none() {
        return PluginMeta {
            id: plugin_id.to_string(),
            name: name_field.unwrap_or(plugin_id).to_string(),
            status: PluginStatus::Error,
            runtime,
            entry: parse_entry(v.get("entry"), runtime),
            description: parse_description(v.get("description")),
            version: parse_version(v.get("version")),
            icon: None,
            pid: None,
            started_at: None,
            detail: Some("manifest.json 缺少 id 或 name 字段".to_string()),
            draft: parse_draft(v.get("draft")),
        };
    }
    // title（用户命名，PRD 需求 1）优先，缺失回退 name（程序标识符），再缺失回退 id（目录名）。
    let name = v
        .get("title")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .or(name_field)
        .unwrap_or(plugin_id)
        .to_string();
    let entry = parse_entry(v.get("entry"), runtime);
    // 入口文件有效性：manifest 合法但缺入口/入口是目录 → incomplete（与读取命令只读文件保持一致）。
    let entry_path = dir.join(&entry);
    let (status, detail) = if !entry.is_empty() && entry_path.is_file() {
        (PluginStatus::Ready, None)
    } else if !entry.is_empty() && entry_path.is_dir() {
        (
            PluginStatus::Incomplete,
            Some(format!("入口路径 {entry} 不是文件")),
        )
    } else {
        (
            PluginStatus::Incomplete,
            Some(format!("入口文件 {entry} 不存在")),
        )
    };
    PluginMeta {
        id: plugin_id.to_string(),
        name,
        status,
        runtime,
        entry,
        description: parse_description(v.get("description")),
        version: parse_version(v.get("version")),
        icon: parse_icon(v.get("icon")),
        pid: None,
        started_at: None,
        detail,
        draft: parse_draft(v.get("draft")),
    }
}

/// 从 manifest runtime_type 字段解析运行时类型（缺失/未知/cloud 归一为 client）。
fn parse_runtime(value: Option<&Value>) -> PluginRuntime {
    match value.and_then(|v| v.as_str()) {
        Some("nodejs") => PluginRuntime::Nodejs,
        Some("python") => PluginRuntime::Python,
        Some("client") => PluginRuntime::Client,
        // cloud / 未知值：本地无运行概念，归一为 client（前端对本地 cloud 插件不展示运行按钮）。
        _ => PluginRuntime::Client,
    }
}

/// 解析 manifest entry 字段（缺失时按 runtime 回退，与前端 defaultEntryForRuntime / start_plugin 对齐）。
fn parse_entry(value: Option<&Value>, runtime: PluginRuntime) -> String {
    value
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| match runtime {
            PluginRuntime::Client => "ui/index.html".to_string(),
            PluginRuntime::Nodejs => "index.js".to_string(),
            PluginRuntime::Python => "main.py".to_string(),
        })
}

/// 解析 manifest description（缺失为空串）。
fn parse_description(value: Option<&Value>) -> String {
    value.and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// 解析 manifest version（缺失为 '0.0.0'）。
fn parse_version(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("0.0.0")
        .to_string()
}

/// 解析 manifest draft 标记（缺失/非 true 视为 false）。
/// AI 创建器统一写入 plugins_root，用 manifest.draft===true 区分未发布草稿与已安装插件。
fn parse_draft(value: Option<&Value>) -> bool {
    value.and_then(|v| v.as_bool()).unwrap_or(false)
}

/// 解析 manifest icon（缺失/空为 None；前端 PluginIcon 据此显示真实图标，None 回退默认 🧩）。
fn parse_icon(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 排序 key：name 优先，缺失按 id（保证稳定字典序，前端列表不抖动）。
fn sort_key(meta: &PluginMeta) -> String {
    let name = meta.name.trim();
    if name.is_empty() {
        meta.id.clone()
    } else {
        name.to_string()
    }
}

/// plugin_id 段级白名单校验（[A-Za-z0-9_-]，与 plugin_script/plugin_runner 同款）。
///
/// 防 plugin_id 含 '../'、'\\'、盘符、空串或隐藏段（. 开头）时越出 plugins_root。
pub fn sanitize_plugin_id(plugin_id: &str) -> Result<String, String> {
    let trimmed = plugin_id.trim();
    if trimmed.is_empty() {
        return Err("plugin_id 不能为空".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!(
            "plugin_id 含非法字符（仅允许字母数字下划线短横线）：{trimmed}"
        ));
    }
    Ok(trimmed.to_string())
}

// === JSON 读写辅助（复用 code_assistant::store 同款原子写策略，避免跨模块依赖） ===

pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 原子写 JSON：写到同目录临时文件再 rename 替换（与 code_assistant::store::write_json_atomically 同款）。
///
/// 同目录保证 tmp 与目标在同文件系统（rename 原子语义的前提）。tmp 文件名带 pid + 纳秒时间戳避免并发覆盖。
pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "目标路径无父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp_name = format!(
        ".tmp-{}-{}-{}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    let tmp_path = parent.join(&tmp_name);
    if let Err(e) = fs::write(&tmp_path, &raw) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e.to_string());
    }
    if let Err(e) = persist_rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }
    Ok(())
}

/// 跨平台原子 rename（覆盖目标）。与 code_assistant::store::persist_rename 同款实现。
fn persist_rename(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::rename(from, to).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        // MoveFileExW 带 MOVEFILE_REPLACE_EXISTING (0x1) + MOVEFILE_WRITE_THROUGH (0x8)。
        const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
        const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
        let from_wide: Vec<u16> = from
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let to_wide: Vec<u16> = to
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        extern "system" {
            fn MoveFileExW(
                lpexistingfilename: *const u16,
                lpnewfilename: *const u16,
                dwflags: u32,
            ) -> i32;
        }
        unsafe {
            let ok = MoveFileExW(
                from_wide.as_ptr(),
                to_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            );
            if ok == 0 {
                Err(std::io::Error::last_os_error().to_string())
            } else {
                Ok(())
            }
        }
    }
}

// === Tauri 命令（组A 暴露给前端，命令名与 lib/plugin-status.ts 契约对齐） ===

/// 命令：读取插件根目录路径（PRD 需求 6 / AC7）。
///
/// 默认 app_data/plugins/（首次启动自动创建），用户在设置页改过后从 config.json 读取。
/// 返回字符串路径（前端展示 + 传给后续命令）。
#[tauri::command]
pub fn get_plugins_root(state: tauri::State<'_, PluginStore>) -> String {
    state.plugins_root().to_string_lossy().to_string()
}

/// 命令：配置插件根目录路径（PRD AC7）。
///
/// 流程：
/// 1. trim 空串 → 视为恢复默认（写 None 到 config）。
/// 2. 规范化（去尾部斜杠）+ 校验可创建（不存在则 mkdir -p）。
/// 3. 写入 config.json，返回最终生效路径（规范化后，可能与入参不同）。
/// 4. 已有插件迁移：Constraints 末条约定——原路径保留，提示用户手动迁移（此处不自动搬迁，
///    避免大目录移动的 IO 风险与失败回滚复杂度）。
#[tauri::command]
pub fn set_plugins_root(
    state: tauri::State<'_, PluginStore>,
    path: String,
) -> Result<String, String> {
    let trimmed = path.trim();
    // 空串/纯空白 → 恢复默认（config 写 None）。
    let effective = if trimmed.is_empty() {
        None
    } else {
        // 去尾部斜杠（Windows 下同时处理 / 与 \），规范化存储避免配置层路径歧义。
        let normalized = trimmed.trim_end_matches(['/', '\\']).to_string();
        // 校验可创建（不存在则 mkdir -p；存在但非目录则报错）。
        let target = PathBuf::from(&normalized);
        if target.exists() && !target.is_dir() {
            return Err(format!("路径不是目录：{normalized}"));
        }
        fs::create_dir_all(&target).map_err(|e| format!("创建插件根目录失败：{e}"))?;
        Some(normalized)
    };
    // 只更新 plugins_root_path，其余字段（relay_* 凭据）读旧值保留——
    // 整体重建会把手写的 relay 设置清掉。
    let mut config = state.read_config();
    config.plugins_root_path = effective.clone();
    state.write_config(&config)?;
    // 返回最终生效路径（自定义则规范化后原样，默认则 plugins_root() 计算的默认值）。
    Ok(match effective {
        Some(p) => p,
        None => state.plugins_root().to_string_lossy().to_string(),
    })
}

/// 命令：扫描插件根目录，返回每个插件的动态状态（PRD 需求 2 / AC2）。
///
/// 组A 实现：文件系统扫描判定 ready/incomplete/error，合并组B PluginProcessTable 判定 running。
/// 组B 的 start_plugin/stop_plugin 维护 PluginProcessTable（内存态，重启后清空 → 所有插件回到 ready）。
///
/// 合并逻辑：进程表 is_running 命中 → status=running + pid + started_at；否则保持文件系统状态。
/// 命令：读取当前 relay 设置（api_base / auth_token，未配置为 None）。
///
/// 仅供宿主侧 client_ai_proxy 等命令读取；前端据此提示「请先在设置中配置」。
#[tauri::command]
pub fn get_relay_settings(state: tauri::State<'_, PluginStore>) -> RelaySettings {
    state.relay_settings()
}

/// 命令：配置 relay 设置（api_base / auth_token）。
///
/// 空串/纯空白 → 视为未配置（写 None）。写入 config.json（原子）。
#[tauri::command]
pub fn set_relay_settings(
    state: tauri::State<'_, PluginStore>,
    api_base: Option<String>,
    auth_token: Option<String>,
) -> Result<(), String> {
    state.set_relay_settings(api_base, auth_token)
}

/// 命令：扫描插件根目录，返回每个插件的动态状态（PRD 需求 2 / AC2）。
///
/// 组A 实现：文件系统扫描判定 ready/incomplete/error，合并组B PluginProcessTable 判定 running。
/// 组B 的 start_plugin/stop_plugin 维护 PluginProcessTable（内存态，重启后清空 → 所有插件回到 ready）。
///
/// 合并逻辑：进程表 is_running 命中 → status=running + pid + started_at；否则保持文件系统状态。
#[tauri::command]
pub fn scan_plugin_status(
    store: tauri::State<'_, PluginStore>,
    process_table: tauri::State<'_, crate::plugin_runner::PluginProcessTable>,
) -> Vec<PluginMeta> {
    let mut metas = store.list_plugins();
    // 合并组B 进程表：内存态判定 running（不存 DB，重启后从文件系统重判 ready，符合 PRD）。
    for meta in metas.iter_mut() {
        if let Some((pid, started_at)) = process_table.is_running(&meta.id) {
            meta.status = PluginStatus::Running;
            meta.pid = Some(pid);
            meta.started_at = Some(started_at);
            // running 态清掉文件系统层的 detail（进程在跑，detail 无意义）。
            meta.detail = None;
        }
    }
    metas
}

/// 命令：读取本地插件 entry 文件内容（PRD 需求 8：HTML 在软件内 iframe 显示）。
///
/// 仅允许读取 plugins_root/<pluginId>/ 下的文件（canonicalize 前缀断言防路径穿越，
/// 与 main.rs read_plugin_file 同款）。返回 UTF-8 文本内容。
#[tauri::command]
pub fn read_local_plugin_file(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
    file: String,
) -> Result<String, String> {
    state.read_plugin_file(&plugin_id, &file)
}

/// 命令：读取本地插件文件的**字节**（base64 编码返回），对称于 read_local_plugin_file。
/// .lfplugin v3 导出路径用：二进制文件（字体/图片/音频）需读真实字节而非占位标记。
#[tauri::command]
pub fn read_local_plugin_file_bytes(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
    file: String,
) -> Result<String, String> {
    state.read_plugin_file_bytes(&plugin_id, &file)
}

/// 单个文件入参（path 相对插件目录，content 文件内容）。
#[derive(serde::Deserialize)]
pub struct PluginFileInput {
    pub path: String,
    pub content: String,
}

/// 命令：批量写插件文件到 plugins_root/<plugin_id>/（修改已有插件时落盘云端 files）。
/// 与 read_local_plugin_file 对称。path 白名单防穿越（write_files 方法内校验）。幂等覆盖。
#[tauri::command]
pub fn write_plugin_files(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
    files: Vec<PluginFileInput>,
) -> Result<(), String> {
    let pairs: Vec<(String, String)> = files.into_iter().map(|f| (f.path, f.content)).collect();
    state.write_files(&plugin_id, &pairs)
}

/// 命令：写单个**二进制**文件到 plugins_root/<plugin_id>/（.lfplugin v3 导入路径用）。
/// content_base64 为标准 base64 编码的字节，解码后走 write_file_bytes（与 write_files 同款 path 白名单）。
#[tauri::command]
pub fn write_plugin_file_bytes(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
    path: String,
    content_base64: String,
) -> Result<(), String> {
    use base64::{engine::general_purpose, Engine as _};
    let bytes = general_purpose::STANDARD
        .decode(content_base64.as_bytes())
        .map_err(|e| format!("base64 解码失败（{path}）：{e}"))?;
    state.write_file_bytes(&plugin_id, &path, &bytes)
}

/// 命令：列出插件目录下所有源文件相对路径（Agent 的 Glob/列文件树工具）。
/// 跳过 data/.venv/node_modules 等运行时目录，只返回源文件。
#[tauri::command]
pub fn list_plugin_files(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
) -> Result<Vec<String>, String> {
    state.list_files(&plugin_id)
}

/// 命令：写单个文件到 plugins_root/<plugin_id>/（Agent 的 Write 工具）。
/// path 白名单防穿越（write_files 内校验）。幂等覆盖。
#[tauri::command]
pub fn write_plugin_file(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    state.write_single_file(&plugin_id, &path, &content)
}

/// 命令：设置插件 manifest 的 draft 标记（发布后置 false 转正式插件）。
#[tauri::command]
pub fn set_plugin_draft_flag(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
    draft: bool,
) -> Result<(), String> {
    state.set_draft_flag(&plugin_id, draft)
}

/// 命令：删除插件目录下的单个文件（Agent 的 DeleteFile 工具底层）。
/// path 白名单 + canonicalize 前缀断言防穿越（与 read_local_plugin_file 同款）。
#[tauri::command]
pub fn delete_plugin_file(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
    file: String,
) -> Result<(), String> {
    state.delete_plugin_file(&plugin_id, &file)
}

/// 命令：移动/重命名插件目录下的文件（Agent 的 MoveFile 工具底层）。
/// from/to 均为相对插件目录的路径；源须存在，目标若存在则覆盖。
#[tauri::command]
pub fn move_plugin_file(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    state.move_plugin_file(&plugin_id, &from, &to)
}

#[tauri::command]
pub fn open_plugins_root(state: tauri::State<'_, PluginStore>) -> Result<(), String> {
    let root = state.plugins_root();
    fs::create_dir_all(&root).map_err(|e| format!("创建插件目录失败：{e}"))?;
    open_directory(&root)
}

#[tauri::command]
pub fn open_plugin_dir(
    state: tauri::State<'_, PluginStore>,
    plugin_id: String,
) -> Result<(), String> {
    let dir = state.ensure_plugin_dir(&plugin_id)?;
    open_directory(&dir)
}

fn open_directory(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("explorer");
        cmd.arg(path);
        cmd
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(path);
        cmd
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(path);
        cmd
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开插件目录失败：{e}"))
}

/// 流程重构：上传命名时 rename 临时插件目录为正式目录，并把用户命名写入 manifest.title（PRD 需求 1 / AC1）。
/// 安全：old_id 和 new_id 均走 sanitize_plugin_id 白名单。
/// title（可选）：非空时写入新目录 manifest.json 的 title 字段，scan_one_plugin 据此展示用户命名
/// （title 优先于 name）。title 为空表示仅改目录名、不动 manifest。
#[tauri::command]
pub fn rename_plugin_dir(
    state: tauri::State<'_, PluginStore>,
    old_id: String,
    new_id: String,
    title: Option<String>,
) -> Result<String, String> {
    state.rename_and_title(&old_id, &new_id, title.as_deref())
}

// === 单元测试（覆盖 scan 状态判定 + sanitize_plugin_id 防穿越 + 配置读写） ===

#[cfg(test)]
mod tests;
