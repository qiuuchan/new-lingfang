# G2 · SDK 使用摩擦记录（剪藏摘要狗粮插件实证）

> 工单：**LF-01**（建议派 Agent A）
> 插件：`packages/plugin-sdk/examples/clip-digest/`（client 运行时，覆盖 `clipboard` + `storage.kv` + `llm.chat` + `ui.view` 四个 kind）
> 验证环境：Windows 11 / pnpm 9 / Node 20 / 无 WebView2 与 `cargo` 桌面闭环（见文末「未验证项」）
> 记录人：本会话（ultracode 工作流 + 人工核对）
> 目的：作为后续 SDK / CLI / API 调整的**唯一输入源**。每条摩擦含「现象 / 复现 / 建议」，无问题项显式标注「无问题」。
>
> **解决状态（LF-05，2026-08-25）**：#1 已修复（npm SDK `pluginAiError` 归一 relay 码 +
> 导出 `PluginAiErrorCode` 常量，含裸字符串 reject 形态）；#2 已修复（`resolvePluginPath`
> 防二次拼接，validate/build/dev/publish 接入）；#5 前半已修复（Rust kv 配额码
> `kv_value_too_large` / `kv_quota_exceeded` + 宿主归一化，先于泛化「超出」匹配）；
> #6 文档已补齐（错误处理/降级、ui.view content 契约、超时语义、kv 限额、CLI 形态）。
> 未做：#3（--json 友好化，中优先）、#4（调用级 timeoutMs 覆盖）、#5 后半（list/delete/count
> 管理能力）、#7（静态插件免 tsx）——留待真实插件需求驱动。

---

## 0. 验证基线（先说结论）

| 项 | 结果 |
|---|---|
| `lingfang-plugin validate` | ✅ exit 0，无 error 无 warning |
| `lingfang-plugin build` | ✅ exit 0，产物 `com.lingfang.clip-digest-0.1.0.lfplugin`（6700 字节，v4，`_meta.json` 含 `formatVersion:4`，sha `ab0e67e3f74fe34d`） |
| 4 个 kind 在插件内真实调用 | ✅ 见 `ui/index.html`：readText→storage.set→llm.chat（含降级）→ui.render |
| `pnpm typecheck`（contract + plugin-sdk + desktop + root） | ✅ 全绿 |
| `pnpm test`（plugin-sdk 123 + contract 71 + desktop 62） | ✅ 全绿；新增 `src/clip-digest.spec.ts`（10 用例覆盖四个 kind + 降级判定 + 超时包装） |
| 桌面壳本地导入 + 徽标/未签名警示 | ⚠️ **未在此环境执行**（缺 WebView2 + cargo，代码路径已核对存在） |

可用命令（本环境唯一可用形态）：
```
pnpm -C packages/plugin-sdk cli:dev -- validate examples/clip-digest
pnpm -C packages/plugin-sdk cli:dev -- build   examples/clip-digest
```

---

## 1. 错误码可读性：npm SDK 与宿主注入 SDK 的 `relay_not_configured` 形态不一致 ⚠️ 高优先

**现象**
同一个「平台 LLM 未配置凭据」错误，在不同运行形态下，插件拿到的错误对象结构**不一致**：

- **client 插件运行时（iframe 内 `window.sdk`，由 `PluginRunner.tsx` 注入的 bootstrap 门面）**：经 `apps/desktop/src/lib/plugins-runtime.ts:54` 的 `normalizeCapabilityError` 归一化后，`error.code === 'relay_not_configured'`、`error.message` 为可读中文。
- **npm SDK（`@lingfang/plugin-sdk` 的 `sdk.llm.chat`，用于 nodejs/python 插件与单测）**：`invokeAi`（`src/index.ts:384-404`）捕获桥错误后走 `pluginAiError`，而 `pluginAiError`（`src/index.ts:171-181`）对「relay 未配置」**只会把 `relay_not_configured:` 作为 `message` 前缀透传，`code` 落为 `'plugin_ai_error'`**。SDK 源码里根本没有把 `relay_not_configured` 映射成稳定 `code` 的分支。
- 真正的「前缀在 message」是 Rust 侧 `apps/desktop/src-tauri/src/client_ai_proxy.rs:22` 的 `ERR_RELAY_NOT_CONFIGURED = "relay_not_configured:"`。

**复现**
```ts
// 用 npm sdk（nodejs/python 插件或单测常见）
const err = await sdk.llm.chat({ messages:[{role:'user',content:'hi'}] }).catch(e=>e)
console.log(err.code)    // => 'plugin_ai_error'   ← 不是 relay_not_configured
console.log(err.message) // => 'relay_not_configured: ...'  ← 仅 message 含前缀
```

**影响**：开发者按直觉写 `if (err.code === 'relay_not_configured')` 在 client 插件里能跑（因为走宿主归一化），但在 nodejs/python 插件或单测里**判断失效**。本插件的降级逻辑因此只能保守地用 `err.message.includes('relay_not_configured')`（`ui/index.html:332` 与 `src/clip-digest.spec.ts:19`），依赖字符串包含而非稳定 code，脆弱。

**建议**
1. 在 `pluginAiError`（`src/index.ts:171`）增加与宿主一致的归一化：当 `source.message` 含 `'relay_not_configured'` 时 `code: 'relay_not_configured'`、`status: 503`（或 424/特别地由平台定）。
2. 同步在 `PluginAiError` 上补充 `code` 常量导出（如 `PluginAiErrorCode.RelayNotConfigured`），供插件 `import` 后比对，彻底消灭字符串魔法值。
3. 在 `docs/plugin-development.md` 明示：「relay 未配置」在 client/云端/脚本三种形态下**均为 `code:'relay_not_configured'`**，统一以 `code` 判断。

---

## 2. CLI 调用形态与 cwd 敏感（dev 循环摩擦）⚠️ 高优先

**现象**
任务说明里给的主命令 `pnpm -C packages/plugin-sdk exec lingfang-plugin <cmd>` 在本 checkout **直接失败**，且失败信息不指向根因；可行的命令形态与直觉相反（路径要相对 `packages/plugin-sdk`，而非仓库根）。

**复现（真实踩坑）**
| 命令 | 结果 |
|---|---|
| `pnpm -C packages/plugin-sdk exec lingfang-plugin validate examples/clip-digest` | ❌ `Command 'lingfang-plugin' not found`（bin 未链接进 `node_modules/.bin`） |
| `pnpm -C packages/plugin-sdk cli:dev -- validate packages/plugin-sdk/examples/clip-digest`（仓库根下用长路径） | ❌ 路径被二次拼接成 `.../packages/plugin-sdk/packages/plugin-sdk/examples/clip-digest` |
| `cd examples/clip-digest && pnpm -C packages/plugin-sdk cli:dev -- validate .` | ❌ ENOENT `.../examples/clip-digest/packages`（`-C` 仍把 cwd 切到包目录） |
| `pnpm -C packages/plugin-sdk cli:dev -- validate examples/clip-digest`（仓库根、相对包目录的短路径） | ✅ 通过 |

**根因**
- `lingfang-plugin` 是 `bin` 声明，但本环境未执行会让 pnpm 建 `.bin` 软链的安装步骤，`pnpm exec` 找不到。
- `cli:dev` = `tsx src/cli/index.ts`，其 `process.cwd()` 固定为 `packages/plugin-sdk`；CLI 用 `path.resolve(parsed.positional[0] ?? cwd)`（`build.ts:43`）对相对路径再次基于该 cwd 解析，故「仓库根相对路径」会叠加成双倍路径。

**建议**
1. 在 `docs/plugin-development.md` 把**唯一可用命令**写明：`pnpm -C packages/plugin-sdk cli:dev -- <cmd> <相对 packages/plugin-sdk 的路径>`；或对仓内示例直接给 `pnpm plugin:validate` / `pnpm plugin:build`（建议补充到根 `package.json` scripts）。
2. CLI 对位置参数做「绝对路径归一化 + 防二次拼接」：`if (!path.isAbsolute(p)) p = path.resolve(packageCwd, p)`，并对已含 `packages/plugin-sdk` 前缀的输入做去重。
3. `pnpm exec` 找不到 bin 时，由 CLI 或根脚本给出明确提示：「未链接 bin，请改用 `cli:dev` / `pnpm install` / `npx tsx`」，而非泛化的 `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`。

---

## 3. CLI 错误输出的结构化程度（exit 码 OK，但默认文本不机器可读）⚠️ 中优先

**现象**
`validate` / `build` 的**错误码本身是好的**（`manifest_validation_failed`、`entry_not_found`、`pack_failed`、`manifest_not_found`），但非 `--json` 模式下只以「`[code] path: message`」文本打印（`build.ts:80-85`）。成功用 `log.success` 彩色文本、失败用 `log.error` 彩色文本，二者**形状不同**，且无稳定的结构化出口（除非显式 `--json`）。本次插件首次即通过、无错误，故未触发，但失败路径下脚本化消费困难。

**复现**
```
# 故意制造非法 manifest 后
pnpm -C packages/plugin-sdk cli:dev -- validate examples/clip-digest
# 输出： [schema_invalid] version: version must be a strict SemVer value
# 该 code 在脚本里只能靠正则从文本抠，无法可靠解析
```

**建议**
1. 把 `--json` 设为 CI 友好默认（或新增 `--quiet` 仅输出 code+path），让 `jq`/脚本可稳定解析。
2. 错误 JSON 的 `errors[]` 与成功 `BuildResult` 字段尽量对齐（都有 `code`/`message`），降低解析分支成本。

---

## 4. 超时阈值 30s / 180s 是否合理 ⚠️ 观察（基本合理，给出边界与建议）

**现象（来自 `src/index.ts:139-146`）**
- 通用桥调用 `DEFAULT_BRIDGE_TIMEOUT_MS = 30_000`。
- AI 桥 `AI_BRIDGE_TIMEOUT_MS = 180_000`（llm.chat / image / video）。
- action 桥上限 `ACTION_BRIDGE_TIMEOUT_MS = 24h+30s`。

**复现 / 评估**
- 通用 30s：对 `clipboard` / `storage.kv` / `ui.view` / `fs` / `notify` 足够；本插件的这三类调用均在毫秒级返回。✅ 基本合理。
- AI 180s：对「剪贴板长文摘要」场景合理；但若未来支持长文档/多轮，`llm.chat` 单轮 180s 偏紧。本插件未触及上限。⚠️ 边界建议：允许 manifest 或调用级覆盖 `timeoutMs`，或至少在文档标明 AI 默认 180s，避免插件作者误以为会无限等待或被 30s 掐断。
- 宿主侧 `apps/desktop/src/lib/plugins-runtime.ts` 注释提到「前端自带 30s」——意味着 SDK 30s 与宿主 30s **取先到者**，存在双计时器叠加的隐性行为，文档未明示。

**建议**
1. `docs/plugin-development.md` 标明各档超时与「SDK 与宿主取先到者」的语义。
2. 为 `sdk.llm.chat` 增加可选的 `timeoutMs` 调用参数（不超过 180s 上限），覆盖长文场景。

---

## 5. storage.kv 单值 256KB / 单插件 1024 条目 是否够用 ⚠️ 观察（本插件够用，给评估）

**现象（来自 host 文档策略，见 README 与 `verify-a5` runbook）**
storage.kv 按插件隔离，单值上限约 256KB，单插件约 1024 条目。

**复现 / 评估（针对剪藏摘要）**
- 本插件每条剪藏 = `{text, summary, createdAt}`，纯文本剪藏极少超过 256KB（≈13 万汉字）。✅ 单值足够。
- 1024 条上限对「个人剪藏」足够；但**无内置淘汰/分页**：若用户长期剪藏，第 1025 条会写失败（`set` reject），插件需自行处理。本插件未实现淘汰，会在写入时由 `storeValue` 的 catch 静默落到 localStorage 兜底（`ui/index.html:249-255`）——这其实**掩盖了 kv 配额耗尽的真实错误**，是个隐患。

**建议**
1. 文档明确 256KB/1024 的硬性边界与超限后的 `set` 错误码（应给出可识别的 `code` 如 `kv_quota_exceeded` / `kv_value_too_large`，而非泛化错误）。
2. 提供 `sdk.storage.list()` / `delete()` / `count()` 能力，让插件能实现 LRU 淘汰；当前 `sdk.storage` 仅 `get`/`set`（见 `src/index.ts:546-553`），缺管理与淘汰手段。
3. 本插件应改：kv `set` 失败时应提示用户「剪藏已达上限」，而非静默降级到 localStorage（跨隔离、可能破坏配额语义）。

---

## 6. SDK 文档缺口 ⚠️ 中优先

**现象**
- `docs/plugin-development.md` 是权威指南，但：
  1. **未给出「relay 未配置优雅降级」的标准写法**（只字未提 `relay_not_configured` 应怎么 catch）。本插件只能从 `scripts/e2e-desktop-smoke.mjs:216-227` 与宿主 `plugins-runtime.ts:54` 反推。
  2. **`ui.view` 的 `content` 形态未文档化**：插件传 `{type:'markdown', body}` 还是纯字符串？宿主 `enqueueUiView` 接收什么？`src/index.ts:602-607` 只说「可序列化」，未说推荐结构。本插件赌 `{type:'markdown', body}`（宿主侧按 Markdown 渲染，见 `plugins-runtime.ts:16-17`）。
  3. **client 插件与 nodejs/python 插件拿到的 `sdk` 来源不同**（iframe bootstrap vs npm 包），但文档未区分两种运行形态下错误对象的差异（呼应第 1 条）。
  4. **`model` 仅 `fast`/`premium`** 已文档化（✅ 无问题），但未说明「premium 是否额外计费 / 团队额度」——`insufficient_balance` 这类错误码（`src/index.ts:46-62` 测试已覆盖）未列在错误码表中。

**复现**
通读 `docs/plugin-development.md` 与 `src/index.ts` 导出，确认上述 4 点缺失。

**建议**
1. 新增「错误处理与降级」小节：列出 `relay_not_configured` / `request_timeout` / `bridge_unavailable` / `insufficient_balance` / `capability_not_declared` 等 `code` 与推荐 catch 范式。
2. 新增「ui.view content 契约」小节，固定推荐结构（建议 `{type:'markdown'|'json', body}` 或纯字符串），并标注宿主只渲染、不执行。
3. 区分「client 插件（iframe 内 `window.sdk`）」与「nodejs/python 插件（`import { sdk }`）」两栏，说明各自错误归一化差异，直至第 1 条修复统一。

---

## 7. dev 循环：tsx 冷启动 / 无 watch ⚠️ 低优先

**现象**
`cli:dev` = `tsx src/cli/index.ts`，每次调用都冷启动 tsx + 全量解析 TS，对「改一行 HTML 想立刻 build」的循环略慢（约 1-2s 起步，依机器）。本插件是纯 HTML，`build` 不编译 TS，但 CLI 自身仍走 tsx。无 `watch`/`--watch` 模式。

**复现**
连续两次 `cli:dev -- build` 各自有可感知的 tsx 启动耗时。

**建议**
对纯静态插件（client），提供 `build` 的 `node` 直跑入口或预编译 CLI，消除 tsx 启动开销；或加 `lingfang-plugin dev` 监听 `manifest.json`/`entry` 变化自动 rebuild。

---

## 8. 无问题项（显式确认，避免遗漏）

| 项 | 结论 |
|---|---|
| `client` 运行时 `entry` 必须为 `.html`（`ruleEntryRuntimeMatch`） | ✅ 无问题，`ui/index.html` 通过，规则清晰 |
| manifest 校验 7+1 条业务规则（id 格式、版本非 0.0.0、capability 已知、risk=medium/high 必填 reason 等） | ✅ 无问题，报错精确（`[schema_invalid]` / `[rule_xxx]` 风格），本插件首次即通过 |
| `ui.view` 是否已落地 | ✅ 无问题（澄清任务担忧）：契约 `plugin.ts:22` 含 `ui.view`；宿主 `plugins-runtime.ts:92-98` 经 `enqueueUiView` 纯前端渲染，不进 Rust 网关，设计如此；`UiViewHost` 组件存在 |
| `clipboard` 能力 | ✅ 无问题，Rust `capability.rs:222-247` 实现 read/write |
| 桌面壳「origin=local 徽标」与「未签名警示」**代码路径** | ✅ 无问题（仅运行时未在本环境跑）：`installationProvenance.ts:18-19` 给出 `local → 本地导入(amber)`；`plugin_security.rs:66-71` `signed=false` 仅状态展示不阻断；`PluginCenterBody.tsx:233-260/358-371` 渲染徽标与 ⚠ 文案 |
| v1 安装策略：本地导入第三方限 `client` 运行时 | ✅ 无问题，本插件正是 client，可导入；`plugin_package_manager.rs:1108-1129` 拦截 nodejs/python |
| `llm.chat` 默认 `model:'fast'`、仅 `fast`/`premium` 合法 | ✅ 无问题，越权模型抛 `unsupported_model`（单测覆盖） |

---

## 9. 未验证项（本环境限制，供验收复核）

以下需 **Windows + WebView2 + `cargo build`** 桌面闭环，本环境无法跑，列明供人工复核：

1. **桌面壳本地导入 `com.lingfang.clip-digest-0.1.0.lfplugin`**：实际能否在 Plugin Center 完成 `install_plugin_artifact`（origin=local）并运行。
2. **F3 来源徽标**：导入后卡片是否显示 amber「本地导入」徽标（`installationProvenance.ts:19`）。
3. **未签名警示**：因无 `manifest.sig`，详情弹层是否显示 ⚠ 文案（`plugin_security.rs:66-71` + `PluginCenterBody.tsx:358-371`）。
4. **完整 e2e**：`scripts/e2e-desktop-smoke.mjs` 第 4/5/6 条断言（storage.kv 真落盘、未声明 kind `capability_not_declared`、llm.chat `relay_not_configured`）针对本插件复跑。注意该脚本目前断言的是内置 `notes` 插件；若要验 `clip-digest` 需把 `NOTES_NAME` 改为「剪藏摘要」或新增用例。
5. **真实剪贴板读取**：`clipboard` 在 WebView2 sandbox 下能否拿到系统剪贴板（需宿主授予，见 `capability.rs:222-247`）。

> 注：所有被标「未验证」的代码路径均已**静态核对存在且逻辑自洽**，仅缺运行时实跑。

---

## 10. 摩擦条目速查（≥5 条实证）

| # | 摩擦 | 优先级 | 现象要点 | 建议要点 |
|---|---|---|---|---|
| 1 | `relay_not_configured` 在 npm SDK 无稳定 `code` | 高 | client 走宿主归一化有 `code`，npm SDK 仅 `message` 前缀 | SDK 内补归一化 + 导出错误码常量 |
| 2 | CLI 命令形态/cwd 敏感 | 高 | `exec lingfang-plugin` 失败；长路径双拼；仅 `cli:dev -- <短相对路径>` 可用 | 文档固定唯一命令 + 路径归一化防双拼 + 友好报错 |
| 3 | CLI 错误输出非结构化 | 中 | 好 code 但默认文本，脚本难解析 | `--json` 友好化 / 字段对齐 |
| 4 | 超时 30s/180s 语义未明示 | 观察 | 合理；AI 长文偏紧；双计时器叠加未文档 | 文档标注 + 允许调用级 timeout |
| 5 | kv 256KB/1024 限额 + 无管理 API | 观察 | 本插件够用；无 list/delete/count；超限错误码缺 | 补配额错误码 + 增存储管理能力 |
| 6 | SDK 文档缺口 | 中 | 缺降级范式、ui.view content 契约、双形态差异、错误码表 | 补齐四块文档 |
| 7 | dev 循环 tsx 冷启动 | 低 | 每次 build 走 tsx | 静态插件免 tsx / 加 watch |
