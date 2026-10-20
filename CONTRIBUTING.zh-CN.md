# 开发者贡献参考

简体中文 | [English](CONTRIBUTING.md)

感谢你帮助改进 IwaraTV。本文面向希望构建、测试、调试或扩展桌面应用的贡献者。

IwaraTV 为独立项目，不隶属于 Iwara，也未获得 Iwara 的赞助、认可或背书。

## 项目结构

IwaraTV 是基于 electron-vite 构建的 Electron 应用：

- `src/main` — 主进程。
  - `index.ts` — 应用生命周期、`app://` 协议、窗口创建与加固、系统集成。
  - `backend.ts` — 组装各个存储和服务，每个 IPC 通道对应一个方法。
  - `ipc-handlers.ts` / `ipc.ts` — 通道到处理函数、通道到参数校验函数的映射表，以及注册逻辑。
  - `services/` — `iwara-client`（API、文件列表、评论、关注、测速）、`iwara-session`（`persist:iwara` 浏览器会话、登录窗口、页面上下文请求、网络抓包）、`download-manager`、`player-service`、`settings-store`、`favorite-store`、`update-service`（自动更新）。
  - `lib/` — 不依赖 Electron 的工具：X-Version、JWT 识别、响应解析、文件传输、JSON 文件读写、旧版数据迁移、版本比较以及更新清单与安装。
- `src/preload/index.ts` — 暴露 `window.iwaraTV`，`invoke` 与 `on` 均为白名单。
- `src/renderer` — React 界面：`views/`、`components/`、`state/`（应用状态、导航、提示、确认对话框）、`hooks/`、`i18n/`（`en.ts`、`zh-CN.ts`、`zh-TW.ts`、`ja.ts`）、`styles/`，以及用于浏览器预览的 `dev/mock-bridge.ts`。
- `src/shared` — 两个进程共用的类型、IPC 约定（`ipc.ts`）、错误码、CSP 和工具函数。
- `tests` — Vitest 测试；`tests/e2e` — Playwright 冒烟测试和模拟 Iwara 服务器。
- `.github/workflows/build.yml` — CI 检查、打包和发布。

## 前置条件

- Node.js `24.14.1` 或更高版本（`.node-version`），npm `11.11.0` 或更高版本。
- 测试播放需要 MPV。
- 仅 Linux 运行 `npm run test:e2e` 时：需要 `xvfb`（或桌面会话）和 `openssl`。

在 Windows 打包流程中，`npm run mpv:update` 会把当前 MPV 构建下载到 `vendor/mpv`。它需要网络访问，应在明确需要时运行。

## 首次设置

```bash
npm ci
npm run dev
```

Electron 二进制会在首次使用时下载。`npm run dev:web` 只启动界面并使用模拟后端（`src/renderer/dev/mock-bridge.ts`）；可用 `lang`、`theme`、`signedIn=0` 和 `empty=1` 查询参数切换模拟状态。

## 质量门禁

```bash
npm run typecheck
npm test
npm run test:e2e        # Linux：xvfb-run -a npm run test:e2e
npm run check:release
```

单元测试覆盖：基于假 fetch 的 Iwara 客户端、基于本地 Range 服务器的下载、各存储、播放器服务、自动更新（`tests/updates.test.ts`）、IPC 参数校验、翻译，以及静态边界/安全规则（`tests/boundaries.test.ts`）。冒烟测试会构建应用，并针对 `tests/e2e/mock-iwara.mjs` 依次验证浏览、悬停预览、搜索与最近搜索、快捷键列表、MPV 播放（使用 MPV 替身）、使用真实片段（`tests/e2e/fixtures/sample.mp4`）的内置播放器（含全屏、续播和继续观看）、相关视频、下载、收藏、登录、订阅、关注、评论、设置、从本地文件夹提供的已签名更新和退出登录，截图保存在 `test-results/e2e/`。设置 `IWARATV_E2E_EXECUTABLE` 可针对打包后的应用运行（仅适用于未关闭调试器 fuse 的构建，因为 Playwright 依赖它连接）。

## 编码约定

- 保持进程边界：渲染进程不得引入 Node.js、Electron 或 `src/main`；`src/shared` 不引入自身以外的模块；preload 只引入 `electron` 和 IPC 约定。`tests/boundaries.test.ts` 会检查这些规则。
- 不要削弱 `webPreferences`（`sandbox`、`contextIsolation`、`nodeIntegration: false`、`webSecurity`）、CSP、导航与权限处理，以及 IPC 发送方校验。
- `src/main/lib` 和除 `iwara-session` 以外的服务不要引入 Electron，以便单元测试；Electron 功能通过 `SessionPort` 和 `PlatformPort` 注入。
- 抛出带具体 `AppErrorCode` 的 `AppError`。渲染进程在 `src/renderer/lib/errors.ts` 中把错误码映射为本地化的标题、说明和恢复操作。
- 所有用户可见文字都要加入全部四个词典（`en.ts`、`zh-CN.ts`、`zh-TW.ts`、`ja.ts`）；类型系统和 `tests/renderer.test.ts` 会检查键名和占位符。请写完整的句子，不要把名称拼接进句子里，因为各语言的语序和空格规则不同。会显示给用户的主进程错误会在 details 中带上 `reason`，翻译位于 `errors.<CODE>.reasons`。支持的语言及系统语言匹配逻辑位于 `src/shared/locales.ts`。
- 设置需保持兼容：`normalizeSettings` 会把保存的 JSON 合并到默认值上并限制取值范围，旧文件可以继续使用。
- 不要在日志中输出令牌、Cookie 或带签名的媒体链接；诊断信息使用 `safeUrl`。

## 新增 IPC 通道

1. 如有需要，在 `src/shared/types.ts` 中添加请求/响应类型。
2. 在 `src/shared/ipc.ts` 的 `InvokeContract` 和 `INVOKE_CHANNELS` 中声明通道。
3. 在 `Backend`（`src/main/backend.ts`）中实现方法。
4. 在 `src/main/ipc-handlers.ts` 中添加处理函数和参数校验函数——校验函数必须拒绝任何意外输入，并只复制已知字段。
5. 在渲染进程中通过 `src/renderer/lib/api.ts` 的 `invoke("your:channel", …)` 调用，并在 `src/renderer/dev/mock-bridge.ts` 中补充模拟实现。
6. 在 `tests/ipc.test.ts` 中添加正常调用示例（缺少示例的通道会导致测试失败），并为新行为编写测试。

## Pull Request 检查清单

- 描述用户可见的行为变化和受影响的平台。
- 关联 Issue 或说明动机。
- 可见的界面改动请附截图（涉及颜色时请包含两种主题）。
- 列出运行过的命令：`npm run typecheck`、`npm test`、`npm run test:e2e`。
- 不要提交构建产物（`out/`、`release/`）、测试截图、个人设置、令牌、下载的视频或会话数据。

## 发布说明

使用 `npm run version:update -- patch`（或 `minor`、`major`、具体的语义化版本号如 `1.2.3`）。脚本会更新 `package.json` 和 `package-lock.json`，electron-builder 从中读取版本号。`npm run version:check` 用于确认两者一致。

GitHub 的 `Build` 工作流会在 Pull Request 和推送时运行检查。在 `main` 上，版本号变化会创建 `v*` 标签并触发标签构建，打包 Windows（NSIS 安装包、便携版 EXE、ZIP）、macOS（DMG）和 Linux（DEB、AppImage），并发布附带 `SHA256SUMS.txt` 和 `update.json`（应用内更新读取的清单）的 GitHub Release。

更新签名由维护者配置一次：运行 `npm run update:keygen`，把它写到仓库外的私钥保存为 `release` 环境（仅允许 `v*` 标签使用）的 `UPDATE_SIGNING_KEY` 机密，并提交 `build/update-public-key.pem`（详细步骤见 [docs/auto-update.md](docs/auto-update.md#setting-up-signing)）。此后发布任务会为 `update.json` 签名，密钥缺失或不匹配时拒绝发布；从该提交构建的应用只接受已签名的更新。除非私钥丢失或泄露，不要替换已提交的公钥，否则已安装的应用会拒绝之后的所有更新。要在开发版本中试用更新，可将 `IWARATV_UPDATE_URL` 指向一个本地文件夹，其中放有由 `scripts/update-manifest.mjs` 生成的清单，详见 [docs/auto-update.md](docs/auto-update.md#testing)。
