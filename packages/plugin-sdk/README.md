# LingFang Plugin SDK

用于创建、校验、构建和发布 LingFang 插件。详细约定见[插件开发说明](../../docs/plugin-development.md)。

## 快速开始

```bash
lingfang-plugin create
cd <plugin-directory>
lingfang-plugin validate
lingfang-plugin build
lingfang-plugin publish
```

`create` 支持 `client`、`nodejs` 和 `python` 模板，并生成 `manifest.json`、运行时入口和可直接修改的 `README.md`。

## 描述文件

- `manifest.description`：列表、搜索和卡片中的纯文本短摘要，最多 4096 个字符。
- 根目录 `README.md`：详情页正文，可选但强烈推荐；必须是 UTF-8，最大 256 KiB。
- README 支持安全 GFM。不要依赖 raw HTML、脚本、样式或图片；可点击链接仅支持 HTTP(S)。
- README 随发行版冻结。修改说明后需要提升 `manifest.version` 并发布新版本。

## Runtime 与能力

`manifest.runtime_type` 决定入口运行方式，`manifest.entry` 必须指向对应入口文件：

- `client`：桌面端内嵌页面，通常为 `ui/index.html`。
- `nodejs`：Node.js 独立进程入口。
- `python`：Python 独立进程入口。
- `cloud` / `workflow`：由平台云运行与工作流能力处理，不能套用前三种模板的本地入口假设。

插件使用的能力必须在 `manifest.capabilities` 中声明。代码通过 `@lingfang/plugin-sdk` 调用宿主能力，不直接读取平台密钥或桥接令牌；README 应解释每项能力的用途、访问的数据和隐私影响。

## CLI 门禁

`validate` 和 `build` 使用相同的 manifest、入口与 README 边界。README 超限或不是 UTF-8 时，`build` 会在生成 `.lfplugin` 前失败。`.lfplugin` 必须由 `lingfang-plugin build` 生成，不要手工压缩 ZIP。
