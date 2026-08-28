# 零服务器桌面插件平台：Tauri v2 + Job Object 沙箱的三档安全边界

> D4 首发架构博客（LF-28 配套）。发布到 GitHub Discussions「架构」分类。
> 定位：给技术读者的深度文，讲清楚「本地优先插件平台」的安全模型为什么是三层、
> 每层防线守什么、不守什么——以及为什么我们选择诚实描述而不是吹成一个沙箱。

---

## 0. 背景：一个没有后端的桌面插件平台

「灵坊工作台」是一个 Tauri v2 桌面插件平台：第三方插件跑在本地桌面壳里，安装、能力鉴权、
文件与 AI 调用全部由桌面壳托管。它的架构底线是一条看起来不太现代的决定——**零服务器**：

- 仓库内没有后端（relay / billing / RBAC 服务端被刻意移除）；
- 没有账号体系、没有云端同步、没有「登录后可用」的功能；
- AI 能力（llm/image/video）走用户自配的 relay 凭据，由宿主代理转发，插件不持密钥。

这个决定直接塑造了安全模型：**没有服务端可以背锅，防线只能建在客户端本地**。于是我们设计了
三档边界，从里到外依次是：iframe 沙箱 → 进程围栏 → 安装时信任。

## 1. 第一档：client 插件是真实的运行时边界

client 插件是 HTML 插件，渲染在桌面壳前端的 iframe 里。这是三档里**唯一**称得上
「安全边界」的一档：

```html
<iframe sandbox="allow-scripts" srcdoc="..."></iframe>
```

关键细节：`sandbox` 只放行 `allow-scripts`，**没有** `allow-same-origin`。这意味着 iframe
获得一个不透明 origin（`'null'`），无法触达宿主页面 DOM、无法读取宿主 cookie / localStorage、
无法访问 Tauri IPC。

插件 JS 与宿主的唯一通道是宿主注入的 `window.sdk` 门面：

```js
// 宿主侧：每次调用都做来源校验 + 能力网关鉴权
window.addEventListener('message', (event) => {
  if (event.source !== iframe.contentWindow) return;  // 只信自己的 iframe
  if (event.origin !== 'null') return;                // 不透明 origin 才有资格
  // ... 路由到 capability 网关
});
```

**这条边界守什么**：恶意 client 插件 JS 无法越出 iframe——打不到宿主页面、够不着 Tauri IPC、
看不见同级插件。**不守什么**：它仍然是「诚实插件」模型——插件作者自己写的有问题代码、
以及插件声明的能力本身，靠的是下面两层 + 能力网关。

## 2. 第二档：nodejs / python 插件只是生命周期围栏

nodejs / python 插件是真正的 OS 进程，由宿主用 Windows **Job Object** 拉起：

```rust
// process_util/sandbox.rs（要点）
JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    JobObjectLimitFlags: KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION,
    // 没有 BREAKAWAY_OK：子进程无法逃出作业
}
```

**这一档的诚实定位：它是一条生命周期围栏，不是安全边界。** Job Object 保证的只有两件事：

1. **进程树收容**：插件 spawn 的所有子进程都留在作业里，无法 `BREAKAWAY_OK` 逃逸；
2. **随壳退出**：桌面壳退出时，`KILL_ON_JOB_CLOSE` 保证整个进程树一起死，不留孤儿。

它**不提供**：受限令牌、完整性级别、AppContainer、文件系统/网络隔离。一个恶意 nodejs 插件
完全可以用 Node 的 `fs` / `net` 直接读用户文件、连公网——只要它不经过 SDK 桥。

所以能力网关（capability gateway）对进程插件是**对诚实插件的 API 契约**，不是对抗恶意插件的墙。
这正是我们文档里反复强调的一句话：

> 进程插件在用户完整权限下运行，可以绕过 SDK 直接触网、直接读文件。能力网关只约束走 SDK 的调用。

## 3. 第三档：真正的防线是安装时信任

既然进程插件无法沙箱，防线只能前移到**安装时刻**：

- `.lfplugin` 制品用 **minisign** 验签（`plugin_security.rs`），核对签名与召回列表；
- v1 政策下，**本地导入仅接受 client 运行时插件**；nodejs / python 安装保留给内置插件与
  一方签名插件——直到插件签名信任根成熟为止。

这是「生态尚未成熟」的务实取舍：先限制可安装的东西，而不是假装能沙箱不可信代码。
信任是安装时建立的，运行时不二次兜底。

## 4. 为什么是三档而不是一档

一句话：**client 沙箱是真墙，进程插件是诚实契约，安装信任是最后的保险**。三档各守一段，
缺一不可：

| 档 | 机制 | 守什么 | 不守什么 |
| --- | --- | --- | --- |
| 1. client iframe | `sandbox` 无同源 + 来源校验 + 能力网关 | 插件 JS 越不出 iframe | 诚实插件自己写的 bug |
| 2. 进程插件 | Job Object 收容 + kill-on-close | 进程树不逃逸、不留孤儿 | 插件直接读文件/联网 |
| 3. 安装信任 | minisign 验签 + 召回 + client-only 导入 | 恶意包进不来 | 信任后的行为 |

零服务器模型的反面是：没有云端杀毒、没有服务端审计、没有「远程吊销」。所以每档边界都必须
在本地自洽——这也是为什么我们宁愿把「进程插件不设防」写进 README，而不是含糊带过。

## 5. 一些实现细节

- **能力网关**：插件声明 `capabilities[]`（kind/reason/risk/requires_admin），宿主在
  权限弹窗后放行；grant 解析 deny-wins（用户 > 角色 > 默认拒绝）。
- **AI 凭据**：client iframe 永不持有 relay 密钥——AI 调用走宿主代理命令，宿主持 session
  转发到 relay（决策记录 C2，`docs/decisions/C2-relay-credential-source.md`）。
- **内置插件编译进二进制**：`build.rs` 把内置插件 zip 成 sha256 命名的 `.lfplugin`，
  `include_bytes!` 嵌入，启动时注册——内置插件不在信任链之外。

## 6. 局限与下一步

诚实清单：

- 进程插件的沙箱化（受限令牌 / AppContainer / 网络过滤）是明确的未做项，等生态信任根成熟后评估；
- 插件签名信任根（官方 CA / 密钥托管）未建立，v1 靠 client-only 限制兜底；
- 如果未来要支持第三方进程插件，第二档必须升级成真边界——这是已知的架构债务。

产品与代码都在：<https://github.com/qiuuchan/new-lingfang>（README 有演示 GIF）。
欢迎在 Issues 讨论安全模型——尤其是「你会在什么条件下信任一个第三方进程插件」。
