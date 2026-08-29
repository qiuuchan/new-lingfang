# Relay 探针（relay-probe）

AI 能力面正向验证插件（QX-19 收口）。声明 `llm.chat` / `image.generate` / `video.generate` /
`audio.generate` 四个 kind，加载后依次调用，结果写入 DOM 的 `data-probe-<kind>` 属性：

- `ok:<detail>`：拿到真实（relay 适配器或平台）响应；
- `err:<code>`：按能力网关稳定错误码如实标注（如 `relay_not_configured`）。

用途：`scripts/e2e-cap-closure-verify.mjs` 经 CDP 断言四 kind 正向闭环。
audio 若因 SDK 未接线而失败，属已如实标注的已知缺口（见 WORK_ORDERS QX-19 第 4 条）。

## 本地跑通

```bash
qianxia-plugin build packages/plugin-sdk/examples/relay-probe
```

配好 relay 凭据（设置页或 `QIANXIA_RELAY_API_BASE` / `QIANXIA_RELAY_TOKEN`）后
从插件中心「本地导入」运行，四行徽标应全绿（audio 视 SDK 接线情况标注）。
