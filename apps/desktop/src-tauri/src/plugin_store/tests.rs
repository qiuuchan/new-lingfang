use super::*;

/// 构造临时 PluginStore（anchor_root 在 temp_dir 下，隔离测试）。
fn temp_store(name: &str) -> PluginStore {
    let root = std::env::temp_dir().join(format!(
        "qianxia-plugin-store-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    PluginStore::new(&root).expect("PluginStore 构造应成功")
}

#[test]
fn sanitize_plugin_id_rejects_traversal() {
    // 合法 id 通过。
    assert_eq!(sanitize_plugin_id("my-clock").unwrap(), "my-clock");
    assert_eq!(sanitize_plugin_id("plugin_001").unwrap(), "plugin_001");
    // 路径穿越字符被拒（防 ../ 越出 plugins_root）。
    assert!(sanitize_plugin_id("../escape").is_err());
    assert!(sanitize_plugin_id("a/b").is_err());
    assert!(sanitize_plugin_id("C:\\win").is_err());
    assert!(sanitize_plugin_id("").is_err());
    assert!(sanitize_plugin_id("   ").is_err());
    // 隐藏段（. 开头，如 .qianxia）被拒（scan 据此跳过元数据目录）。
    assert!(sanitize_plugin_id(".qianxia").is_err());
    assert!(sanitize_plugin_id(".env").is_err());
    // 中文目录名被拒（仅允许 ASCII 字母数字下划线短横线）。
    assert!(sanitize_plugin_id("我的插件").is_err());
}

#[test]
fn scan_ready_plugin_has_manifest_and_entry() {
    let store = temp_store("scan-ready");
    let dir = store.plugins_root().join("my-clock");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("manifest.json"),
        r#"{"id":"my-clock","name":"我的时钟","runtime_type":"client","entry":"ui/index.html","version":"1.2.0","description":"一个时钟"}"#,
    ).unwrap();
    fs::create_dir_all(dir.join("ui")).unwrap();
    fs::write(dir.join("ui").join("index.html"), "<p>ok</p>").unwrap();

    let metas = store.list_plugins();
    assert_eq!(metas.len(), 1);
    let m = &metas[0];
    assert_eq!(m.id, "my-clock");
    // title 优先（此处无 title → 回退 name）。
    assert_eq!(m.name, "我的时钟");
    assert_eq!(m.status, PluginStatus::Ready);
    assert_eq!(m.runtime, PluginRuntime::Client);
    assert_eq!(m.entry, "ui/index.html");
    assert_eq!(m.version, "1.2.0");
    assert_eq!(m.description, "一个时钟");
    assert!(m.detail.is_none());
}

// scan 的 id 用目录名（plugin_id），不用 manifest.id —— 文件系统操作以目录名为准。
// manifest.id 与目录名不同时（用户命名 safePluginId 常与 manifest.id 不一致），
// id 仍应是目录名，否则 delete/read 指向错误路径（实战：显示删除成功但目录没删）。
#[test]
fn scan_id_uses_dir_name_not_manifest_id() {
    let store = temp_store("scan-id-dirname");
    // 目录名 = "ai-image"，manifest.id = "ai-image-studio"（不同）。
    let dir = store.plugins_root().join("ai-image");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("manifest.json"),
        r#"{"id":"ai-image-studio","name":"AI图像工作室","runtime_type":"client","entry":"ui/index.html"}"#,
    ).unwrap();
    fs::create_dir_all(dir.join("ui")).unwrap();
    fs::write(dir.join("ui").join("index.html"), "x").unwrap();

    let metas = store.list_plugins();
    assert_eq!(metas.len(), 1);
    // id 必须是目录名 "ai-image"，不是 manifest.id "ai-image-studio"。
    assert_eq!(metas[0].id, "ai-image");
    // name 用 manifest.name（展示名）。
    assert_eq!(metas[0].name, "AI图像工作室");
}

#[test]
fn scan_title_takes_priority_over_name() {
    // PRD 需求 1：插件名用户命名，manifest.title 优先于 manifest.name 展示。
    let store = temp_store("scan-title");
    let dir = store.plugins_root().join("plugin-1");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("manifest.json"),
        r#"{"id":"plugin-1","name":"programmatic-id-name","title":"用户命名","entry":"ui/index.html"}"#,
    ).unwrap();
    fs::create_dir_all(dir.join("ui")).unwrap();
    fs::write(dir.join("ui").join("index.html"), "x").unwrap();

    let metas = store.list_plugins();
    assert_eq!(metas[0].name, "用户命名");
}

#[test]
fn rename_and_title_writes_title_and_renames_dir() {
    // AC1 用户命名：rename 临时目录为正式名 + 把用户命名写入 manifest.title。
    // 后端 new_id 已是前端 safePluginId 转换后的纯 ASCII（sanitize_plugin_id 只接受 ASCII），
    // 中文用户名作为 title 参数传入（写进 manifest.title，scan 据此展示）。
    let store = temp_store("rename-title");
    // 构造临时插件目录（模拟 AI 生成落盘的 temp-<id> 目录），manifest 无 title。
    let temp_dir = store.ensure_plugin_dir("temp-1700000000-123").unwrap();
    fs::write(
        temp_dir.join("manifest.json"),
        r#"{"id":"x","name":"ai-gen-id","entry":"ui/index.html"}"#,
    )
    .unwrap();
    fs::create_dir_all(temp_dir.join("ui")).unwrap();
    fs::write(temp_dir.join("ui").join("index.html"), "x").unwrap();

    // rename 为正式目录名（前端 safePluginId 已把「我的番茄钟」转成 ASCII，如 base36 编码串）+ 写入用户命名 title。
    let safe = store
        .rename_and_title(
            "temp-1700000000-123",
            "wode-fanqie-zhong",
            Some("我的番茄钟"),
        )
        .unwrap();
    assert_eq!(safe, "wode-fanqie-zhong");

    // scan 读到的展示名是用户命名（title 优先），而非 ai-gen-id。
    let metas = store.list_plugins();
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].name, "我的番茄钟");
    // PluginMeta.id 取目录名（持久化 plugin_id），不用 manifest.id。
    assert_eq!(metas[0].id, "wode-fanqie-zhong");
    // 目录已从 temp-1700000000-123 改名为正式目录名 wode-fanqie-zhong。
    assert!(
        !store.plugin_dir("temp-1700000000-123").unwrap().exists(),
        "旧临时目录应已不存在"
    );
    let new_dir = store.plugin_dir(&safe).unwrap();
    assert!(new_dir.exists(), "正式目录应存在");
    // manifest.json 的 title 字段确实被写入（pretty print 格式，冒号后带空格）。
    let new_manifest = fs::read_to_string(new_dir.join("manifest.json")).unwrap();
    assert!(
        new_manifest.contains(r#""title": "我的番茄钟""#),
        "title 应写入 manifest.json，实际：{new_manifest}"
    );
    // 原有字段保留（rename 不破坏 manifest 其它内容）。
    assert!(
        new_manifest.contains(r#""name": "ai-gen-id""#),
        "原 name 字段应保留"
    );
    // data/ 子目录仍在（ensure_plugin_dir 创建，rename 不丢）。
    assert!(new_dir.join("data").is_dir());
}

#[test]
fn rename_and_title_rejects_existing_target() {
    let store = temp_store("rename-collision");
    store.ensure_plugin_dir("src-a").unwrap();
    store.ensure_plugin_dir("dst-b").unwrap();
    // 目标已存在 → 报错，不覆盖。
    let err = store.rename_and_title("src-a", "dst-b", None).unwrap_err();
    assert!(err.contains("已存在"));
}

#[test]
fn scan_incomplete_when_manifest_missing() {
    let store = temp_store("scan-no-manifest");
    let dir = store.plugins_root().join("haqx-baked");
    fs::create_dir_all(&dir).unwrap();
    // 仅写了 entry 文件，无 manifest.json。
    fs::create_dir_all(dir.join("ui")).unwrap();
    fs::write(dir.join("ui").join("index.html"), "x").unwrap();

    let metas = store.list_plugins();
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].status, PluginStatus::Incomplete);
    assert!(metas[0].detail.as_deref().unwrap().contains("manifest"));
}

#[test]
fn scan_incomplete_when_entry_missing() {
    let store = temp_store("scan-no-entry");
    let dir = store.plugins_root().join("no-entry");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("manifest.json"),
        r#"{"id":"no-entry","name":"无入口","entry":"main.py"}"#,
    )
    .unwrap();
    // 无 main.py。
    let metas = store.list_plugins();
    assert_eq!(metas[0].status, PluginStatus::Incomplete);
    assert!(metas[0].detail.as_deref().unwrap().contains("main.py"));
}

#[test]
fn scan_incomplete_when_entry_points_to_directory() {
    let store = temp_store("scan-entry-dir");
    let dir = store.plugins_root().join("entry-dir");
    fs::create_dir_all(dir.join("ui")).unwrap();
    fs::write(
        dir.join("manifest.json"),
        r#"{"id":"entry-dir","name":"目录入口","entry":"ui"}"#,
    )
    .unwrap();

    let metas = store.list_plugins();
    assert_eq!(metas[0].status, PluginStatus::Incomplete);
    assert!(metas[0].detail.as_deref().unwrap().contains("不是文件"));
}

#[test]
fn scan_error_when_manifest_invalid_json() {
    let store = temp_store("scan-bad-json");
    let dir = store.plugins_root().join("bad");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("manifest.json"), "{ not json").unwrap();

    let metas = store.list_plugins();
    assert_eq!(metas[0].status, PluginStatus::Error);
    assert!(metas[0].detail.as_deref().unwrap().contains("解析失败"));
}

#[test]
fn scan_error_when_manifest_missing_id_or_name() {
    let store = temp_store("scan-no-id");
    let dir = store.plugins_root().join("no-id");
    fs::create_dir_all(&dir).unwrap();
    // 缺 name 字段。
    fs::write(
        dir.join("manifest.json"),
        r#"{"id":"no-id","entry":"ui/index.html"}"#,
    )
    .unwrap();
    let metas = store.list_plugins();
    assert_eq!(metas[0].status, PluginStatus::Error);
    assert!(metas[0].detail.as_deref().unwrap().contains("id 或 name"));
}

#[test]
fn scan_parses_runtime_types() {
    let store = temp_store("scan-runtime");
    // python 插件。
    let py_dir = store.plugins_root().join("py-plugin");
    fs::create_dir_all(&py_dir).unwrap();
    fs::write(
        py_dir.join("manifest.json"),
        r#"{"id":"py-plugin","name":"Py","runtime_type":"python","entry":"main.py"}"#,
    )
    .unwrap();
    fs::write(py_dir.join("main.py"), "print(1)").unwrap();
    // nodejs 插件。
    let node_dir = store.plugins_root().join("node-plugin");
    fs::create_dir_all(&node_dir).unwrap();
    fs::write(
        node_dir.join("manifest.json"),
        r#"{"id":"node-plugin","name":"Node","runtime_type":"nodejs","entry":"index.js"}"#,
    )
    .unwrap();
    fs::write(node_dir.join("index.js"), "console.log(1)").unwrap();
    // cloud 插件（归一为 client）。
    let cloud_dir = store.plugins_root().join("cloud-plugin");
    fs::create_dir_all(&cloud_dir).unwrap();
    fs::write(
        cloud_dir.join("manifest.json"),
        r#"{"id":"cloud-plugin","name":"Cloud","runtime_type":"cloud","entry":"ui/index.html"}"#,
    )
    .unwrap();
    fs::create_dir_all(cloud_dir.join("ui")).unwrap();
    fs::write(cloud_dir.join("ui").join("index.html"), "x").unwrap();

    let metas = store.list_plugins();
    let by_id = |id: &str| metas.iter().find(|m| m.id == id).unwrap();
    assert_eq!(by_id("py-plugin").runtime, PluginRuntime::Python);
    assert_eq!(by_id("node-plugin").runtime, PluginRuntime::Nodejs);
    // cloud 归一为 client。
    assert_eq!(by_id("cloud-plugin").runtime, PluginRuntime::Client);
}

#[test]
fn scan_skips_hidden_and_invalid_directory_names() {
    let store = temp_store("scan-skip-invalid");
    // .qianxia 元数据目录（PluginStore 构造时已创建）应被跳过。
    // 含空格的目录名应被跳过。
    let dir = store.plugins_root().join("has space");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("manifest.json"), r#"{"id":"x","name":"x"}"#).unwrap();
    let metas = store.list_plugins();
    // 仅 .qianxia 被跳过 + has space 被跳过 → 应为 0 个插件。
    assert!(metas.iter().all(|m| m.id != "has space"));
    assert!(metas.iter().all(|m| m.id != ".qianxia"));
}

#[test]
fn cleanup_empty_temp_dirs_removes_only_empty() {
    let store = temp_store("cleanup-empty-temp");
    let root = store.plugins_root();
    // temp-empty：空目录（失败残留），应被清理。
    let empty_temp = root.join("temp-1700000000-1");
    fs::create_dir_all(&empty_temp).unwrap();
    // temp-with-file：有文件但无 manifest（AI 写了一半），应保留（由前端引导处理）。
    let partial_temp = root.join("temp-1700000000-2");
    fs::create_dir_all(&partial_temp).unwrap();
    fs::write(partial_temp.join("main.py"), "# half done").unwrap();
    // 正式插件目录：不应被碰。
    let real_plugin = root.join("my-plugin");
    fs::create_dir_all(real_plugin.join("ui")).unwrap();
    fs::write(
        real_plugin.join("manifest.json"),
        r#"{"id":"x","name":"x"}"#,
    )
    .unwrap();

    store.cleanup_empty_temp_dirs();

    assert!(!empty_temp.exists(), "空 temp 目录应被清理");
    assert!(partial_temp.exists(), "有文件的 temp 目录应保留");
    assert!(real_plugin.exists(), "正式插件目录不应被删");
}

#[test]
fn config_roundtrip_custom_root() {
    let store = temp_store("config-roundtrip");
    // 默认 plugins_root = anchor_root（app_data/plugins）。
    assert_eq!(store.plugins_root(), store.anchor_root);
    // 设置自定义路径。
    let custom =
        std::env::temp_dir().join(format!("qianxia-plugin-custom-{}", std::process::id()));
    let _ = fs::remove_dir_all(&custom);
    store
        .write_config(&PluginStoreConfig {
            plugins_root_path: Some(custom.to_string_lossy().to_string()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(store.plugins_root(), custom);
    // 重置为默认（空串 → None）。
    store
        .write_config(&PluginStoreConfig {
            plugins_root_path: None,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(store.plugins_root(), store.anchor_root);
}

#[test]
fn ensure_plugin_dir_creates_and_canonicalizes() {
    let store = temp_store("ensure-dir");
    let canon = store.ensure_plugin_dir("new-plugin").unwrap();
    assert!(canon.is_absolute());
    assert!(canon.exists());
    // data/ 子目录随插件目录一并创建（PRD 需求 4 / AC4）。
    assert!(canon.join("data").is_dir(), "插件 data/ 子目录应被框架创建");
    // 非法 plugin_id 被拒。
    assert!(store.ensure_plugin_dir("../escape").is_err());
}

#[test]
fn read_plugin_file_blocks_traversal() {
    let store = temp_store("read-traversal");
    let canon = store.ensure_plugin_dir("p").unwrap();
    fs::write(canon.join("ui").join("index.html"), "hello").unwrap_or_else(|_| {
        fs::create_dir_all(canon.join("ui")).unwrap();
        fs::write(canon.join("ui").join("index.html"), "hello").unwrap();
    });
    // 合法相对路径读取。
    assert_eq!(
        store.read_plugin_file("p", "ui/index.html").unwrap(),
        "hello"
    );
    // 空路径会解析到插件目录本身，应返回明确错误而不是让 Windows 冒出 os error 5。
    assert!(store
        .read_plugin_file("p", "")
        .unwrap_err()
        .contains("不能为空"));
    // 目录路径不能当文件读取。
    assert!(store
        .read_plugin_file("p", "ui")
        .unwrap_err()
        .contains("不是文件"));
    // 路径穿越被拒（../ 越出插件目录）。
    assert!(store.read_plugin_file("p", "../../etc/passwd").is_err());
    // 不存在文件报错。
    assert!(store.read_plugin_file("p", "nope.html").is_err());
}

#[test]
fn plugin_status_serializes_lowercase() {
    // serde lowercase 对齐前端 PluginStatus 字面量。
    let ready = serde_json::to_string(&PluginStatus::Ready).unwrap();
    assert_eq!(ready, "\"ready\"");
    let running = serde_json::to_string(&PluginStatus::Running).unwrap();
    assert_eq!(running, "\"running\"");
    let stopped = serde_json::to_string(&PluginStatus::Stopped).unwrap();
    assert_eq!(stopped, "\"stopped\"");
}

#[test]
fn plugin_meta_serializes_snake_case() {
    // 前端 LocalPluginStatus 期望 started_at（snake_case），不是 startedAt。
    let meta = PluginMeta {
        id: "x".into(),
        name: "X".into(),
        status: PluginStatus::Running,
        runtime: PluginRuntime::Python,
        entry: "main.py".into(),
        description: String::new(),
        version: "0.0.0".into(),
        pid: Some(42),
        started_at: Some("123Z".into()),
        detail: None,
        icon: None,
        draft: false,
    };
    let json = serde_json::to_string(&meta).unwrap();
    assert!(json.contains("\"started_at\""));
    assert!(json.contains("\"status\":\"running\""));
    assert!(json.contains("\"runtime\":\"python\""));
    // detail 为 None 时应跳过（skip_serializing_if）。
    assert!(!json.contains("\"detail\""));
    // draft 始终序列化（非 Option），前端据此区分草稿/正式插件。
    assert!(json.contains("\"draft\":false"));
}

#[test]
fn write_files_writes_multiple_and_subdirs() {
    let store = temp_store("write-multi");
    let files = vec![
        (
            "manifest.json".to_string(),
            r#"{"id":"x","name":"X"}"#.to_string(),
        ),
        ("ui/index.html".to_string(), "<html></html>".to_string()),
        ("data/config.json".to_string(), "{}".to_string()),
    ];
    store.write_files("my-plugin", &files).unwrap();
    let dir = store.plugin_dir("my-plugin").unwrap();
    assert_eq!(
        fs::read_to_string(dir.join("manifest.json")).unwrap(),
        r#"{"id":"x","name":"X"}"#
    );
    assert_eq!(
        fs::read_to_string(dir.join("ui").join("index.html")).unwrap(),
        "<html></html>"
    );
    assert_eq!(
        fs::read_to_string(dir.join("data").join("config.json")).unwrap(),
        "{}"
    );
}

#[test]
fn write_files_overwrites_existing() {
    let store = temp_store("write-overwrite");
    store
        .write_files("p", &[("a.txt".to_string(), "v1".to_string())])
        .unwrap();
    // 再写覆盖。
    store
        .write_files("p", &[("a.txt".to_string(), "v2".to_string())])
        .unwrap();
    let dir = store.plugin_dir("p").unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "v2");
}

#[test]
fn write_files_rejects_traversal_path() {
    let store = temp_store("write-traversal");
    // ../escape 应被段级白名单拒绝（防越出 plugin_dir）。
    let err = store
        .write_files("p", &[("../escape.txt".to_string(), "x".to_string())])
        .unwrap_err();
    assert!(err.contains("非法") || err.contains(".."));
}

#[test]
fn write_files_rejects_absolute_path() {
    let store = temp_store("write-absolute");
    let err = store
        .write_files("p", &[("/etc/passwd".to_string(), "x".to_string())])
        .unwrap_err();
    assert!(err.contains("非法"));
}

// === 二进制读写（.qplugin v3 导入/导出路径）===

#[test]
fn write_file_bytes_writes_binary_content() {
    let store = temp_store("write-bytes");
    // 非 UTF-8 字节序列（模拟字体/图片二进制）：0x89 PNG 头 + 任意字节。
    let bytes: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe];
    store
        .write_file_bytes("p", "assets/icon.png", bytes)
        .unwrap();
    let dir = store.plugin_dir("p").unwrap();
    let written = fs::read(dir.join("assets").join("icon.png")).unwrap();
    assert_eq!(written, bytes);
}

#[test]
fn write_file_bytes_creates_subdirs() {
    let store = temp_store("write-bytes-subdir");
    store
        .write_file_bytes("p", "vendor/x/y/font.ttf", b"abc")
        .unwrap();
    let dir = store.plugin_dir("p").unwrap();
    assert_eq!(
        fs::read(dir.join("vendor").join("x").join("y").join("font.ttf")).unwrap(),
        b"abc"
    );
}

#[test]
fn write_file_bytes_rejects_traversal_path() {
    let store = temp_store("write-bytes-traversal");
    let err = store
        .write_file_bytes("p", "../escape.bin", b"x")
        .unwrap_err();
    assert!(err.contains("非法") || err.contains(".."));
}

#[test]
fn write_file_bytes_rejects_absolute_path() {
    let store = temp_store("write-bytes-absolute");
    let err = store
        .write_file_bytes("p", "C:/escape.bin", b"x")
        .unwrap_err();
    assert!(err.contains("非法"));
}

#[test]
fn read_plugin_file_bytes_roundtrips_binary() {
    let store = temp_store("read-bytes");
    let bytes: &[u8] = &[0x00, 0x01, 0x02, 0xff, 0xfe, 0x89];
    store.write_file_bytes("p", "bin.dat", bytes).unwrap();
    // 读回应为 base64 编码。
    let b64 = store.read_plugin_file_bytes("p", "bin.dat").unwrap();
    use base64::{engine::general_purpose, Engine as _};
    let decoded = general_purpose::STANDARD.decode(b64).unwrap();
    assert_eq!(decoded, bytes);
}

#[test]
fn read_plugin_file_bytes_rejects_traversal() {
    let store = temp_store("read-bytes-traversal");
    store.write_file_bytes("p", "ok.bin", b"x").unwrap();
    let err = store.read_plugin_file_bytes("p", "../escape").unwrap_err();
    assert!(err.contains("非法") || err.contains("不存在"));
}
