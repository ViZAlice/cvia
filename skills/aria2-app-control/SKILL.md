---
name: aria2-app-control
description: 通过本地 HTTP 控制通道操控 Aria2 下载器桌面应用（Tauri）：查看结构化页面快照、以 UI 同通道点击/填充、批量操作、添加和管理下载任务、Civitai 模型页识别与下载。当用户要求操作下载器、查下载进度、添加下载、清理任务或排查下载问题时使用。
---

# Aria2 下载器控制技能

Aria2 下载器（Windows，Tauri 应用）内置**本地控制服务**，只监听 `127.0.0.1:33211`
（被占用顺延最多 +10，实际端口见 `%APPDATA%/dev.aria2app/control.json`，`GET /health` 可确认）。

**核心原则**：所有操作走 APP 页面里与用户点击按钮**完全相同的 React 处理函数**执行，
aria2 调用始终由 APP 前端发出 —— 绝不绕过 APP 直接调用 aria2 RPC。
APP 全局单实例，控制端口唯一，控制的就是当前实例。

## 快速上手

```bash
# 0) 探测与自描述
curl -s http://127.0.0.1:33211/health     # frontendReady 必须为 true
curl -s http://127.0.0.1:33211/help      # 端点/指令/选择器完整说明

# 1) 先看现场再动手（无副作用的主动快照）
curl -s "http://127.0.0.1:33211/page?wait=2000"

# 2) 批量操作（每条响应都自带执行后的 page 快照）
curl -s -X POST http://127.0.0.1:33211/cmd -H "Content-Type: application/json" -d '{
  "type": "batch",
  "payload": { "steps": [
    {"type":"click","payload":{"selector":"[data-testid=btn-add]"},"wait":300},
    {"type":"fill","payload":{"selector":"[data-testid=input-uris]","value":"https://example.com/a.zip"}},
    {"type":"click","payload":{"selector":"[data-testid=btn-submit-add]"}}
  ], "wait": 1500 }
}'
```

## 指令

| type | payload | 说明 |
|---|---|---|
| `page` | `{wait?}` | 取页面快照（等价 GET /page） |
| `click` | `{selector, confirm?=true}` | 点击；confirm 弹窗自动代答（false=视为取消） |
| `fill` | `{selector, value}` | 填充 input/textarea/select（React 兼容） |
| `batch` | `{steps:[{type,payload,wait?}], snapshots?, wait?}` | 顺序执行，**任一步失败立即停**并返回失败现场 |
| `fake` | `{on: true\|false}` | 假下载开关：离线注入合成任务（带占位封面、进度走到 97%），调下载态视觉不碰网络 |

响应信封：`{ok, result?/results?, error?, page}`。`page` 永远附带：
`modal`（当前弹窗标题，null=无弹窗）、`banners`、`elements`（可见控件+selector/value/disabled）、
`state`（connected/proxyPort/tab/tasks 等）。**失败时也带 page —— 弹窗闪退一眼可见，切勿盲重试。**

## 常用选择器（data-testid）

- 头部：`btn-theme` `btn-settings` + 窗口按钮 `win-min` `win-max` `win-close`
- 页签行：`tab-downloading` `tab-complete` `tab-stopped` `btn-pause-all`
  `btn-resume-all` `btn-clear-all` `btn-civitai`（Civitai 独立入口）`btn-add`
- 任务卡片：卡片 = `[data-gid="GID"]`（gid 从 state.tasks 取），行内按钮 =
  `btn-pause` `btn-resume` `btn-restart` `btn-retry` `btn-delete` `btn-clear-record`
  `btn-delete-complete` `btn-open` `btn-reveal` `btn-copy-link`
- 新建弹窗：`input-uris` `input-dir` `btn-browse-dir` `btn-cancel-add` `btn-submit-add`
- 设置弹窗：`input-settings-dir` `input-civitai-key` `btn-save-settings` 等
- Civitai 面板：`civitai-panel` `civitai-version-select` `civitai-dl-<fileId>`
  `civitai-retry` `civitai-status-error`（错误文本）

## 典型流程

**查进度**：`GET /page` → `state.tasks.downloading`（name/status/length/speed）。

**添加直链下载**：btn-add → fill input-uris（可填 input-dir）→ btn-submit-add。

**Civitai 模型页下载**：fill input-uris 填 `civitai.com/models/...` 网页链接，
等 ~4s 面板出现（`civitai-panel`），从 snapshot 里挑 `civitai-dl-<fileId>` 点击即下。
预览图走 APP 本地 `/img` 代理（与下载同一条代理通道）。

**删除任务**：取 gid → 点 `[data-gid=...] [data-testid=btn-delete]`（confirm 自动代答，
删除会连同未完成的分片文件一起清理）。

## 注意事项

- **已停止/已完成列表每 5s 才轮询**：操作后断言前加 `wait:2000` 或隔几秒再查。
- **Git Bash/curl 传 JSON 路径必须用正斜杠**（`C:/x`）；反斜杠会被 MSYS 损坏成 JSON 解析错误。
- **Civitai API 按 key 限流**：连续拉取可能 429，面板会显示 `civitai-status-error`，点 `civitai-retry`。
- APP 关闭窗口=最小化到托盘，控制通道依然可用；彻底退出走托盘菜单。

详细文档：项目根目录 `CONTROL.md`。
