# IwaraTV

简体中文 | [English](README.md)

[![Build](https://github.com/demogest/IwaraTV/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/demogest/IwaraTV/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/demogest/IwaraTV?include_prereleases&sort=semver)](https://github.com/demogest/IwaraTV/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24c8db?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=111111)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-stable-b7410e?logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)](https://vite.dev/)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555)](#发布)

![IwaraTV logo](src/assets/iwara-tv-mark.svg)

IwaraTV 是一个本地桌面端 Iwara.tv 浏览器与播放器启动器。React 界面保持轻量和快速，Tauri/Rust 后端负责会话、Iwara API、设置、诊断、下载和播放器启动。

本项目为独立制作，不隶属于 Iwara，也未获得 Iwara 的赞助、认可或背书。

## 文档

- [用户手册](docs/user-manual.zh-CN.md) / [User Manual](docs/user-manual.en.md)
- [开发者贡献参考](CONTRIBUTING.zh-CN.md) / [Developer Contribution Guide](CONTRIBUTING.md)

## 功能亮点

- 浏览最新、当前人气、长期热门、关注标签、订阅作者和指定作者的视频列表。
- 直接在顶部输入 Iwara 视频 ID 或 URL 打开详情。
- 在视频详情或作者页关注、取消关注作者。
- 保存本地收藏，并可备份、导出或导入收藏列表。
- 使用 MPV 或自定义外部播放器，以指定清晰度启动播放。
- 下载视频到本地文件夹，并在首选清晰度不可用时自动回退。
- 保留本地播放历史，以及播放器、媒体线路等偏好设置。
- 使用应用内验证窗口完成登录、Cloudflare 验证和站点会话准备。
- 诊断视频清晰度、X-Version 盐值、媒体域名和抓包到的网络响应。
- 通过 GitHub Actions 构建 Windows、macOS 和 Linux 原生安装包。

## 应用流程

启动后即进入可用的浏览界面：浏览视频列表、打开详情、选择清晰度，然后立即播放、收藏或下载。设置页覆盖登录和会话状态、MPV/外部播放器路径、下载默认值、媒体线路测速、X-Version 嗅探和标签偏好。

## 环境要求

- Node.js 24.14.1+
- npm 11.11.0+
- Rust stable
- 当前平台所需的 Tauri 系统依赖

## 开发

```bash
npm ci
npm run icons:build
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run dev:tauri
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Vite UI 预览。 |
| `npm run dev:tauri` | 运行带 Tauri 命令的完整桌面应用。 |
| `npm run typecheck` | 检查 React/TypeScript UI 类型。 |
| `npm test` | 运行 Vitest 测试。 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 运行 Rust 测试。 |
| `npm run build:web` | 将 Web UI 构建到 `dist`。 |
| `npm run build` | 构建 Tauri 应用。 |
| `npm run check:release` | 运行 TypeScript、Vitest 和 Rust 发布前检查。 |
| `npm run release:portable:win` | 将当前 Windows release 构建打包为便携 EXE 和解包 ZIP。 |
| `npm run release:win` | 运行发布检查，然后构建 Windows NSIS 安装包、便携 EXE 和解包 ZIP。 |
| `npm run release:win:fast` | 不重复运行检查，直接构建 Windows 发布产物。 |

带内置 MPV 的 Windows 打包：

```bash
npm run mpv:update
npm run dist:win
```

Release 构建会启用 Rust LTO、单 codegen unit、符号剥离和 panic abort。Tauri devtools 只会通过 `npm run dev:tauri` 启用，因此打包版本不会带上开发工具特性。Windows 发布会生成 NSIS 安装包，以及 `release/IwaraTV_<version>_x64-portable.exe` 和 `release/IwaraTV_<version>_x64-unpacked.zip`。

## 架构

`main` 分支是 Tauri/Rust 桌面应用。旧的 Electron 实现已废弃，只应保留在历史分支中。

- `src-tauri/src` 负责原生端工作：Iwara API、认证、会话捕获、设置、下载、播放器启动、X-Version、诊断和系统集成。
- `src` 是 Vite/React UI 入口。
- `src/lib` 包含浏览器安全的 UI 类型和辅助函数。
- `src/tauri` 包含 Web 到 Rust 的命令 API。
- `tests` 覆盖 UI 辅助函数和命令边界预期。

## 发布

`Build` 工作流会在 pull request 上运行检查；当 `main` 上的包版本变化时编译发布产物，也支持手动构建。类似 `v1.0.0` 的版本标签会发布 GitHub Release，并附带生成的安装包和校验和。

## 许可证

IwaraTV 基于 [MIT License](LICENSE) 发布。
