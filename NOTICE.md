# NOTICE

本应用（仓库源码）以 MIT 授权。

发行包中内嵌了以下第三方组件：

## aria2

- 主页：<https://aria2.github.io>
- 源码：<https://github.com/aria2/aria2>
- 许可：GPL-2.0 with OpenSSL exception（见仓库根目录 `COPYING`、`LICENSE.OpenSSL`）
- 位置：安装包内的 aria2c 引擎（构建时来自 `src-tauri/binaries/aria2c-x86_64-pc-windows-msvc.exe`）

本应用通过命令行参数与本地 JSON-RPC（WebSocket）驱动 aria2c，未修改其源码。

## 其他

- UI 基于 [Tauri](https://tauri.app)（MIT/Apache-2.0）、React、Vite 等开源项目构建，
  完整依赖清单见 `package.json` 与 `src-tauri/Cargo.toml` 及对应的 lock 文件。
