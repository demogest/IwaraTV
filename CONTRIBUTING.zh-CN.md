# 开发者贡献参考

简体中文 | [English](CONTRIBUTING.md)

感谢你帮助改进 IwaraTV。本参考面向希望构建、测试、调试或扩展桌面应用的贡献者。

IwaraTV 为独立项目，不隶属于 Iwara，也未获得 Iwara 的赞助、认可或背书。

## 项目结构

主线应用是一个 Tauri 2 桌面应用：

- `src`：Vite、React 和 TypeScript UI。
- `src/lib`：浏览器安全的类型和 UI 辅助函数。
- `src/tauri`：带类型的 Web 到 Tauri 命令封装。
- `src-tauri/src`：Rust 后端，负责 Iwara API、认证、会话捕获、设置、收藏、下载、播放、诊断和系统集成。
- `src-tauri/capabilities`：主窗口的 Tauri 权限面。
- `tests`：覆盖浏览器安全辅助函数和命令边界预期的 Vitest 测试。
- `.github/workflows/build.yml`：CI 检查、打包构建和发布流程。

旧的 Electron 实现已废弃，不应重新引入 `main`。

## 环境要求

- Node.js `24.14.1` 或更新版本。仓库包含 `.node-version`。
- npm `11.11.0` 或更新版本。
- Rust stable。Rust crate 声明了 `rust-version = "1.77.2"`。
- 当前平台所需的 Tauri 系统依赖。
- 用于播放测试的 MPV；如果只修改不涉及播放启动的代码，可暂不安装。

Windows 打包流程中的 `npm run mpv:update` 会下载当前 MPV 构建到 `vendor/mpv`。该命令需要网络，应有意识地运行。

## 首次设置

```bash
npm ci
npm run icons:build
npm run dev:tauri
```

`npm run dev` 只启动 Vite UI 预览，适合做布局调整，但没有 Tauri 命令能力。测试设置、登录、下载、播放、文件对话框、剪贴板或系统集成时，请使用 `npm run dev:tauri`。

## 质量检查

开发过程中可先运行最小相关检查；涉及行为变更的 PR 提交前应运行完整发布门禁：

```bash
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run check:release
```

常用构建命令：

| 命令 | 用途 |
| --- | --- |
| `npm run build:web` | 将 Vite UI 构建到 `dist`。 |
| `npm run build` | 构建 Tauri 应用。 |
| `npm run version:check` | 检查所有应用版本引用是否同步。 |
| `npm run version:update -- patch` | 同时更新 npm、Tauri 和 Cargo 版本元数据。 |
| `npm run release:win` | 运行检查，构建 Windows NSIS 安装包，并打包便携产物。 |
| `npm run release:win:fast` | 不重复运行检查，直接构建 Windows 发布产物。 |
| `npm run dist:win` | 更新内置 MPV、重建图标，并运行 Windows 发布流程。 |

## 编码准则

- 优先沿用现有模块边界，不轻易增加跨模块抽象。
- 保持浏览器运行时代码不依赖 Node.js API。`tests/tauri-boundary.test.ts` 会守住这条边界。
- Tauri 命令需要双向类型完整：Rust 模型在 `src-tauri/src/models.rs`，TypeScript 镜像在 `src/lib/types.ts`，命令封装在 `src/tauri/api.ts`。
- 设置迁移要保持宽容。`settings.rs` 会将已保存 JSON 与默认值合并，让旧设置文件继续可用。
- 不要把密钥写入 JSON 文件。API 凭据应在可用时保存到操作系统钥匙串；WebView 会话数据应留在 WebView 会话面中。
- 尊重用户数据行为。修改 `settings.json`、`downloads.json`、历史记录或认证状态时，应包含迁移或兼容方案。
- 优先提供明确、可行动的错误信息。UI 会在 `src/lib/issue-utils.ts` 中分类常见问题。

## 添加 Tauri 命令

新增命令时：

1. 在 `src-tauri/src/models.rs` 新增或更新共享数据结构。
2. 在 `src-tauri/src/commands.rs` 实现命令。
3. 在 `src-tauri/src/lib.rs` 的 `tauri::generate_handler!` 中注册命令。
4. 在 `src/tauri/api.ts` 的 `commandMap` 中添加命令字符串。
5. 从 `tauriApi` 暴露带类型的调用封装。
6. 更新 `src/lib/types.ts` 中的 TypeScript 类型。
7. 新增或更新 `tests/tauri-api.test.ts`。
8. 如果功能需要新的插件权限，检查 `src-tauri/capabilities/default.json`。

## 功能区域

- **Iwara API 和解析**：请求逻辑放在 `iwara_client.rs`，解析辅助函数应贴近 API 响应结构。
- **会话和 Cloudflare 验证**：浏览器会话工作放在 `session.rs`；避免把原始 token 或 cookie 细节泄漏到 UI 日志。
- **播放**：播放器解析和进程启动放在 `player.rs`；外部播放器参数解析放在 `player_template.rs`。
- **收藏**：本地收藏持久化、导入、导出、备份和合并行为放在 `favorites.rs`。
- **下载**：队列和历史行为放在 `downloads.rs`；文件命名、格式选择和分段传输规划靠近 Iwara client 的下载路径。
- **设置**：默认值、规范化和兼容逻辑放在 `settings.rs`。
- **媒体域名测速**：浏览器安全的共享规范化辅助函数放在 `src/lib/media-speed-utils.ts`；Rust 路由逻辑保留在 `media_speed.rs`。

## Pull Request 检查清单

- 描述用户可见行为和受影响平台。
- 关联 issue，或说明变更动机。
- 可见 UI 变更应附截图或短录屏。
- 写明运行过的命令，尤其是 `npm run typecheck`、`npm test` 和 Rust 测试。
- 说明未能运行的检查。
- 除非变更目标就是发布产物，否则不要提交生成的 release artifact。
- 不要提交个人设置、token、下载的视频或本地 WebView/会话数据。

## 发布说明

补丁发布使用 `npm run version:update -- patch`，较大的版本递增可使用 `minor` 或 `major`，也可以传入精确 semver，例如 `npm run version:update -- 1.2.3`。脚本会更新 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`，以及 `src-tauri/Cargo.lock` 中的 `iwaratv` 条目。发布前只想确认版本元数据一致时，运行 `npm run version:check`。

GitHub `Build` 工作流会在 pull request 上运行检查。`main` 上的 `package.json` 版本变化，或推送类似 `v1.0.0` 的版本标签时，会构建发布产物。带标签的发布会通过 GitHub Releases 发布生成的资产和校验和。
