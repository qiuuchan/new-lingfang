# 插件开发说明（Plugin Development）

本说明面向 **LingFang 插件**（`灵坊工作台`）的作者。该工作台是一个 **Tauri v2 桌面插件平台**，
采用 **零服务端模型（zero-server）**：仓库内没有后端，所有插件执行、能力鉴权、文件/网络访问
都通过 Tauri 命令、本地文件系统和随应用打包的语言运行时（Node / Python / Chromium / ffmpeg）完成。

---

## 1. 运行时类型（runtime_type）

插件在 `manifest.json` 中通过 `runtime_type` 声明其运行方式。

| runtime_type | 入口（entry）要求 | 运行方式 |
| --- | --- | --- |
| `client` | 以 `.html` 结尾 | 在桌面前端内的 iframe 中渲染 |
| `nodejs` | 以 `.js` / `.mjs` / `.cjs` 结尾 | 由 Rust `plugin_runner` 以独立 OS 进程拉起 |
| `python` | 以 `.py` 结尾 | 由 Rust `plugin_runner` 以独立 OS 进程拉起（含 venv） |
| `cloud` | 必须是 URL（`http(s)://...`） | **仅由平台云端托管**，本地桌面壳不支持 |
| `workflow` | 由平台云端解释 | **仅由平台云端托管**，本地桌面壳不支持 |

> ⚠️ 校验器会对 `cloud` / `workflow` 发出**非阻塞警告**：本地桌面工作台是零服务端模型，
> 不会运行这两类运行时；它们需通过平台云端运行。其余规则（如 `cloud` 入口必须是 URL）仍照常生效。

> 🔒 **v1 安装政策（2026-08-23 起，IMPROVEMENT_PLAN F2）**：**本地导入**的第三方插件仅允许
> `client` 运行时；`nodejs` / `python` 进程插件保留给内置或一方签名插件——进程沙箱
> （Windows Job Object）是生命周期围栏而非安全边界，在插件签名信任根建立前不放开
> （见仓库 `CODEBUDDY.md` Security model）。开发期 `create` / `validate` / `build`
> 这两类插件制品不受影响；受影响的只是桌面壳的本地导入安装。

`create` 脚手架目前提供 `client`、`nodejs`、`python` 三类本地模板。

---

## 2. Manifest 结构

`manifest.json` 使用 **snake_case** 作为边界约定，是插件的身份与契约。关键字段：

- `id`：插件唯一标识，形如 `com.<author>.<name>`，须以字母开头。
- `name` / `version`：名称与版本；`version` 为严格 SemVer，**不允许** `0.0.0` 或 `0.0.0-*`。
- `runtime_type` / `entry`：运行时类型与入口文件（见上表匹配规则）。
- `visibility`：`private` 或 `tenant`。
- `capabilities[]`：插件声明的每一项能力（见第 4 节）。
- `actions[]`：插件对外暴露的动作。
- `shared_namespaces[]`：共享状态命名空间。

完整类型以 `@lingfang/contract` 包为准（该包是 host↔plugin 类型的**唯一事实来源**）。

---

## 3. 能力声明（capabilities）与安全模型

插件 **绝不能直接** 访问网络或持有 LLM 密钥。所有特权操作（文件读写、剪贴板、系统信息、
截图、`net.fetch`、LLM/图像/视频生成等）都由 **宿主（host）** 在能力网关（`capability.rs`）
三重校验通过后执行。

- 每个 `capability` 需声明：`kind`（能力种类）、`reason`（用途说明）、`risk`（low/medium/high）、
  `requires_admin`。
- `kind` 必须在 `CapabilityKind` 枚举内（共 17 种，如 `ui.view`、`fs.read`、`fs.write`、
  `net.fetch`、`clipboard`、`llm.chat`、`image.generate`、`video.generate`、`audio.generate` 等）。
- 当 `risk` 为 `medium` / `high` 时，`reason` **必填**。
- 同一 `kind` 不允许重复声明。

宿主按 **deny-wins**（拒绝优先、用户 > 角色）解析授权。插件文档应解释每项能力的数据访问
范围与隐私影响。

**声明即授权，桌面壳无运行时权限门**：能力网关只做「插件是否声明了该 kind」的三重校验，
**不在运行时弹出权限请求**（不存在 `requestSystemPermission` 之类的运行时授权弹窗）。换言之，
只要插件 manifest 声明了某 `kind` 且通过安装信任校验，宿主就按该 kind 的契约执行——敏感能力
（如 `system.screenshot`、`clipboard`）的「授权」来自用户的知情与显式声明，而非运行时的二次确认。
因此，**插件作者必须如实声明每一项用到的能力**，未声明的 kind 调用会被网关直接拒绝
（`capability_not_declared`）。

进程隔离：插件进程运行于 Windows Job Object 沙箱中；`.lfplugin` 包通过 minisign 签名校验，
并对照召回（recall）列表检查。

---

## 4. 本地开发工作流（lingfang-plugin CLI）

SDK 提供 `lingfang-plugin` 命令，覆盖插件全生命周期：

```bash
lingfang-plugin create      # 从 client / nodejs / python 模板脚手架，生成 manifest.json、入口与 README
lingfang-plugin validate    # Zod schema + 业务规则双层校验；cloud/workflow 会提示非阻塞警告
lingfang-plugin build       # 通过 archive.ts 打包为 .lfplugin v4（请勿手动 zip）
lingfang-plugin publish     # 上传至插件注册中心
lingfang-plugin dev <dir>   # 把插件目录注册为 dev 安装（免打包直读，v1 仅 client 运行时；v2 改文件自动重载）
```

校验（`validate`）的退出码约定：**存在阻塞性错误 → 退出码 1**；仅存在警告 → 退出码 0（校验通过）。
`build` 也会先执行同样的 manifest 校验，失败则快速报错。

### dev 安装（免打包直读）

`lingfang-plugin dev <dir>` 把开发中的插件目录直接注册为 **dev 安装**（origin=`dev`），
跳过 `build` 的打包环节：宿主直接读取 `<dir>` 下的 `manifest.json` 与入口文件。

- **v1（当前）**：仅支持 `client` 运行时。这与本地导入三方插件仅限 client 的政策一致
  （`IMPROVEMENT_PLAN.md` F2 / `CODEBUDDY.md` Security model）：`nodejs` / `python` 进程插件
  在 v1 下保留给内置或一方签名插件，因此 `dev` 也会对 `runtime_type !== 'client'` 直接报错。
  宿主挂载该安装后，可监听目录文件变更并触发 `plugin:dev-reload` 事件，前端 `PluginRunner`
  据此重新拉取 entry HTML，使 client 插件在保存后即时刷新（无需重新打包）。
- **v2（规划）**：引入 watch 守护与更细粒度的增量重载，进一步缩短 client 插件的热更新延迟。

在桌面宿主之外运行 `dev`（无 `window.__TAURI__`）时为 best-effort：命令仍完成校验并打印提示，
告知用户回到宿主中打开该插件以获得监听能力，不会因缺少 Tauri 运行时而崩溃。

### CLI 命令形态（本仓库内开发）

仓库内推荐用以下形态运行 CLI（`bin` 链接可能未建立，`pnpm exec lingfang-plugin` 会报
`Command not found`）：

```bash
# 相对 packages/plugin-sdk 的短路径
pnpm -C packages/plugin-sdk cli:dev -- validate examples/clip-digest
pnpm -C packages/plugin-sdk cli:dev -- build   examples/clip-digest
# 也接受仓库根相对路径（LF-05 起自动归一化，不再二次拼接）
pnpm -C packages/plugin-sdk cli:dev -- validate packages/plugin-sdk/examples/clip-digest
# 或根 package.json 脚本（底层仍是同一 CLI）
pnpm plugin:validate
pnpm plugin:build
```

CLI 的路径参数（`validate` / `build` / `publish` / `dev`）解析规则：绝对路径原样使用；
相对路径先按当前工作目录、再按仓库（pnpm 工作区）根解析——两种相对写法都可用，
不再有「传错相对基准导致路径翻倍」的坑。

#### `--quiet` 机器可读输出（LF-08 / J3）

`validate` / `build` / `publish` / `dev` 支持 `--quiet` 标志：人类可读的多行日志被抑制，
**仅逐行输出错误 `code`**，便于脚本解析（如 `lingfang-plugin validate . --quiet | while read code; do ...`）。
`--json` 保持不变（结构化输出优先）。`build` 的错误对象已与 `validate` 对齐，新增 `path` 字段
（`{ code, path, message }`）。

- 成功：`--quiet` 不输出任何内容，仅靠退出码（0）判断。
- 失败：每个错误一行 `code`（如 `manifest_invalid_json`）。

### 零服务端模型要点（回顾）

1. 没有后端服务；所有能力由桌面宿主在本地执行。
2. 插件通过宿主注入的桥接（`window.__lingfangInvoke` 或本地 HTTP 桥）调用特权能力，不直连外部。
3. 语言运行时由 `RuntimeResolver` 统一解析，**只读取随应用打包的 `runtimes/`**，不查系统 PATH，
   并注入国内镜像（Tsinghua PyPI / npmmirror npm）。

---

## 5. 错误处理与降级

**统一以 `code` 判断错误，不要解析中文文案或 message 前缀。**

插件拿到能力错误时，不同运行形态下结构已对齐（LF-05 / g2-sdk-friction #1）：

- **client 插件（iframe 内 `window.sdk`）**：宿主 `plugins-runtime.ts` 归一化，
  错误对象带稳定 `code` 字段。
- **nodejs / python 插件（npm 包 `@lingfang/plugin-sdk`）**：`sdk.llm.*` 类 AI 调用
  统一抛出 `PluginAiError`，`code` 与 client 形态一致；其余能力错误为裸字符串
  `前缀: 中文文案` 形态，`code` 即前缀本身。

标准降级范式（relay 凭据未配置时优雅降级，不崩溃不白屏）：

```ts
import { sdk, PluginAiErrorCode } from '@lingfang/plugin-sdk';

try {
  const summary = await sdk.llm.chat({ messages: [{ role: 'user', content: text }] });
} catch (err) {
  if (err?.code === PluginAiErrorCode.RelayNotConfigured) {
    // 保存原文，提示用户去设置页配置 relay 凭据
  } else {
    throw err;
  }
}
```

常用错误码表（`code` 为稳定值；client 形态经宿主归一化，脚本形态为 message 前缀）：

| code | 含义 | 建议处理 |
| --- | --- | --- |
| `relay_not_configured` | 平台 LLM 凭据未配置 | 优雅降级 / 引导去设置页 |
| `relay_error` | relay 转发失败（上游错误、配额超限等，message 含可读原因） | 展示 message 后可重试 |
| `request_timeout` | 桥调用超时（AI 默认 180s） | 提示稍后重试 |
| `bridge_unavailable` | 宿主桥未注入（容器未加载/旧版） | 提示宿主环境问题 |
| `unsupported_model` | `model` 不是 `fast` / `premium` | 修插件入参 |
| `capability_not_declared` | 插件未声明该能力 | 补 manifest.capabilities |
| `capability_not_supported` | 已声明但桌面壳未实现 | 查本仓库能力面 |
| `capability_out_of_scope` | 参数超出授权范围（如 fs 路径越界） | 修插件入参 |
| `capability_invalid_path` | 文件路径非法 | 修插件入参 |
| `net_fetch_ssrf_blocked` | net.fetch 命中 SSRF 防护 | 换公开 URL |
| `kv_value_too_large` | storage.kv 单值超 256KB | 压缩/分片存储 |
| `kv_quota_exceeded` | storage.kv 条目超 1024 | 提示「剪藏已达上限」或实现淘汰 |
| `plugin_ai_error` / `capability_error` | 其他未分类错误 | 展示 message |

### 超时语义

| 调用 | 默认超时 |
| --- | --- |
| 通用能力（clipboard / storage.kv / ui.view / fs / notify 等） | 30s |
| AI 桥（llm.chat / image / video / audio） | 180s |
| action 桥（sdk.actions.call） | 24h + 30s（真实时限在宿主侧） |

SDK 与宿主**各有一层超时计时，取先到者**——不要依赖单侧等待时间。AI 长文摘要
（约 3 分钟档位）够用；调用级覆盖见下。

#### 调用级 timeoutMs 覆盖（LF-08）

四个 AI 输入型（`llm.chat` / `image.generate` / `image.edit` / `video.generate`）
支持可选的 `timeoutMs?: number`：

```ts
const summary = await sdk.llm.chat({
  messages: [{ role: 'user', content: longDoc }],
  timeoutMs: 90_000, // 该次调用 90s 上限（覆盖默认 180s）
});
```

- **覆盖上限**：`timeoutMs` 会被 **clamp 到 [1000, 180_000]**，超出边界时收敛而非报错
  （传入 999_999 → 取 180_000；传入 10 → 取 1000）。调用级只能**缩短**或保持默认上限，
  **不能突破 180s**（安全护栏，防止插件挂死宿主桥）。
- `timeoutMs` 仅作用于 SDK 侧计时器，**不会**透传给宿主；最终生效的是
  SDK 计时与宿主计时**先到者**。
- 不传 `timeoutMs` 时维持默认 180s。

### ui.view content 契约

`sdk.ui.render(content)` 是**纯宿主渲染**：宿主只做 Markdown / JSON 文本渲染，
绝不执行插件传入的 HTML 或脚本（`UiViewHost` 队列，不经 Rust 网关）。

推荐结构（宿主按 `type` 渲染，插件侧保持稳定）：

```ts
// Markdown 渲染（推荐）
await sdk.ui.render({ type: 'markdown', body: '## 标题\n\n正文' });
// 普通文本 / JSON（安全序列化展示）
await sdk.ui.render({ type: 'json', body: { ok: true, count: 3 } });
```

纯字符串也可（按文本渲染）。content 必须可 JSON 序列化（循环引用会提前报错）。

### storage.kv 限额

按插件隔离持久化到宿主数据目录 `kv.json`，硬性边界：

| 项 | 上限 |
| --- | --- |
| 单值（JSON 序列化后字节数） | 256KB |
| 单插件条目数 | 1024 |
| key 长度 | 256 字符 |
| kv.json 整文件 | 8MB（读回防御） |

超限时 `set` 会 reject 稳定码 `kv_value_too_large` / `kv_quota_exceeded`——**不要**静默
降级到其他存储（如 localStorage）掩盖真实错误，应提示用户或实现淘汰策略。

### storage.kv 管理 API（LF-07）

除 `get` / `set` 外，宿主还提供三个管理 op（同样走 `storage.kv` 网关，受 `storage.kv`
能力声明与 30s 超时约束）：

| 方法 | 宿主 op | 入参 | 返回 | 说明 |
| --- | --- | --- | --- | --- |
| `sdk.storage.list(prefix?)` | `list` | `prefix?: string` | `string[]`（仅键名） | 按前缀过滤键名；不回传值（单值可达 256KB）。缺省返回全部键 |
| `sdk.storage.delete(key)` | `delete` | `key: string` | `{ deleted: boolean }` | 键不存在返回 `{ deleted: false }`，不报错 |
| `sdk.storage.count()` | `count` | — | `number` | 当前插件条目数 |

```ts
// 列出本插件所有 user: 前缀的键
const keys = await sdk.storage.list('user:');
// 删除一个键（不存在时 deleted=false，不抛错）
const { deleted } = await sdk.storage.delete('user:alice');
// 查询条目数（对照 kv_quota_exceeded 上限 1024）
const n = await sdk.storage.count();
```

**持久化语义**：`set` 与 `delete` 都会同步落盘到 `kv.json`；应用重启后已删除的键**不复活**。
`get` / `list` / `count` 为只读，不触发写盘。

**淘汰范式（reaching quota）**：当 `count()` 逼近 1024 上限、`set` 开始 `kv_quota_exceeded`
时，应在插件内实现淘汰而非静默降级。常见做法——以 `set` 时间戳作为值的一部分，淘汰时
先 `list()` 再按时间戳 `delete()` 最旧条目：

```ts
type Stamped<T> = { v: T; ts: number };
const KEY_LIMIT = 1024;
async function setWithEviction(key: string, value: unknown) {
  const n = await sdk.storage.count();
  if (n >= KEY_LIMIT) {
    const keys = await sdk.storage.list();
    // 读取全部带时间戳的值，淘汰最旧者（真实场景可分批，避免一次性大读）。
    let oldest: { key: string; ts: number } | null = null;
    for (const k of keys) {
      const item = (await sdk.storage.get(k)) as Stamped<unknown> | null;
      if (item && (!oldest || item.ts < oldest.ts)) oldest = { key: k, ts: item.ts };
    }
    if (oldest) await sdk.storage.delete(oldest.key);
  }
  await sdk.storage.set(key, { v: value, ts: Date.now() } satisfies Stamped<unknown>);
}
```

---

## 6. 参考

- 类型与契约：`packages/contract`（`@lingfang/contract`）
- 插件 SDK 与 CLI：`packages/plugin-sdk`（`@lingfang/plugin-sdk`）
- 桌面壳与 Rust 引擎：`apps/desktop`（Tauri v2）
