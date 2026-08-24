use super::*;
#[cfg(windows)]
use crate::process_util::find_binary;

#[test]
fn venv_python_path_is_platform_correct() {
    let venv = PathBuf::from("/tmp/.venv");
    let py = venv_python(&venv);
    #[cfg(windows)]
    assert!(py.to_string_lossy().contains("Scripts"));
    #[cfg(not(windows))]
    assert!(py.ends_with("bin/python"));
}

#[test]
fn python_venv_dir_is_stable_for_same_plugin_path() {
    let plugin = PathBuf::from(
        r"C:\Users\Administrator\AppData\Roaming\com.lingfang.desktop\plugins\plugin-a",
    );
    assert_eq!(python_venv_dir(&plugin), python_venv_dir(&plugin));
}

#[test]
fn python_venv_dir_uses_short_cache_on_windows() {
    let plugin = PathBuf::from(
        r"C:\Users\Administrator\AppData\Roaming\com.lingfang.desktop\plugins\plugin-a",
    );
    let venv = python_venv_dir(&plugin);
    #[cfg(windows)]
    {
        assert!(
            !venv.starts_with(&plugin),
            "Windows venv should avoid deep plugin paths"
        );
        assert!(venv.to_string_lossy().contains("python-venvs"));
    }
    #[cfg(not(windows))]
    assert_eq!(venv, plugin.join(".venv"));
}

#[test]
fn parse_manifest_python_defaults_entry() {
    // manifest 缺 entry 时，python 默认 main.py，nodejs 默认 index.js。
    let tmp = temp_dir_unique("manifest-py");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("manifest.json"),
        r#"{"runtime_type":"python","name":"x"}"#,
    )
    .unwrap();
    let m = parse_manifest(&tmp).expect("解析应成功");
    assert_eq!(m.runtime, PluginRuntimeKind::Python);
    assert_eq!(m.entry, "main.py");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn parse_manifest_nodejs_explicit_entry() {
    let tmp = temp_dir_unique("manifest-node");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("manifest.json"),
        r#"{"runtime_type":"nodejs","entry":"src/index.js"}"#,
    )
    .unwrap();
    let m = parse_manifest(&tmp).expect("解析应成功");
    assert_eq!(m.runtime, PluginRuntimeKind::Nodejs);
    assert_eq!(m.entry, "src/index.js");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn parse_manifest_rejects_client_runtime() {
    // client（HTML）不支持独立进程运行（前端 iframe 分流）。
    let tmp = temp_dir_unique("manifest-client");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(tmp.join("manifest.json"), r#"{"runtime_type":"client"}"#).unwrap();
    assert!(parse_manifest(&tmp).is_err());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn parse_manifest_rejects_missing_file() {
    let tmp = temp_dir_unique("manifest-missing");
    std::fs::create_dir_all(&tmp).unwrap();
    // 文件不存在返回 manifest_missing: 前缀（前端据此引导重新生成，而非裸 os error 2）。
    let err = parse_manifest(&tmp).unwrap_err();
    assert!(
        err.starts_with("manifest_missing:"),
        "缺 manifest 应返回 manifest_missing 前缀，实际：{err}"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn parse_manifest_rejects_invalid_json() {
    let tmp = temp_dir_unique("manifest-badjson");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(tmp.join("manifest.json"), "{not valid json").unwrap();
    assert!(parse_manifest(&tmp).is_err());
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn minimal_env_excludes_sensitive_keys() {
    // 白名单不应含 TOKEN/KEY/SECRET/LINGFANG_ 前缀（防泄漏）。
    let env = minimal_env();
    let keys: Vec<_> = env
        .iter()
        .map(|(k, _)| k.to_string_lossy().to_string())
        .collect();
    for k in &keys {
        let upper = k.to_uppercase();
        assert!(!upper.contains("TOKEN"), "minimal_env 不应含 TOKEN：{k}");
        assert!(!upper.contains("SECRET"), "minimal_env 不应含 SECRET：{k}");
        assert!(
            !upper.contains("LINGFANG"),
            "minimal_env 不应含 LINGFANG_：{k}"
        );
    }
}

#[test]
fn bundled_pip_wheel_dir_prefers_ensurepip_bundled() {
    let python_dir = temp_dir_unique("pip-wheel-dir");
    let bundled = python_dir.join("Lib").join("ensurepip").join("_bundled");
    std::fs::create_dir_all(&bundled).unwrap();
    std::fs::write(bundled.join("pip-25.0.1-py3-none-any.whl"), "").unwrap();
    std::fs::write(python_dir.join("pip-older.whl"), "").unwrap();

    let runtime = RuntimeResolver::from_dirs(Some(python_dir.clone()), None);
    assert_eq!(bundled_pip_wheel_dir(&runtime), Some(bundled));

    let _ = std::fs::remove_dir_all(&python_dir);
}

#[test]
fn bundled_pip_wheel_dir_falls_back_to_python_root() {
    let python_dir = temp_dir_unique("pip-wheel-root");
    std::fs::create_dir_all(&python_dir).unwrap();
    std::fs::write(python_dir.join("pip-25.0.1-py3-none-any.whl"), "").unwrap();

    let runtime = RuntimeResolver::from_dirs(Some(python_dir.clone()), None);
    assert_eq!(bundled_pip_wheel_dir(&runtime), Some(python_dir.clone()));

    let _ = std::fs::remove_dir_all(&python_dir);
}

#[test]
fn contains_pip_wheel_ignores_non_pip_wheels() {
    let root = temp_dir_unique("pip-wheel-missing");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("setuptools-1.0.0-py3-none-any.whl"), "").unwrap();

    assert!(!contains_pip_wheel(&root));

    let _ = std::fs::remove_dir_all(&root);
}

/// `resolve_requirements_install_command`：应用内置 uv 时走 `uv pip install --python`。
/// 锁定契约：requirements.txt 装依赖首选 uv（快、缓存复用），命中后命令形状必须稳定。
#[test]
fn resolve_requirements_install_uses_uv_when_bundled() {
    let python_dir = temp_dir_unique("req-install-uv");
    std::fs::create_dir_all(&python_dir).unwrap();
    // 让 runtime.uv() 命中：在 python_dir 下放一个匹配平台的 uv 可执行文件（空文件即可，只看 is_file）。
    #[cfg(windows)]
    std::fs::write(python_dir.join("uv.exe"), "").unwrap();
    #[cfg(not(windows))]
    std::fs::write(python_dir.join("bin").join("uv"), b"").map(|_| ()).unwrap_or_else(|_| {
        std::fs::create_dir_all(python_dir.join("bin")).unwrap();
        std::fs::write(python_dir.join("bin").join("uv"), "").unwrap()
    });
    let runtime = RuntimeResolver::from_dirs(Some(python_dir.clone()), None);

    let venv = python_venv_dir(&python_dir);
    let py = venv_python(&venv);
    let requirements = python_dir.join("requirements.txt");
    let (program, args) = resolve_requirements_install_command(&runtime, &py, &requirements);

    // 命中的就是 uv 路径（与 runtime.uv() 一致），命令形状：pip install --python <venv> -r <req>。
    assert_eq!(program, runtime.uv().unwrap());
    assert_eq!(
        args,
        vec![
            "pip".to_string(),
            "install".to_string(),
            "--python".to_string(),
            py.to_string_lossy().to_string(),
            "-r".to_string(),
            requirements.to_string_lossy().to_string(),
        ]
    );

    let _ = std::fs::remove_dir_all(&python_dir);
}

/// `resolve_requirements_install_command`：应用未随 uv 时回退 `<venv-python> -m pip install`。
/// 这是当前 Windows 制品的实际路径（uv 未打包），也是修复「插件包含 requirements.txt，但应用运行时缺少 uv」
/// 死锁的关键契约——requirements.txt 必须能装，不能像 uv.lock 那样因缺 uv 直接报错。
#[test]
fn resolve_requirements_install_falls_back_to_pip_when_uv_missing() {
    let python_dir = temp_dir_unique("req-install-no-uv");
    std::fs::create_dir_all(&python_dir).unwrap();
    // 不放任何 uv 文件 → runtime.uv() 返回 None（与当前 Windows 制品一致）。
    let runtime = RuntimeResolver::from_dirs(Some(python_dir.clone()), None);
    assert!(runtime.uv().is_none());

    let venv = python_venv_dir(&python_dir);
    let py = venv_python(&venv);
    let requirements = python_dir.join("requirements.txt");
    let (program, args) = resolve_requirements_install_command(&runtime, &py, &requirements);

    // 回退到 venv python -m pip install --no-input -r ...（venv 由 create_python_venv 建好并带 pip）。
    assert_eq!(program, py);
    assert_eq!(
        args,
        vec![
            "-m".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "--no-input".to_string(),
            "-r".to_string(),
            requirements.to_string_lossy().to_string(),
        ]
    );

    let _ = std::fs::remove_dir_all(&python_dir);
}

#[test]
fn process_table_register_and_is_running() {
    // 注册一个会立即退出的进程（true/exit 0），验证 is_running 在退出后返回 None 且自动清表。
    let table = PluginProcessTable::new();
    #[cfg(unix)]
    let mut cmd = {
        use std::os::unix::process::CommandExt;
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg("true");
        unsafe {
            c.pre_exec(|| {
                libc_setsid();
                Ok(())
            });
        }
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg("exit 0");
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        c.creation_flags(CREATE_NEW_PROCESS_GROUP);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().expect("测试进程应能 spawn");
    let (pid, _arc) = table.register_with_handle("test-plugin", child, SandboxHandle::default(), "1000Z".to_string());
    assert!(pid > 0, "注册应返回有效 pid");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while table.is_running("test-plugin").is_some() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(
        table.is_running("test-plugin").is_none(),
        "进程退出后 is_running 应返回 None 并清表"
    );
}

#[test]
fn process_table_stop_plugin_kills_running_process() {
    let _guard = crate::process_util::process_tree_test_lock();
    // take + kill_child_tree 应能杀掉一个运行中的长进程。
    let table = PluginProcessTable::new();
    #[cfg(unix)]
    let mut cmd = {
        use std::os::unix::process::CommandExt;
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg("sleep 30");
        unsafe {
            c.pre_exec(|| {
                libc_setsid();
                Ok(())
            });
        }
        c
    };
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let node = match find_binary("node") {
            Some(binary) => binary,
            None => {
                eprintln!("[skip] 宿主无 node，跳过进程停止测试");
                return;
            }
        };
        let mut c = std::process::Command::new(node);
        c.args(["-e", "setInterval(() => {}, 1000)"]);
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        c.creation_flags(CREATE_NEW_PROCESS_GROUP);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().expect("测试长进程应能 spawn");
    let (_pid, _arc) = table.register_with_handle("long-plugin", child, SandboxHandle::default(), "2000Z".to_string());
    // 取出并杀。
    let (mut killed_child, _sandbox, _session_key) = table.take("long-plugin").expect("应能取出注册的进程");
    let started = std::time::Instant::now();
    kill_child_tree(&killed_child);
    let _ = killed_child.kill();
    let _status = killed_child.wait().expect("wait 应能回收");
    const STOP_TEST_TIMEOUT_MS: u128 = 3_000;
    let elapsed = started.elapsed().as_millis();
    assert!(
        elapsed < STOP_TEST_TIMEOUT_MS,
        "停止长进程耗时异常：{elapsed}ms"
    );
    // 二次 take 应 None（已取出）。
    assert!(
        table.take("long-plugin").is_none(),
        "已 take 的进程不应再可取"
    );
}

#[test]
fn process_table_take_nonexistent_returns_none() {
    let table = PluginProcessTable::new();
    assert!(table.take("ghost").is_none());
    assert!(!table.is_running("ghost").is_some());
}

/// 生成唯一临时目录名（避免并发测试冲突）。
fn temp_dir_unique(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "lf-runner-{prefix}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

/// 端到端集成测试：用真实内置 Python（LINGFANG_EMBEDDED_RUNTIME_DIR）跑 ensure_python_venv，
/// 验证 requirements.txt 在无 uv 时回退 venv python -m pip install 真的能装上依赖。
///
/// 标 `#[ignore]`：需要内置 runtimes + 网络（清华 PyPI 镜像），不进默认 `cargo test`。
/// 手动跑：`LINGFANG_EMBEDDED_RUNTIME_DIR=... cargo test -p lingfang-desktop ensure_python_venv_installs_requirements_without_uv -- --ignored --nocapture`
#[test]
#[ignore]
fn ensure_python_venv_installs_requirements_without_uv() {
    let python_root = std::env::var_os("LINGFANG_EMBEDDED_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // 兜底：开发机内置 runtimes 目录（apps/desktop/runtimes）。
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("runtimes")
        });
    let python_dir = python_root.join("python");
    let python_exe = python_dir.join("python.exe");
    if !python_exe.is_file() {
        panic!(
            "内置 Python 不存在：{}（设 LINGFANG_EMBEDDED_RUNTIME_DIR 指向 runtimes 目录）",
            python_exe.display()
        );
    }
    let runtime = RuntimeResolver::from_dirs(Some(python_dir.clone()), None);
    // 契约前置：内置 runtimes 不带 uv（否则本测试场景不成立）。
    assert!(
        runtime.uv().is_none(),
        "本测试要求内置 runtimes 无 uv，但 uv() 命中了 {:?}",
        runtime.uv()
    );

    // 临时插件目录：requirements.txt + main.py。
    let plugin_dir = temp_dir_unique("req-e2e");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::write(
        plugin_dir.join("requirements.txt"),
        "requests==2.32.3\n",
    )
    .unwrap();
    std::fs::write(
        plugin_dir.join("main.py"),
        "import requests\nprint('requests', requests.__version__)\n",
    )
    .unwrap();

    // 这一步在旧二进制（缺 uv）上会返回 Err「插件包含 requirements.txt，但应用运行时缺少 uv」。
    // 修复后应返回 venv python 路径（venv 创建 + pip install 成功 + 冒烟通过）。
    let result = ensure_python_venv(&runtime, &plugin_dir, None);
    let py_path = result.expect("ensure_python_venv 应在无 uv 时回退 pip 安装成功");

    // 返回的是 venv 内 python，应真实存在。
    assert!(
        py_path.is_file(),
        "返回的 venv python 不存在：{}",
        py_path.display()
    );
    // .lfdeps-verified 标记应已写入（冒烟通过）。
    assert!(
        python_venv_dir(&plugin_dir).join(".lfdeps-verified").is_file(),
        "依赖已装但未写 .lfdeps-verified 标记"
    );

    // 用 venv python 执行 main.py，确认依赖真能 import。
    let out = std::process::Command::new(&py_path)
        .arg(plugin_dir.join("main.py"))
        .output()
        .expect("跑 venv python 失败");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "main.py 非零退出：{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        stdout.contains("requests 2.32.3"),
        "requests 未正确 import，stdout={stdout}"
    );

    let _ = std::fs::remove_dir_all(&plugin_dir);
    let _ = std::fs::remove_dir_all(python_venv_dir(&plugin_dir));
}

// === delete_plugin_dir 测试 ===

/// 构造临时 PluginStore（anchor_root 在 temp_dir 下，隔离测试）。
fn temp_store_for_delete(name: &str) -> PluginStore {
    let root = std::env::temp_dir().join(format!(
        "lf-runner-delete-{name}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&root);
    PluginStore::new(&root).expect("PluginStore 构造应成功")
}

#[test]
fn delete_plugin_dir_removes_existing_directory() {
    let store = temp_store_for_delete("existing");
    let id = "my-plugin";
    let dir = store.ensure_plugin_dir(id).unwrap();
    std::fs::write(dir.join("manifest.json"), r#"{"id":"x","name":"x"}"#).unwrap();
    let table = PluginProcessTable::new();

    delete_plugin_dir(&store, &table, id).unwrap();

    assert!(!dir.exists(), "插件目录应被删除");
}

#[test]
fn delete_plugin_dir_nonexistent_is_idempotent() {
    let store = temp_store_for_delete("missing");
    let table = PluginProcessTable::new();
    // 不存在的 plugin_id 删除应幂等成功（不报错）。
    delete_plugin_dir(&store, &table, "never-existed").unwrap();
}

#[test]
fn delete_plugin_dir_rejects_traversal_id() {
    let store = temp_store_for_delete("traversal");
    let table = PluginProcessTable::new();
    // 穿越 plugin_id 被 sanitize_plugin_id 拒绝（防 ../ 越出 plugins_root）。
    let err = delete_plugin_dir(&store, &table, "../escape").unwrap_err();
    assert!(err.contains("plugin_id") || err.contains("非法") || err.contains("不合法"));
}

// === wait_for_crash 测试 ===

#[test]
fn wait_for_crash_detects_immediate_exit() {
    // 秒退进程：cmd /c exit 1（Windows）/ sh -c "exit 1"（Unix），立即退出。
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/c", "exit 1"]).stderr(Stdio::piped());
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", "exit 1"]).stderr(Stdio::piped());
        c
    };
    let mut child = cmd.spawn().expect("spawn 测试进程应成功");
    let result = wait_for_crash(&mut child, Duration::from_millis(500));
    assert!(result.is_some(), "秒退进程应被检测为崩溃");
    let err = result.unwrap();
    assert!(
        err.starts_with("plugin_crashed:"),
        "崩溃错误应含 plugin_crashed: 前缀"
    );
}

#[test]
fn wait_for_crash_returns_none_for_long_running() {
    let _guard = crate::process_util::process_tree_test_lock();
    // 存活进程：sleep 10（不会在 500ms 内退出）。
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/c", "ping -n 10 127.0.0.1 > nul"])
            .stderr(Stdio::piped());
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", "sleep 10"]).stderr(Stdio::piped());
        c
    };
    let mut child = cmd.spawn().expect("spawn 测试进程应成功");
    let result = wait_for_crash(&mut child, Duration::from_millis(300));
    assert!(result.is_none(), "存活进程不应判为崩溃");
    // 清理测试进程。
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn truncate_stderr_long_text_is_cut() {
    let long = "x".repeat(3000);
    let t = truncate_stderr(&long, 100);
    assert!(t.contains("已截断"), "超长 stderr 应截断并标注");
    assert!(t.chars().count() < long.chars().count());
}

// entry_arg：Windows canonicalize 产生的 `\\?\` 扩展长度前缀必须被 strip 掉，
// 否则作为 node/python 子进程参数会致 node 在 run_main 阶段 lstat 失败崩溃。
#[test]
fn entry_arg_strips_verbatim_prefix() {
    // 模拟 Windows canonicalize 结果（跨平台构造字符串路径校验 strip 逻辑）。
    let verbatim = PathBuf::from(r"\\?\C:\Users\dev\plugin\index.js");
    assert_eq!(entry_arg(&verbatim), r"C:\Users\dev\plugin\index.js");
    // 无前缀的普通路径保持不变。
    let normal = PathBuf::from(r"C:\Users\dev\plugin\index.js");
    assert_eq!(entry_arg(&normal), r"C:\Users\dev\plugin\index.js");
    // 非 Windows 路径不受影响。
    let unix = PathBuf::from("/home/dev/plugin/index.js");
    assert_eq!(entry_arg(&unix), "/home/dev/plugin/index.js");
}

// === Playwright 依赖检测测试 ===
//
// 这些测试覆盖「是否需要内置浏览器」的判定，不执行任何网络下载。

#[test]
fn declares_playwright_node_package_json() {
    // dependencies 里有 playwright → 命中。
    let tmp = temp_dir_unique("pw-node-yes");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("package.json"),
        r#"{"dependencies":{"playwright":"^1.40.0","express":"^4.0.0"}}"#,
    )
    .unwrap();
    assert!(declares_playwright(&tmp));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn declares_playwright_node_core_and_test_variants() {
    // playwright-core / @playwright/test 也算（都附带 cli，会触发 launch）。
    let tmp = temp_dir_unique("pw-node-core");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("package.json"),
        r#"{"devDependencies":{"@playwright/test":"^1.40.0"}}"#,
    )
    .unwrap();
    assert!(declares_playwright(&tmp));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn declares_playwright_node_absent() {
    // 无 playwright 依赖（仅其它包）→ 不命中，不要求浏览器文件。
    let tmp = temp_dir_unique("pw-node-no");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("package.json"),
        r#"{"dependencies":{"express":"^4.0.0","lodash":"^4.17.0"}}"#,
    )
    .unwrap();
    assert!(!declares_playwright(&tmp));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn declares_playwright_python_requirements() {
    // requirements.txt 含 playwright（容忍版本约束 / 注释 / 多行）。
    let tmp = temp_dir_unique("pw-py-yes");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("requirements.txt"),
        "requests==2.31.0\nplaywright>=1.40\n# playwright-core 不是 pip 包名，忽略\n",
    )
    .unwrap();
    assert!(declares_playwright(&tmp));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn declares_playwright_python_absent() {
    // requirements.txt 无 playwright → 不命中。
    let tmp = temp_dir_unique("pw-py-no");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("requirements.txt"),
        "requests==2.31.0\nbeautifulsoup4\n",
    )
    .unwrap();
    assert!(!declares_playwright(&tmp));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn declares_playwright_empty_dir() {
    // 无 package.json / requirements.txt → 不命中（裸脚本插件）。
    let tmp = temp_dir_unique("pw-empty");
    std::fs::create_dir_all(&tmp).unwrap();
    assert!(!declares_playwright(&tmp));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn playwright_requires_bundled_full_and_headless_revision() {
    let plugin = temp_dir_unique("pw-bundled-plugin");
    let root = temp_dir_unique("pw-bundled-runtime");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(
        plugin.join("package.json"),
        r#"{"dependencies":{"playwright":"1.61.1"}}"#,
    )
    .unwrap();
    let browsers = root.join("chromium/ms-playwright");
    let revision = crate::runtime_resolver::PLAYWRIGHT_CHROMIUM_REVISION;
    let chrome = browsers
        .join(format!("chromium-{revision}"))
        .join("chrome-win64/chrome.exe");
    let headless = browsers
        .join(format!("chromium_headless_shell-{revision}"))
        .join("chrome-headless-shell-win64/chrome-headless-shell.exe");
    std::fs::create_dir_all(chrome.parent().unwrap()).unwrap();
    std::fs::create_dir_all(headless.parent().unwrap()).unwrap();
    std::fs::write(&chrome, b"fake").unwrap();
    let runtime = RuntimeResolver::from_root(root.clone());
    assert!(ensure_playwright_browsers(&runtime, &plugin, None).is_err());
    std::fs::write(&headless, b"fake").unwrap();
    assert!(ensure_playwright_browsers(&runtime, &plugin, None).is_ok());
    let _ = std::fs::remove_dir_all(plugin);
    let _ = std::fs::remove_dir_all(root);
}

// === 路径清理测试 ===

#[test]
fn strip_verbatim_prefix_removes_prefix() {
    assert_eq!(
        strip_verbatim_prefix(r"\\?\C:\Users\test\plugin"),
        r"C:\Users\test\plugin"
    );
    // 无前缀不变。
    assert_eq!(
        strip_verbatim_prefix(r"C:\Users\test\plugin"),
        r"C:\Users\test\plugin"
    );
    assert_eq!(
        strip_verbatim_prefix("/home/user/plugin"),
        "/home/user/plugin"
    );
}

// === venv 自愈冒烟测试 ===

#[test]
fn parse_requirements_dist_names_basic() {
    let content = "\
requests>=2.28
pillow>=10.0.0,<12
# 注释行
streamlit==1.40.0

-r other.txt
uvicorn[standard]>=0.32.0
git+https://github.com/x/y.git
-e ./local-pkg
";
    let names = parse_requirements_dist_names(content);
    assert_eq!(names, vec!["requests", "pillow", "streamlit", "uvicorn"]);
}

#[test]
fn parse_requirements_dist_names_skips_options_and_urls() {
    let content = "\
--index-url https://pypi.org/simple
-c constraints.txt
numpy
scipy @ git+https://github.com/scipy/scipy.git
";
    let names = parse_requirements_dist_names(content);
    // git+URL 行（含 ://）跳过，--option / -c 跳过，只留 numpy。
    assert_eq!(names, vec!["numpy"]);
}

#[test]
fn parse_requirements_dist_names_empty() {
    assert!(parse_requirements_dist_names("").is_empty());
    assert!(parse_requirements_dist_names("# just a comment\n\n").is_empty());
}

#[test]
fn dist_to_import_name_known_mappings() {
    assert_eq!(dist_to_import_name("pillow"), Some("PIL"));
    assert_eq!(dist_to_import_name("Pillow"), Some("PIL"));
    assert_eq!(dist_to_import_name("opencv-python"), Some("cv2"));
    assert_eq!(dist_to_import_name("opencv-python-headless"), Some("cv2"));
    assert_eq!(dist_to_import_name("pyyaml"), Some("yaml"));
    assert_eq!(dist_to_import_name("beautifulsoup4"), Some("bs4"));
    assert_eq!(dist_to_import_name("scikit-learn"), Some("sklearn"));
}

#[test]
fn dist_to_import_name_unknown_returns_none() {
    assert_eq!(dist_to_import_name("requests"), None);
    assert_eq!(dist_to_import_name("streamlit"), None);
}

#[test]
fn normalize_import_name_strips_version_and_replaces_separators() {
    assert_eq!(normalize_import_name("python-magic"), "python_magic");
    assert_eq!(normalize_import_name("google.api"), "google_api");
    assert_eq!(normalize_import_name("streamlit"), "streamlit");
}

#[test]
fn smoke_import_names_uses_known_mapping_then_normalization() {
    let dists = vec![
        "pillow".to_string(),
        "streamlit".to_string(),
        "fastapi-cli".to_string(),
        "opencv-python".to_string(),
    ];
    let imports = smoke_import_names(&dists);
    // PIL（映射）、cv2（映射）、streamlit（标准化原样）、fastapi_cli（标准化 -→_）。
    assert!(imports.contains(&"PIL".to_string()));
    assert!(imports.contains(&"cv2".to_string()));
    assert!(imports.contains(&"streamlit".to_string()));
    assert!(imports.contains(&"fastapi_cli".to_string()));
}

#[test]
fn smoke_import_names_dedup_and_sorted() {
    let dists = vec!["zlib".to_string(), "abc".to_string(), "abc".to_string()];
    let imports = smoke_import_names(&dists);
    assert_eq!(imports, vec!["abc".to_string(), "zlib".to_string()]);
}

#[test]
fn deps_fingerprint_is_deterministic_and_content_sensitive() {
    let a = deps_fingerprint("pillow\nstreamlit");
    let a2 = deps_fingerprint("pillow\nstreamlit");
    let b = deps_fingerprint("pillow\nstreamlit\nrequests");
    assert_eq!(a, a2, "相同内容应相同");
    assert_ne!(a, b, "内容变了指纹应变");
}

#[test]
fn deps_verified_marker_round_trip() {
    let tmp = temp_dir_unique("deps-marker");
    std::fs::create_dir_all(&tmp).unwrap();
    let content = "pillow>=10\nstreamlit";
    // 初始无标记 → 不命中。
    assert!(!deps_verified_matches(&tmp, content));
    // 写标记后 → 命中。
    write_deps_verified(&tmp, content);
    assert!(deps_verified_matches(&tmp, content));
    // 内容变了 → 标记失效。
    assert!(!deps_verified_matches(&tmp, "pillow>=10\nstreamlit\nnumpy"));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn build_smoke_script_contains_import_names_and_exit_codes() {
    let imports = vec!["PIL".to_string(), "streamlit".to_string()];
    let script = build_smoke_script(&imports);
    // 脚本应包含两个 import 名。
    assert!(script.contains("\"PIL\""));
    assert!(script.contains("\"streamlit\""));
    // 损坏退出码 2，干净退出码 0。
    assert!(script.contains("sys.exit(2)"));
    assert!(script.contains("sys.exit(0)"));
    // 逐个 import（不一次全 import）。
    assert!(script.contains("importlib.import_module"));
}

#[test]
fn write_crash_dump_contains_repro_command_and_env_and_output() {
    let tmp = temp_dir_unique("crash-dump");
    std::fs::create_dir_all(&tmp).unwrap();
    let env_dump = vec![
        "PATH=/usr/bin".to_string(),
        "LINGFANG_PLUGIN_BRIDGE_TOKEN=<hidden>".to_string(),
    ];
    write_crash_dump(
        &tmp,
        "python -u main.py",
        "/tmp/plugin",
        &env_dump,
        "plugin_crashed:插件启动后立即退出（exit code: 1）",
        "Traceback: ImportError: No module named foo",
    );
    let content = std::fs::read_to_string(crash_log_path(&tmp)).unwrap();
    // 含复现命令。
    assert!(content.contains("python -u main.py"), "转储应含复现命令");
    // 含 cwd。
    assert!(content.contains("/tmp/plugin"));
    // 含 env（脱敏 token）。
    assert!(content.contains("PATH=/usr/bin"));
    assert!(content.contains("LINGFANG_PLUGIN_BRIDGE_TOKEN=<hidden>"));
    // 含进程输出。
    assert!(content.contains("Traceback: ImportError"));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn write_crash_dump_notes_empty_output() {
    let tmp = temp_dir_unique("crash-empty");
    std::fs::create_dir_all(&tmp).unwrap();
    write_crash_dump(&tmp, "py main.py", "/p", &[], "crash err", "");
    let content = std::fs::read_to_string(crash_log_path(&tmp)).unwrap();
    // 空输出时应有提示（帮助定位「PS 未运行 / 解释器损坏」）。
    assert!(content.contains("空"), "空输出应有诊断提示");
    let _ = std::fs::remove_dir_all(&tmp);
}

// === 开发态文件监听测试 ===

#[test]
fn process_table_new_has_empty_dev_watchers() {
    // PluginProcessTable::new() 必须初始化 dev_watchers 为空（无监听器泄漏）。
    let table = PluginProcessTable::new();
    let map = table.dev_watchers.lock().unwrap();
    assert!(
        map.is_empty(),
        "新建进程表不应有任何开发态监听器"
    );
}

#[test]
fn stop_dev_watch_is_noop_for_unknown_id() {
    // 对未知 installation_id 调用 stop_dev_watch 不应 panic / 不应插入条目。
    let table = PluginProcessTable::new();
    stop_dev_watch(&table, "no-such-watch");
    let map = table.dev_watchers.lock().unwrap();
    assert!(map.is_empty(), "stop 未知监听器后表应仍为空");
}

// peek_runtime_type：缺 manifest 时默认 client，存在时读取 runtime_type。
#[test]
fn peek_runtime_type_defaults_to_client() {
    let tmp = temp_dir_unique("peek-none");
    std::fs::create_dir_all(&tmp).unwrap();
    // 目录无 manifest.json → 默认 client。
    assert_eq!(peek_runtime_type(&tmp), "client");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn peek_runtime_type_reads_from_manifest() {
    let tmp = temp_dir_unique("peek-node");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(tmp.join("manifest.json"), r#"{"runtime_type":"nodejs"}"#).unwrap();
    assert_eq!(peek_runtime_type(&tmp), "nodejs");
    let _ = std::fs::remove_dir_all(&tmp);
}
