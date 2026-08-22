use super::*;
use crate::process_util::find_binary;

fn rel(path: &str) -> PathBuf {
    sanitize_rel_path(path).expect("合法相对路径应通过")
}

// === H1/H2/H4 修复测试：runtime_env 按 runtime 注入专属环境变量 ===

#[test]
fn runtime_env_python_adds_utf8_and_pythonpath() {
    // Python 必须注入 PYTHONIOENCODING=utf-8 + PYTHONUTF8=1（H2 防 Windows 中文乱码）
    // + PYTHONPATH=<workspace>（H4 多文件相对 import）。
    let env = runtime_env(ScriptRuntime::Python, "/sandbox/root", vec![]);
    let keys: Vec<_> = env
        .iter()
        .map(|(k, _)| k.to_string_lossy().to_string())
        .collect();
    assert!(
        keys.iter().any(|k| k == "PYTHONIOENCODING"),
        "缺 PYTHONIOENCODING"
    );
    assert!(keys.iter().any(|k| k == "PYTHONUTF8"), "缺 PYTHONUTF8");
    assert!(keys.iter().any(|k| k == "PYTHONPATH"), "缺 PYTHONPATH");
    // 值校验。
    let get = |key: &str| {
        env.iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.to_string_lossy().to_string())
    };
    assert_eq!(get("PYTHONIOENCODING").as_deref(), Some("utf-8"));
    assert_eq!(get("PYTHONUTF8").as_deref(), Some("1"));
    assert_eq!(get("PYTHONPATH").as_deref(), Some("/sandbox/root"));
}

#[test]
fn runtime_env_nodejs_does_not_add_python_vars() {
    // Node.js 不注入 Python 专属变量（避免污染）。
    let env = runtime_env(ScriptRuntime::Nodejs, "/sandbox", vec![]);
    let keys: Vec<_> = env
        .iter()
        .map(|(k, _)| k.to_string_lossy().to_string())
        .collect();
    assert!(!keys
        .iter()
        .any(|k| k == "PYTHONIOENCODING" || k == "PYTHONUTF8" || k == "PYTHONPATH"));
}

#[test]
fn runtime_env_preserves_base_env() {
    // base env 的现有项必须保留（追加不替换）。
    let base = vec![(OsString::from("PATH"), OsString::from("/usr/bin"))];
    let env = runtime_env(ScriptRuntime::Python, "/ws", base);
    assert!(env.iter().any(|(k, v)| k == "PATH" && v == "/usr/bin"));
}

#[test]
fn sanitize_accepts_normal_relative_path() {
    assert_eq!(rel("src/index.js"), PathBuf::from("src/index.js"));
    assert_eq!(rel("main.py"), PathBuf::from("main.py"));
}

#[test]
fn sanitize_rejects_absolute_paths() {
    assert!(sanitize_rel_path("/etc/passwd").is_err());
    assert!(sanitize_rel_path("~/x").is_err());
    assert!(sanitize_rel_path("C:/evil").is_err());
}

#[test]
fn sanitize_rejects_traversal_and_hidden() {
    assert!(sanitize_rel_path("../escape.js").is_err());
    assert!(sanitize_rel_path("a/../b").is_err());
    assert!(sanitize_rel_path(".env").is_err());
    assert!(sanitize_rel_path("a//b").is_err());
}

#[test]
fn materialize_writes_files_and_detects_escape() {
    let tmp = std::env::temp_dir().join(format!(
        "lf-plugin-script-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let files = vec![
        ScriptFile {
            path: "main.py".to_string(),
            content: "print('ok')".to_string(),
        },
        ScriptFile {
            path: "lib/util.py".to_string(),
            content: "# helper".to_string(),
        },
    ];
    let (sandbox, entry) =
        materialize_sandbox(&tmp, "test-plugin", &files, "main.py").expect("落盘成功");
    assert!(entry.starts_with(&sandbox));
    assert!(entry.is_file());
    assert!(sandbox.join("lib").join("util.py").is_file());

    // entry 指向不存在文件应报错（canonicalize 失败）。
    let bad = materialize_sandbox(&tmp, "test-plugin", &files, "missing.py");
    assert!(bad.is_err());

    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn install_hint_covers_both_runtimes() {
    // 内置运行时缺失属于安装损坏，不提供下载或系统路径旁路。
    let node_hint = install_hint(ScriptRuntime::Nodejs);
    let py_hint = install_hint(ScriptRuntime::Python);
    assert!(
        node_hint.contains("Node.js") && node_hint.contains("重新安装"),
        "Node 提示：{node_hint}"
    );
    assert!(
        py_hint.contains("Python") && py_hint.contains("重新安装"),
        "Python 提示：{py_hint}"
    );
}

// 解释器实跑测试：仅在宿主存在对应解释器时执行，否则跳过（不标记失败）。
fn maybe_node() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        find_binary("node")
    }
    #[cfg(not(windows))]
    {
        ["node", "nodejs"].iter().find_map(|c| find_binary(c))
    }
}

fn maybe_python() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        ["py", "python", "python3"]
            .iter()
            .find_map(|c| find_binary(c))
    }
    #[cfg(not(windows))]
    {
        ["python3", "python"].iter().find_map(|c| find_binary(c))
    }
}

#[test]
fn run_node_hello_script_if_available() {
    let binary = match maybe_node() {
        Some(b) => b,
        None => {
            eprintln!("[skip] 宿主无 node，跳过 Node 运行测试");
            return;
        }
    };
    // 在临时 sandbox 写一个 console.log 脚本直接运行（不走 run_plugin_script 的 app handle 依赖）。
    let tmp = std::env::temp_dir().join(format!(
        "lf-node-run-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let entry = tmp.join("index.js");
    std::fs::write(&entry, "console.log('ok-from-node')").unwrap();
    let captured = run_capture_with_env(
        &binary,
        vec![entry.to_string_lossy().to_string()],
        None,
        5_000,
        minimal_env(),
    )
    .expect("node 运行应成功");
    assert!(!captured.timed_out);
    assert_eq!(captured.exit_code, Some(0));
    assert!(captured.stdout.contains("ok-from-node"));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn run_python_hello_script_if_available() {
    let binary = match maybe_python() {
        Some(b) => b,
        None => {
            eprintln!("[skip] 宿主无 python，跳过 Python 运行测试");
            return;
        }
    };
    let tmp = std::env::temp_dir().join(format!(
        "lf-py-run-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let entry = tmp.join("main.py");
    std::fs::write(&entry, "print('ok-from-python')").unwrap();
    let captured = run_capture_with_env(
        &binary,
        vec![entry.to_string_lossy().to_string()],
        None,
        5_000,
        minimal_env(),
    )
    .expect("python 运行应成功");
    assert!(!captured.timed_out);
    assert_eq!(captured.exit_code, Some(0));
    assert!(captured.stdout.contains("ok-from-python"));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn timeout_kills_infinite_loop() {
    let _guard = crate::process_util::process_tree_test_lock();
    let binary = match maybe_node() {
        Some(b) => b,
        None => {
            eprintln!("[skip] 宿主无 node，跳过超时测试");
            return;
        }
    };
    let tmp = std::env::temp_dir().join(format!(
        "lf-timeout-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let entry = tmp.join("loop.js");
    std::fs::write(&entry, "while(true){}").unwrap();
    let started = Instant::now();
    let captured = run_capture_with_env(
        &binary,
        vec![entry.to_string_lossy().to_string()],
        None,
        800,
        minimal_env(),
    )
    .expect("超时应被 kill 并返回而非报错");
    assert!(captured.timed_out);
    // 超时应在略超 800ms 处回收（含 50ms 轮询粒度容忍）。
    let elapsed = started.elapsed().as_millis();
    assert!(elapsed < 3000, "超时回收耗时异常：{elapsed}ms");
    let _ = std::fs::remove_dir_all(&tmp);
}

// 修复 SCRIPT-04（low 资源泄漏）：sandbox LRU 清理应保留最近 N 个，删除最旧。
#[test]
fn sandbox_lru_keeps_recent_and_removes_old() {
    let tmp = std::env::temp_dir().join(format!(
        "lf-sandbox-lru-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    // 写 12 个合法 plugin_id 目录（超 KEEP=8），用不同的 mtime 模拟历史。
    // 通过 touch（写文件）调整 mtime，确保排序可区分。
    for i in 0..12u32 {
        let dir = tmp.join(format!("plugin-{i}"));
        std::fs::create_dir_all(&dir).unwrap();
        // 每个目录里写一个文件并设置不同的 mtime（i 越大 mtime 越新）。
        std::fs::write(dir.join("marker.txt"), format!("{i}")).unwrap();
        // 用不同 sleep 间隔确保 mtime 严格递增（filesystem 精度可能粗，多 sleep 几毫秒）。
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    // 调 cleanup_sandbox_lru（KEEP=8）：应删除最旧的 4 个（plugin-0..plugin-3）。
    cleanup_sandbox_lru(&tmp, "plugin-new");
    let remaining: Vec<String> = std::fs::read_dir(&tmp)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    // 保留 8 个，最旧的 4 个被删。
    assert_eq!(remaining.len(), 8, "应保留 8 个，实际 {remaining:?}");
    assert!(
        !remaining.iter().any(|n| n == "plugin-0"),
        "plugin-0 应被删"
    );
    assert!(
        !remaining.iter().any(|n| n == "plugin-3"),
        "plugin-3 应被删"
    );
    assert!(remaining.iter().any(|n| n == "plugin-4"), "plugin-4 应保留");
    assert!(
        remaining.iter().any(|n| n == "plugin-11"),
        "plugin-11 应保留"
    );
    // 非法目录名不应被删（安全过滤）：写一个含路径分隔符的目录。
    // 注意：Windows/Linux 不允许目录名含 / 或 \，改用 . 开头的隐藏名（sanitize 拒绝）。
    let hidden = tmp.join(".hidden-dir");
    std::fs::create_dir_all(&hidden).unwrap();
    cleanup_sandbox_lru(&tmp, "plugin-x");
    // .hidden-dir 应仍存在（sanitize_plugin_id 拒绝 . 开头）。
    assert!(hidden.exists(), "非法名目录不应被 LRU 删除");
    let _ = std::fs::remove_dir_all(&tmp);
}

// 修复 SCRIPT-02（high 并发）：超时杀进程应杀整个进程组（含孙进程），
// wait_with_output 不应永久挂起。本测试派生孙进程（node 子进程）模拟，验证回收不阻塞。
#[test]
fn timeout_kills_grandchild_process_tree() {
    let _guard = crate::process_util::process_tree_test_lock();
    let binary = match maybe_node() {
        Some(b) => b,
        None => {
            eprintln!("[skip] 宿主无 node，跳过孙进程超时测试");
            return;
        }
    };
    let tmp = std::env::temp_dir().join(format!(
        "lf-timeout-grandchild-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    // 派生一个孙进程（unref 后死循环），主进程也死循环。
    // 超时杀主进程后，孙进程若不被杀会继续持有 stdout 管道写端，wait_with_output 永久阻塞。
    let script = r#"
        const { spawn } = require('child_process');
        // 孙进程：同样死循环（继承 stdout 管道写端）。
        spawn(process.execPath, ['-e', 'while(true){}']).unref();
        // 主进程：死循环，直到被 kill。
        while (true) {}
    "#;
    let entry = tmp.join("spawn_loop.js");
    std::fs::write(&entry, script).unwrap();
    let started = Instant::now();
    // 关键断言：run_capture_with_env 必须在合理时间内返回（不永久阻塞）。
    // 若孙进程未被杀，wait_with_output 会无限挂起，本测试 5s 超时 fail。
    let captured = run_capture_with_env(
        &binary,
        vec![entry.to_string_lossy().to_string()],
        None,
        800,
        minimal_env(),
    )
    .expect("超时应杀进程组并返回，不永久阻塞");
    let elapsed = started.elapsed().as_millis();
    assert!(captured.timed_out, "应触发超时");
    // 关键：若 wait_with_output 永久阻塞，elapsed 会远超 5s（本测试 cargo 默认无超时，
    // 但孙进程不被杀时实际会挂死到外部 CI 超时）。这里设 < 5000ms 作为快速回归保护。
    assert!(
        elapsed < 5000,
        "超时回收孙进程耗时异常：{elapsed}ms（可能 wait_with_output 被孙进程管道阻塞）"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

// === 完整插件执行测试（覆盖三种 runtime 的真实创建流程）===
// 验证：sandbox 落盘 + runtime_env 注入 + run_capture_with_env 执行，
// 含中文输出（验证 UTF-8/H2）、Python 多文件 import（H4 PYTHONPATH）、-u 无缓冲（H1）。

#[test]
fn node_plugin_chinese_output_and_structured() {
    // Node 插件完整执行：中文输出不乱码 + JSON 结构化 + stdout/stderr 分离。
    let binary = match maybe_node() {
        Some(b) => b,
        None => {
            eprintln!("[skip] 宿主无 node");
            return;
        }
    };
    let tmp = std::env::temp_dir().join(format!(
        "lf-node-plugin-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(
        tmp.join("index.js"),
        r#"
console.log("插件启动：Node.js " + process.version);
console.log("处理结果：✓ 会议纪要已整理，生成 3 条行动项");
console.log(JSON.stringify({ actionItems: ["任务A", "任务B"] }));
console.error("诊断信息");
"#,
    )
    .unwrap();
    let entry = tmp.join("index.js");
    let captured = run_capture_with_env(
        &binary,
        vec![entry.to_string_lossy().to_string()],
        Some(tmp.to_str().unwrap()),
        10_000,
        minimal_env(),
    )
    .unwrap();
    assert!(!captured.timed_out, "node 不应超时");
    assert_eq!(captured.exit_code, Some(0), "node 应 exit 0");
    assert!(
        captured.stdout.contains("会议纪要已整理"),
        "中文 stdout 丢失/乱码：{}",
        captured.stdout
    );
    assert!(
        captured.stdout.contains("任务A"),
        "JSON 中文内容丢失：{}",
        captured.stdout
    );
    assert!(captured.stderr.contains("诊断信息"), "stderr 应含诊断");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn python_plugin_chinese_and_cross_dir_import() {
    // Python 插件完整执行：验证 H1(-u 无缓冲) + H2(UTF-8 编码防中文乱码) + H4(PYTHONPATH 跨目录 import)。
    let binary = match maybe_python() {
        Some(b) => b,
        None => {
            eprintln!("[skip] 宿主无 python");
            return;
        }
    };
    let tmp = std::env::temp_dir().join(format!(
        "lf-py-plugin-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(tmp.join("pkg")).unwrap();
    // 子模块 pkg/util.py（跨目录 import，验证 PYTHONPATH 注入）。
    std::fs::write(
        tmp.join("pkg/util.py"),
        "def greet(name):\n    return f'你好 {name}，Python 插件运行中'\n",
    )
    .unwrap();
    // main.py 在根，import pkg.util（需 PYTHONPATH=<根>）。
    std::fs::write(
        tmp.join("main.py"),
        r#"
# -*- coding: utf-8 -*-
import sys, json
from pkg.util import greet
print(greet("开发者"))
print("处理结果：✓ 数据清洗完成，处理 128 条记录")
print(json.dumps({"records": 128, "status": "cleaned"}, ensure_ascii=False))
sys.stderr.write("诊断：Python stderr\n")
"#,
    )
    .unwrap();
    let entry = tmp.join("main.py");
    // 模拟 run_plugin_script 的真实调用：-u + runtime_env（PYTHONIOENCODING/PYTHONUTF8/PYTHONPATH）。
    let workspace = tmp.to_string_lossy().to_string();
    let env = runtime_env(ScriptRuntime::Python, &workspace, minimal_env());
    let captured = run_capture_with_env(
        &binary,
        vec!["-u".to_string(), entry.to_string_lossy().to_string()],
        Some(&workspace),
        10_000,
        env,
    )
    .unwrap();
    assert!(!captured.timed_out, "python 不应超时");
    assert_eq!(captured.exit_code, Some(0), "python 应 exit 0");
    // H4：跨目录 import 成功（无 ModuleNotFoundError）。
    assert!(
        captured.stdout.contains("你好 开发者"),
        "PYTHONPATH 跨目录 import 失败或中文乱码：{}",
        captured.stdout
    );
    // H2：中文不乱码。
    assert!(
        captured.stdout.contains("数据清洗完成"),
        "UTF-8 中文输出乱码：{}",
        captured.stdout
    );
    assert!(captured.stderr.contains("Python stderr"), "stderr 丢失");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn html_plugin_materialize_and_readable() {
    // HTML 插件：materialize_sandbox 落盘 + 文件可读（iframe srcDoc 渲染前置条件）。
    let tmp = std::env::temp_dir().join(format!(
        "lf-html-plugin-test-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let files = vec![ScriptFile {
        path: "ui/index.html".to_string(),
        content:
            "<!DOCTYPE html><html><body><h1>HTML 插件预览</h1><p>前端插件正常</p></body></html>"
                .to_string(),
    }];
    let (sandbox, entry) =
        materialize_sandbox(&tmp, "html-test-plugin", &files, "ui/index.html").unwrap();
    assert!(entry.starts_with(&sandbox), "entry 应在 sandbox 内");
    let content = std::fs::read_to_string(&entry).unwrap();
    assert!(content.contains("HTML 插件预览"), "HTML 内容应可读");
    assert!(
        content.contains("<!DOCTYPE html>"),
        "应是完整 HTML 文档（iframe srcDoc 可渲染）"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}
