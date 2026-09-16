# Agent 控制通道（调试用）

APP 内置一个**只监听 127.0.0.1 的本地 HTTP 控制服务**，让外部（如 ZCode 等
Agent、脚本）能用「和 GUI 用户完全相同的通道」操控 APP：

```
curl /cmd → Rust 控制服务 → Tauri 事件 → 页面控制桥(src/control.ts)
  → element.click() / React 受控填充（与用户点击同一份 React 处理函数）
  → Aria2Client WebSocket → aria2c 引擎
```

**通道保证**：控制方从不直接调用 aria2 RPC，一切操作都在 WebView 页面里
以真实 UI 事件执行；aria2 调用始终由 APP 前端的 `Aria2Client` 发出。
开发（pnpm tauri dev）和打包后的正式版行为完全一致。

## 接入方式

- 端口：默认 `33211`，被占用时向后顺延（最多 +10），实际端口写在
  `%APPDATA%/dev.aria2app/control.json`。
- `GET /health` → `{"status":"ok","frontendReady":true,...}`（等 ready 再发指令）
- `GET /help` → 端点/指令/选择器/注意事项的完整自描述
- `GET /page` → **主动查看**：不附带任何操作，直接返回当前页面快照信封；
  可加 `?wait=2000` 先等轮询刷新再取（毫秒，上限 5000）。
- `GET /img?u=<percent-encoded>` → civitai 图片本地代理（域名白名单，走引擎代理）
- `POST /cmd`，body 为 JSON：`{"type":"指令","payload":{...}}`（响应同样自带 page）

## 指令

| type | payload | 说明 |
|---|---|---|
| `page` | `{wait?}` | 取页面快照（等价 GET /page） |
| `click` | `{selector, confirm?=true}` | 点击元素；confirm 弹窗自动代答（`confirm:false` 等同用户点取消） |
| `fill` | `{selector, value}` | 填充 input/textarea/select（React 兼容）；**select 支持按可见文本/值/模糊匹配**，快照的 elements 里 select 带 `options` 选项列表 |
| `batch` | `{steps:[{type,payload,wait?}], snapshots?="last"\|"all", wait?}` | 按顺序执行多步；任一步失败立即停止并返回失败现场 |
| `fake` | `{on: true\|false}` | **假下载开关**：离线注入/移除合成任务（带占位封面、进度自动走到 97%），调下载态视觉不碰网络 |
| `ping` | — | 连通性测试 |

## 响应信封（重要）

每条指令的响应都**自带执行后的完整页面快照**，不用二次查询：

```jsonc
{
  "ok": true,            // 指令是否成功
  "result": {...},       // 指令结果（batch 为 results 数组）
  "error": "...",        // ok=false 时的原因
  "page": {              // 执行后的页面现场（失败时也返回！）
    "modal": "新建下载",  // 当前弹窗标题，null = 无弹窗（弹窗闪退一眼可见）
    "banners": [],       // 错误横幅文本
    "elements": [        // 所有可见交互控件
      {"selector":"[data-testid=\"btn-add\"]","tag":"button","text":"+ 新建下载",
       "value":null,"checked":null,"disabled":null,"gid":null}
      // 任务行内按钮带 gid，如 selector 省略时用 [data-gid="GID"] [data-testid=btn-pause]
    ],
    "state": {           // App 状态快照
      "connected": true, "version": "1.37.0", "proxyPort": 7890,
      "tab": "downloading", "showAdd": false, "showSettings": false, "error": "",
      "tasks": { "downloading":[{gid,status,name,...}], "stopped":[...] }
    }
  }
}
```

密码框的 value 只回显 `<masked:长度>`，不泄露内容。

## 稳定选择器（data-testid）

- 头部：`btn-theme`（明暗主题切换）`btn-settings` + 窗口按钮 `win-min` `win-max` `win-close`
- 页签行：分段页签 `tab-downloading` `tab-complete` `tab-stopped`；`btn-pause-all`
  `btn-resume-all`（图标）`btn-clear-all`；独立入口 `btn-civitai`；主按钮 `btn-add`
- 任务卡片（卡片定位 `[data-gid="GID"]`，Civitai 任务为图片铺底+玻璃浮层形态）：
  `btn-open` `btn-reveal` `btn-copy-link` `btn-pause` `btn-resume` `btn-restart`
  `btn-retry` `btn-delete` `btn-clear-record` `btn-delete-complete`
- 新建下载弹窗（`btn-civitai` 打开时为 Civitai 专用提示）：`input-uris` `input-dir`
  `btn-browse-dir` `input-name` `select-algo` `input-checksum` `input-headers`
  `btn-cancel-add` `btn-submit-add`
- Civitai 面板：`civitai-panel` `civitai-status-loading` `civitai-status-error`
  `civitai-retry` `civitai-version-select` `civitai-file-<fileId>` / 下载按钮
  `civitai-dl-<fileId>`
- 设置弹窗：`input-settings-dir` `btn-browse-settings-dir` `btn-open-settings-dir`
  `input-max-concurrent` `input-speed-limit` `input-civitai-key`
  `btn-advanced-toggle` `input-split` `input-min-split` `input-max-connection`
  `check-skip-cert` `radio-proxy-auto|manual|off` `input-ports` `btn-detect`
  `input-manual-port` `btn-cancel-settings` `btn-save-settings`

## 示例

```bash
# 加一个下载任务（和用户点「新建下载→填链接→开始下载」完全同路）
curl -s -X POST http://127.0.0.1:33211/cmd -H "Content-Type: application/json" -d '{
  "type":"batch","payload":{"steps":[
    {"type":"click","payload":{"selector":"[data-testid=btn-add]"},"wait":300},
    {"type":"fill","payload":{"selector":"[data-testid=input-uris]","value":"https://example.com/a.zip"}},
    {"type":"click","payload":{"selector":"[data-testid=btn-submit-add]"}}
  ],"wait":1500}}'

# 看当前页面
curl -s -X POST http://127.0.0.1:33211/cmd -d '{"type":"page"}'
```

## 排查提示

- **Git Bash / curl 传 JSON 时路径别用反斜杠**：`C:\\x` 经 MSYS 转发可能损坏 JSON
  （Rust 返回 400 且不带 page）。统一用正斜杠 `C:/x`，aria2/Windows 都认。

- **已停止/已完成列表每 5 秒才轮询一次**：删除/完成后立即查 state 可能还是旧值，
  加 `wait: 2000` 或隔几秒再查。
- 操作失败时先看 `page.modal` 和 `page.elements`：弹窗若意外关闭（如自动提交），
  目标元素会不存在，此时别盲目重试，先理解现场。
- 单实例：APP 全局只允许一个进程（二次启动会唤起已有窗口后自行退出），
  控制端口因此唯一，控制的必然是当前实例。
