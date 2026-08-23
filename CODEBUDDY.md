# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## Overview

**my-treasure** ("灵坊工作台" / LingFang Workbench) is a Tauri v2 desktop **plugin platform**. It
runs third-party plugins locally inside a desktop shell. The defining architectural choice is a
**zero-server model**: there is no backend in this repo. Client-plugin execution and every
privileged call it makes go through Tauri commands with capability checks; nodejs/python plugins
run as local OS processes whose containment story is install-time trust, not a runtime sandbox
(see "Security model" for the honest three-tier boundary).

The repo is a hybrid monorepo: a **pnpm workspace** for the TypeScript side and a **Cargo workspace**
for the Rust/Tauri shell. Backend services (relay / billing / RBAC / AI creator) and the older Rust
server crate have been deliberately removed — the workspace comment in `pnpm-workspace.yaml` and the
contract source headers say so explicitly. Do not reintroduce them.

## Commands

Prereqs: Node >= 20, pnpm 9 (`packageManager` is pinned in `package.json`). Rust work needs the
Windows MSVC toolchain + WebView2 runtime; the installer crate additionally needs `rc.exe`.

```bash
# Install JS deps (also pulls playwright-core, needed by runtime verification)
pnpm install

# Type-check everything (recursive `tsc --noEmit` per package)
pnpm typecheck
pnpm -C packages/contract typecheck        # single package

# Run tests (recursive `vitest run`)
pnpm test
pnpm -C packages/plugin-sdk test           # single package
pnpm -C packages/contract exec vitest run src/plugin.test.mjs   # one file
pnpm -C packages/contract exec vitest run -t "grant resolution" # filter by name
# (contract tests are *.test.mjs; plugin-sdk tests are *.spec.ts)

# Format ONLY (there is NO eslint and NO `lint`/`format` script)
pnpm exec prettier --check .
pnpm exec prettier --write .

# Desktop app — requires the Rust toolchain + WebView2
pnpm dev:desktop          # = pnpm -C apps/desktop dev  = `tauri dev`
pnpm build:desktop        # = pnpm -C apps/desktop build = `tauri build`
pnpm -C apps/desktop build:frontend   # runtime:verify + vite build (frontend only)

# Rust shell directly
cd apps/desktop/src-tauri && cargo build && cargo test

# Plugin SDK CLI (create / validate / build / publish)
pnpm plugin:create        # = pnpm -C packages/plugin-sdk exec lingfang-plugin create
pnpm plugin:validate
pnpm plugin:build
pnpm plugin:publish
pnpm -C packages/plugin-sdk cli:dev     # run the CLI source directly (tsx)

# Bundled runtimes (see "Runtimes" below). NOTE: `apps/desktop/runtimes/` is
# currently empty and `runtime-lock.json` does not exist, so these error until
# the lock file is generated/materialized.
pnpm -C apps/desktop runtime:prepare    # concat split parts -> runtimes/, verify sha256
pnpm -C apps/desktop runtime:verify     # prepare + verify integrity + Playwright drift check

# Installer (separate crate, NOT in the Cargo workspace)
cd apps/desktop/installer && cargo build
```

## Architecture

### Packages (pnpm workspace: `apps/desktop`, `packages/*`)

- **`apps/desktop`** (`@lingfang/desktop`) — the Tauri v2 shell.
  - *Frontend*: React 18 + Vite 6 + TS 5 + Tailwind v4 + `zustand` (state) + `next-themes`
    (dark default) + `framer-motion` + `@base-ui/react`. Entry: `index.html` → `src/main.tsx`
    (error boundary + theme) → `src/App.tsx`. All Tauri I/O is centralized in `src/lib/api.ts`
    (`tauriInvoke` / `tauriListen` over `window.__TAURI__`; `withGlobalTauri: true`). Plugin
    registry access is wrapped in `src/lib/plugin-registry.ts` (calls Tauri commands).
  - *Rust* (`src-tauri`): the real engine. Key modules:
    - `plugin_store.rs` — `PluginStore`, scans `plugins_root`, lists/reads plugin files.
    - `plugin_package_manager.rs` — install/rollback/uninstall, draft workspaces, inspect
      `.lfplugin` v4 artifacts; `register_builtins` seeds the built-in plugins.
    - `plugin_runner.rs` — `start_plugin`, spawns `client`/`nodejs`/`python` processes in a
      Windows Job Object sandbox, streams output via the `plugin:output` / `plugin:exited`
      Tauri events.
    - `runtime_resolver.rs` — `RuntimeResolver`, the **single** source of all node/python/ffmpeg/
      chromium invocations (see Runtimes).
    - `capability.rs` — the capability **gateway** (`invoke_capability` command) enforcing
      declared capabilities.
    - `plugin_security.rs` — minisign signature verification + recall checks.
    - `plugin_net_fetch.rs` — host-side HTTP with SSRF guards (30s / 10 MiB limits).
    - `plugin_llm_bridge.rs` — injects `LINGFANG_PLUGIN_BRIDGE_URL` / `LINGFANG_PLUGIN_BRIDGE_TOKEN`
      into plugin processes so they can reach LLM/image/video capabilities without holding keys.
  - Exposed Tauri commands (all `#[tauri::command]`): `list_plugins`, `start_builtin_plugin`,
    `read_plugin_file`, `invoke_capability`, `plugin_net_fetch`, `plugin_script::*`,
    `plugin_llm_bridge::*`, `plugin_shell::run_plugin_shell`, `runtime_commands::get_runtime_status`,
    `plugin_runner::{start,stop,delete,get_status}_plugin`, `plugin_store::*`,
    `plugin_package_manager::commands::*`, `plugin_security::*`.

- **`packages/contract`** (`@lingfang/contract`) — the **single source of truth** for all host↔
  plugin types. Zod schemas only; it contains **no host logic**. `src/index.ts` re-exports ~21
  domain modules (`plugin`, `plugin-action`, `plugin-shared-state`, `plugin-registry`, `llm`,
  `draft`, `rbac`, `billing`, `marketplace-*`, `local-scheduler`, …). Key shapes: `RuntimeType`
  (`client|cloud|nodejs|python|workflow`), `CapabilityKind` (17 kinds), `PluginManifest`
  (snake_case boundary), `PluginGrant` + `resolveGrant()` (deny-wins). **Contract drift is treated
  as a defect** — keep it authoritative and reuse its types everywhere.

- **`packages/plugin-sdk`** (`@lingfang/plugin-sdk`) — what plugin authors import, plus the
  `lingfang-plugin` CLI. `src/index.ts` exports the typed `sdk` object — the real host API surface
  a plugin calls (`fs`, `net.fetch`, `clipboard`, `storage`, `shared`, `system`, `llm`, `image`,
  `video`, `artifacts`, `ui`, `plugin`). Every method routes through the host-injected bridge with
  capability-gated timeouts (30s default, 180s AI, 24h+30s actions). `lingfang-plugin` commands:
  `create` (scaffolds `client`/`nodejs`/`python` from `src/templates/*`), `validate`
  (`validateManifest()` = Zod parse + 7 business rules in `src/manifest/rules.ts`, e.g.
  `ruleEntryRuntimeMatch` enforces `client→.html`, `nodejs→.js/.mjs/.cjs`, `python→.py`),
  `build` (packs a `.lfplugin` v4 zip via `util/archive.ts` — never hand-zip), `publish`
  (uploads to registry). See `packages/plugin-sdk/README.md`.

- **`packages/ui-tokens`** (`@lingfang/ui-tokens`) — design tokens only (`tokens.css`, CSS vars
  like `--lf-color-primary`). The host injects these into every plugin iframe; plugins must consume
  tokens, never hardcode colors.

### Plugin model

- **Runtime types**: `client` (HTML rendered in an iframe inside the desktop frontend), `nodejs`
  and `python` (spawned as detached OS processes by `plugin_runner.rs`). `cloud` / `workflow` exist
  in the contract but are handled by the platform cloud, not by these local templates.
- **Manifest** (`manifest.json`, snake_case) is the plugin's identity + contract: `id`
  (`com.<author>.<name>`), `name`, `version` (StrictSemVer, not `0.0.0`), `runtime_type`, `entry`,
  `visibility` (`private|tenant`), `capabilities[]` (each with `kind`/`reason`/`risk`/
  `requires_admin`), `actions[]`, `shared_namespaces[]`. Plugins must declare every capability they
  use; the README must explain each capability's data access and privacy impact.
- **Capability gateway**: plugins never call the network or hold LLM keys directly. Privileged ops
  (`fs.read/write` path-whitelisted with 1 MiB limits, `system.info`, `clipboard`, `screenshot`,
  `net.fetch` SSRF-guarded, `llm.chat`, `image/video` generate via the LLM bridge) are executed by
  the host after a triple-check against declared capabilities. Grants resolve deny-wins
  (user > role, deny-default-allow).
- **Host↔plugin communication**:
  - Frontend ⇄ Rust: `tauriInvoke` / `tauriListen` on `window.__TAURI__`; events
    `plugin:output`, `plugin:exited`, `plugin:start-progress`, `close-requested`, plus
    `tauri::Channel` for transfer progress.
  - Client iframe ⇄ host: host injects `window.__lingfangInvoke(capability, args)` into the iframe.
  - nodejs/python ⇄ host: a localhost HTTP bridge at `LINGFANG_PLUGIN_BRIDGE_URL` with routes
    `/llm/chat`, `/image/generate`, `/image/edit`, `/video/generate`, `/actions/call`,
    `/artifacts/*`, all gated by the capability gateway.
- **Built-in plugins** are compiled *into the binary*: `apps/desktop/src-tauri/build.rs`
  (`generate_builtin_bundle`) zips each dir in `apps/desktop/builtin-plugins/` into a sha256-named
  `.lfplugin`, writes `index.json`, and emits `builtin_plugin_bundle.rs` embedded via
  `include_bytes!`. `main.rs` calls `register_builtins(INDEX_JSON, ARTIFACTS)`. Current built-ins:
  `calculator` (python/PySide6), `game-2048` (nodejs), `notes` (client HTML).

### Runtimes

A **runtime** = app-bundled language runtimes for plugins: `node`, `python`, `ffmpeg`, `chromium`
(Playwright). `apps/desktop/runtimes/` ships empty in source; it is populated at dev/build time from
`apps/desktop/runtimes/runtime-lock.json` via the two scripts in `scripts/`:
`materialize-bundled-runtimes.mjs` concatenates split `parts` into target files and verifies sha256;
`verify-bundled-runtimes.mjs` checks `requiredFiles`/`keyFiles` and cross-checks Playwright
revision/browserVersion drift. `RuntimeResolver` (`runtime_resolver.rs`) is the only entry point for
running these; it **never consults system PATH** — only `runtimes/` (resolved from exe dir / resource
dir / `LINGFANG_EMBEDDED_RUNTIME_DIR`), injecting bundled PATH plus Tsinghua PyPI / npmmirror npm
mirrors. `plugin_runner.rs` uses it to create Python venvs and run `pnpm`/`npm install`, spawning
sandboxed processes.

### Security model (three-tier boundary, stated honestly)

**Tier 1 — client plugins: a real runtime boundary.** Client HTML runs in a sandboxed iframe
(`sandbox="allow-scripts"`, srcdoc, no `allow-same-origin` → opaque origin `'null'`). Its only
privileged channel is the host-injected `window.sdk` facade; every call is source-checked
(`event.source === iframe.contentWindow`, `event.origin === 'null'`) and routed through the
capability gateway. Plugin JS cannot reach the host page, Tauri IPC, or sibling plugins.

**Tier 2 — process plugins: a lifecycle fence, NOT a security boundary.** nodejs/python plugins
run as regular OS processes under a Windows Job Object (`process_util/sandbox.rs`) whose only
guarantees are process-tree containment and kill-on-close (`KILL_ON_JOB_CLOSE`,
`DIE_ON_UNHANDLED_EXCEPTION`, no `BREAKAWAY_OK`). There is no restricted token, integrity level,
AppContainer, or filesystem/network isolation: a process plugin runs with the user's full
privileges and CAN bypass the SDK to touch the network or user-readable files directly. The
capability gateway constrains only calls that go through the SDK/bridge — it is an API contract
for honest plugins, not a wall against malicious ones.

**Tier 3 — the real defense for process plugins is install-time trust.** `.lfplugin` packages
are minisign-verified (`plugin_security.rs` `verify_plugin_signature_command`; `signed=false`
does not block — status display only) and checked against a recall list
(`check_plugin_recall_command`). Until a plugin-signing trust root exists for the ecosystem,
**v1 policy restricts third-party (local-import) installs to client plugins** — nodejs/python
installs are reserved for built-in/first-party signed plugins (`IMPROVEMENT_PLAN.md` F2).

Built-in bundles are validated at startup (`builtin_plugin_index.rs`: sorted, SemVer, sha256
format).
