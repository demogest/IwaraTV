<div align="center">
  <img src="src/renderer/assets/iwara-tv-mark.svg" alt="IwaraTV 标志" width="80" height="80">
  <h1>IwaraTV</h1>
  <p>简体中文 | <a href="README.md">English</a></p>
  <p>
    <a href="https://github.com/demogest/IwaraTV/actions/workflows/build.yml"><img src="https://github.com/demogest/IwaraTV/actions/workflows/build.yml/badge.svg?branch=main" alt="Build"></a>
    <a href="https://github.com/demogest/IwaraTV/releases"><img src="https://img.shields.io/github/v/release/demogest/IwaraTV?include_prereleases&amp;sort=semver" alt="Release"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f.svg" alt="License: MIT"></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-44-47848f?logo=electron&amp;logoColor=white" alt="Electron 44"></a>
    <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61dafb?logo=react&amp;logoColor=111111" alt="React 19"></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&amp;logoColor=white" alt="TypeScript 6"></a>
    <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-8-646cff?logo=vite&amp;logoColor=white" alt="Vite 8"></a>
    <a href="#发布"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555" alt="平台"></a>
  </p>
</div>

IwaraTV 是一个用于浏览 Iwara.tv、并在 MPV 或其他本地播放器中播放视频的桌面应用。可以浏览和搜索视频、直接打开任意视频链接、关注作者和标签、发表评论、保存本地收藏和播放历史，并通过可续传的多线程下载保存视频。

本项目为独立制作，不隶属于 Iwara，也未获得 Iwara 的赞助、认可或背书。

## 文档

- [用户手册](docs/user-manual.zh-CN.md) / [User Manual](docs/user-manual.en.md)
- [开发者贡献参考](CONTRIBUTING.zh-CN.md) / [Developer Contribution Guide](CONTRIBUTING.md)
- [UI/UX 与安全审计报告（英文）](docs/audit.md)

## 功能亮点

- 最新、当前人气、流行视频和关注标签四个列表，支持标签筛选和分级切换。
- 顶部只有一个输入框：输入文字即搜索，粘贴 Iwara 链接或视频 ID 即打开视频。
- 视频页可选择清晰度，一键用 MPV 播放、下载、收藏、关注作者，查看标签和带回复的评论。
- 订阅页展示已关注作者的新视频，可按作者筛选。
- 本地收藏支持撤销、备份、导出和导入；播放历史按日期分组。
- 下载管理支持多连接分段下载、取消或重启后续传、重试，并显示进度、速度和剩余时间。
- 在独立窗口中通过 Iwara 官方页面登录，应用不会接触你的密码。
- 支持简体中文和英文、浅色和深色主题、键盘快捷键和可折叠侧边栏。
- 故障排查工具：与网页版对比清晰度、CDN 线路测速、刷新 X-Version 盐值。

## 环境要求

- Node.js 24.14.1+ 和 npm 11.11.0+（见 `.node-version`）。
- 播放需要 MPV（Windows 发布版已内置），或在设置中配置其他播放器。

## 开发

```bash
npm ci
npm run dev
```

`npm run dev` 启动带热重载的完整 Electron 应用。`npm run dev:web` 只在浏览器中打开界面（http://127.0.0.1:5175），使用模拟数据，适合调整布局；可在地址后加 `?lang=zh-CN`、`?theme=light`、`?signedIn=0` 或 `?empty=1`。

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 以热重载方式运行桌面应用。 |
| `npm run dev:web` | 在浏览器中用模拟数据预览界面。 |
| `npm run typecheck` | 对渲染进程以及主进程、preload、测试代码做类型检查。 |
| `npm test` | 运行 Vitest 单元测试、边界测试和安全测试。 |
| `npm run test:e2e` | 构建后让真实应用连接模拟 Iwara 服务器进行端到端冒烟测试（Linux 下用 `xvfb-run -a` 包裹）。 |
| `npm run build` | 将主进程、preload 和渲染进程构建到 `out/`。 |
| `npm start` | 运行最近一次构建。 |
| `npm run pack` | 在 `release/` 中生成未打包安装程序的应用目录，便于本地检查。 |
| `npm run dist:win` / `dist:mac` / `dist:linux` | 使用 electron-builder 生成安装包。 |
| `npm run check:release` | 版本检查、类型检查和单元测试。 |
| `npm run version:update -- patch` | 同步更新 `package.json` 和 `package-lock.json` 中的版本号，也可使用 `minor`、`major` 或具体版本号。 |

打包内置 MPV 的 Windows 版本：

```bash
npm run mpv:update
npm run dist:win
```

Windows 会生成 `IwaraTV_<version>_x64-setup.exe`、`IwaraTV_<version>_x64-portable.exe` 和 `IwaraTV_<version>_x64-unpacked.zip`；macOS 生成 `.dmg`；Linux 生成 `.deb` 和 `.AppImage`。

## 架构

- `src/main` — Electron 主进程：Iwara API 客户端、Iwara 浏览器会话、下载、播放器启动、设置与收藏存储、IPC 处理。
- `src/preload` — 页面唯一的桥接层：带白名单的 `window.iwaraTV.invoke/on`。
- `src/renderer` — React 界面（视图、组件、状态、多语言、样式）。
- `src/shared` — 两端共用的类型、IPC 约定、错误码和工具函数。
- `tests` — 单元、边界和安全测试；`tests/e2e` 为冒烟测试和模拟服务器。

渲染进程运行在沙箱中，启用上下文隔离且无法访问 Node.js，通过私有的 `app://` 协议加载并启用严格的 Content-Security-Policy，只能调用 `src/shared/ipc.ts` 中声明的通道。Iwara 页面（登录和验证）在独立的沙箱窗口中打开，使用单独的会话且不加载 preload。打包后的应用关闭了 Electron 的 RunAsNode、`NODE_OPTIONS` 和调试器相关 fuse。

从 Tauri 版本升级：首次启动时会自动导入设置、收藏和下载记录，需要重新登录一次。

## 发布

发布前运行 `npm run version:update -- <major|minor|patch|x.y.z>`；`npm run version:check` 可检查 `package.json` 与 `package-lock.json` 的版本是否一致。

`Build` 工作流会在每个 Pull Request 和推送上运行版本检查、类型检查、单元测试和端到端冒烟测试。当 `main` 上的版本号变化时，会为该提交创建标签；标签构建会打包 Windows、macOS 和 Linux 产物，并发布附带校验和的 GitHub Release。

## 许可证

IwaraTV 以 [MIT License](LICENSE) 发布。
