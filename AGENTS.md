# AGENTS.md — cvia（Aria2 下载器）项目全景

> 给 AI Agent / 新协作者的快速上手文档。读这一篇 ≈ 读完整个仓库。
> 控制通道的完整操作手册在 [CONTROL.md](CONTROL.md)。

## 1. 这是什么

Windows 桌面下载器：**Tauri 2（Rust）+ React 18 + TypeScript + Vite** 壳，
内核是随包分发的 **aria2c**（sidecar）。两个特色：

1. **Civitai 模型页一键下载**：粘贴网页链接 → 解析版本/文件/预览图 → 按文件下载
2. **Agent 控制通道**：本机 HTTP 服务，Agent 与 GUI 用户走**同一条通道**操控应用

## 2. 架构总览

```
┌────────────────────────── WebView (React) ──────────────────────────┐
│  App.tsx（状态根：任务列表/页签/主题/弹窗，1s 轮询刷新）               │
│   ├── components/TaskList  任务卡片（封面卡 / 普通卡两种形态）         │
│   ├── components/AddTask   新建下载 + Civitai 面板                    │
│   ├── components/Settings  设置（代理/引擎参数/API Key）              │
│   ├── api.ts   Aria2Client —— aria2 JSON-RPC over WebSocket（用户通道）│
│   ├── civitai.ts  Civitai API 解析 + 封面映射(localStorage)            │
│   ├── control.ts  控制桥（接收 Rust 转发的指令，在页面里执行）          │
│   └── fake.ts     假下载（离线注入合成任务，仅调试）                   │
└──────────────┬───────────────────────────────┬──────────────────────┘
      invoke(命令)                       事件 control:command
┌──────────────┴───────────────────────────────┴──────────────────────┐
│ Rust (src-tauri/src)                                                 │
│  main.rs    引擎托管：spawn aria2c(随机端口+secret)、session 断点续传、 │
│             代理协商（切换=优雅重启引擎）、托盘、单实例、剪贴板等命令    │
│  control.rs 本地控制服务：tiny_http @127.0.0.1:33211(+顺延)           │
│             /health /help /page /img /cmd + 指令转发与回执            │
└──────────────┬──────────────────────────────────────────────────────┘
               │ shell sidecar
        aria2c.exe（GPLv2，src-tauri/binaries/，随包分发）
```

**同通道原则（最重要的一条）**：Agent 的一切操作都进 WebView 以真实 UI 事件执行
（`element.click()` / React 受控填充），aria2 调用永远由 `Aria2Client` 发出。
**绝不**让 Agent 直连 aria2 的 RPC —— 那会绕过应用的全部状态与逻辑。

## 3. 界面树（根 → 叶，含 data-testid 对外契约）

```
主窗口（frameless 无系统标题栏，decorations:false；顶栏=拖拽区，双击最大化）
│
├─ 顶栏 topbar
│  ├─ 品牌区：lime 色块 logo ⇣ +「Aria2 下载器」
│  ├─ btn-theme  ☀/☾ 主题切换（跟随系统初始，手动后 localStorage 记住）
│  ├─ btn-settings ⚙  → 打开设置弹窗
│  └─ 窗口控制：win-min ─ / win-max ▢ / win-close ✕（关闭=隐藏到托盘继续下载）
│
├─ content-frame 中间圆角容器（左右贴边；页签/列表/氛围层都在圆角内）
│  │
│  ├─ dl-wash 下载中氛围层（有任务 active/waiting 时）
│  │   · clip-path 四点从左下角(0,100%)插值到四角 → 斜向拉幕展开/收回
│  │   · 内部两个径向渐变光斑（b1 左下/b2 右上）反向漂移 + 整体呼吸
│  │   · 光斑盒子完全在容器内（渐变碰边前透明）—— 见 §6 Chromium 裁剪坑
│  │
│  ├─ tabs-row 页签行
│  │  ├─ 分段页签：tab-downloading / tab-complete / tab-stopped
│  │  │   （激活=实底+计数徽章 lime/pink 色块）
│  │  ├─ btn-pause-all ⏸ / btn-resume-all ▶（玻璃图标按钮，悬停"对焦"）
│  │  ├─ 弹性空隙
│  │  ├─ btn-clear-all 清除全部记录（仅已完成/已停止页签且有记录）
│  │  ├─ btn-civitai「⌁ Civitai」强调色描边 → 打开 Civitai 专用弹窗
│  │  └─ btn-add「+ 新建下载」主按钮 → 打开通用弹窗
│  │
│  ├─ error-banner 错误横幅（5s 自动消失）
│  │
│  └─ main 任务卡片流（flex wrap、卡片定宽 330px、左对齐；
│      窗口加宽只加列，卡片不变形）
│     ├─ 空状态（连接中 ⌛ / 暂无任务 ⇣）
│     └─ task-card 任务卡片 [data-gid=GID]（悬停=scale 1.02+阴影）
│        │
│        ├─【封面卡形态】Civitai 任务且 localStorage 有封面映射时
│        │  ├─ tc-bg 预览图整卡铺底（FadeImg：shimmer 骨架→淡入；
│        │  │   高度=图片真实比例，240~640px；失败显示 🖼 占位）
│        │  └─ tc-overlay 磨砂玻璃信息浮层（absolute 底部，不参与布局；
│        │     背景=主题色半透明+backdrop-blur，四角与卡片同半径）
│        │     ├─ tc-head：文件名(+BT 标) / 目录名 / 状态徽章(带呼吸点)
│        │     ├─ progress：进度条（下载中有流光高光）
│        │     ├─ tc-meta：百分比 / 已下/总量 / ↓速度 / ↑速度 / 剩余 / 连接数 / 错误文本
│        │     └─ tc-actions（悬停显现）：btn-open 打开 / btn-reveal 目录 /
│        │        btn-copy-link 链接 / btn-pause 暂停 / btn-resume 继续 /
│        │        btn-restart 重开 / btn-retry 重试 / btn-delete 删除(删文件) /
│        │        btn-clear-record 清除记录(留文件) / btn-delete-complete 删除
│        │
│        └─【普通卡形态】无封面：tc-body 在文档流，头部多一个
│           扩展名徽标 tc-icon（按状态换色），其余同上
│
├─ footer 底栏（玻璃）：连接状态点 · aria2 版本 · 代理 · ↓↑实时速度
│
└─ 弹窗层（modal-mask 遮罩点击关闭 / Esc；.modal 内 h2 被 control.ts
   用于弹窗识别 —— 别改结构）
   │
   ├─ AddTask 新建下载（btn-add 通用 / btn-civitai 专用，preset 决定提示语）
   │  ├─ input-uris 链接输入（多行；打开时剪贴板单行链接自动预填）
   │  │   · HuggingFace /blob/ → /resolve/ 自动转换（convert-notes 提示，
   │  │     token 一律打码显示 ***）
   │  │   · Civitai 模型页链接（civitai.com/models/ID?modelVersionId=…）
   │  │     → 300ms 去抖自动拉取，出现 ↓
   │  ├─ civ-panel Civitai 面板
   │  │  ├─ civitai-status-loading 加载中 / civitai-status-error 错误文本
   │  │  │   + civitai-retry 重试（429 限流时用它）
   │  │  ├─ 模型名 · 类型 · 作者 · 版本数
   │  │  ├─ civitai-version-select 版本下拉（>1 版本时；选项 value=版本ID，
   │  │  │   快照带完整 options 列表；fill 支持按可见文本/值/模糊匹配）
   │  │  ├─ 文件行 civitai-file-<fileId>：类型徽章/文件名/大小 +
   │  │  │   下载按钮 civitai-dl-<fileId>（★唯一下载入口：记录封面映射→
   │  │  │   提交→弹窗自动关闭→切回下载中页签）
   │  │  └─ 预览图网格（≤6 张 FadeImg + 「+N 张」；点击 lightbox 放大）
   │  ├─ input-dir 保存目录（记住上次）+ btn-browse-dir 浏览
   │  ├─ 高级项（仅单条 http 链接且无面板）：input-name 自定义文件名 /
   │  │   select-algo + input-checksum 校验和 / input-headers 请求头
   │  └─ 取消 btn-cancel-add + 开始下载 btn-submit-add
   │      （面板激活/加载中/出错时隐藏 —— 一个面板只有一条下载路径）
   │
   ├─ Settings 设置
   │  ├─ input-settings-dir 默认目录 + 浏览 btn-browse-settings-dir / 打开
   │  ├─ input-max-concurrent 最大同时下载数 / input-speed-limit 全局限速
   │  ├─ input-civitai-key Civitai API Key（密码框，快照只回显长度）
   │  ├─ 高级（btn-advanced-toggle 展开）：input-split 分片 / input-min-split
   │  │   最小分片 / input-max-connection 单任务连接数 /
   │  │   check-skip-cert 跳过证书校验（★需重启引擎）
   │  ├─ 代理（★切换=重启引擎，任务靠 session 自动恢复）：
   │  │   radio-proxy-auto 自动探测 / radio-proxy-manual 手动 / radio-proxy-off
   │  │   + input-ports 探测端口列表 / btn-detect 检测 / input-manual-port
   │  └─ btn-cancel-settings / btn-save-settings 保存
   │
   └─ lightbox 预览大图（点击任意处关闭）

托盘菜单：显示主窗口 / 全部暂停 / 全部继续 / 退出（真正退出+优雅关停引擎）
```

## 4. 关键设计决策（为什么是现在这样）

| 决策 | 原因 |
|---|---|
| aria2 引擎随机端口+secret，App 内 WebSocket 连 | 不占用固定端口、不暴露未鉴权 RPC 给其他进程 |
| 切换代理/证书校验 = 重启引擎 | 这两项只能启动参数生效；靠 session 文件+`.aria2` 控制文件断点续传，任务自动恢复 |
| `--stop-with-process=<app pid>` | GUI 被强杀时引擎自杀，避免孤儿 aria2c |
| 单实例插件必须第一个注册 | 二次启动在插件初始化阶段就退出，不会拉起第二个引擎/托盘 |
| 控制服务 tiny_http + 端口顺延 + app data 写 control.json | 零重依赖；默认 33211，冲突自动 +1..+10，可发现 |
| 信封协议 `{ok,result?,error?,page}` page 永远附带 | Agent 每一步操作后立刻看到 UI 现场；弹窗闪退、按钮禁用一眼可见，不盲操作 |
| `/img` 图片代理 + civitai 域名白名单 | WebView `<img>` 走系统代理，被墙环境加载不出预览；代理复用引擎网络路径。白名单防开放代理 |
| Civitai 封面映射存 localStorage（键=鉴权归一化 URL） | 任务卡片封面跨会话可用；60 条 LRU；存原始地址、用时按当前端口包代理 |
| 假下载 fake.ts（`/cmd {"type":"fake"}`） | 离线调"下载中"视觉（拉幕/光斑/卡片/玻璃浮层），不碰网络；封面用真实 Civitai 预览图 |
| 卡片定宽 330 + flex wrap 左对齐 | 图片不被窗口缩放重裁；加宽=加列 |
| 玻璃只用于顶栏/底栏/弹窗/卡片信息浮层；按钮平底无渐变辉光 | 用户的审美取向（Nothing OS 风），lime(深)/pink(亮)单色强调 |
| 已停止列表 5s 降频轮询、下载中 1s | 高负载时降低 RPC 压力（aria2 单线程 RPC 易饱和） |
| 失败任务自动重试 3 次（10/20/30s 退避） | 网络抖动免手动；重试计数在正常下载时清零 |

## 5. 状态与数据流

- **App 状态根**在 `App.tsx`：`downloading / stopped / stat / tab / theme / 弹窗开关`，
  每次渲染后把快照登记给 `setStateProvider`（控制通道 `state` 字段的来源）
- `aria2.onAria2Event`（WebSocket 通知）+ 1s 定时器 → `refresh()`（busy 锁防重入）
- 看门狗：断连 3s → `reconfigure()` 重读引擎端口重连（引擎重启换端口场景）
- 引擎重启链：`setProxy/setCertCheck` → `stop_engine`（rpc shutdown→落盘 session→kill）→
  重新 spawn → 前端 reconfigure
- 每次下载成功点面板按钮时 `rememberTaskImage()` 建封面映射；卡片渲染时
  `taskImageFor(mainUri)` 查询

## 6. 已知的坑（改动前必读）

1. **Chromium 裁剪逃逸 ×2**：`backdrop-filter` 子元素会画出父级
   `overflow:hidden + border-radius` 的圆角外；带动画的合成层同理。
   → 玻璃浮层自带同款圆角自裁；光斑盒子完全收在容器内（渐变碰边前透明）。
   给带封面卡片去掉描边也是同理（描边内外缘半径差 1px 会露缝）
2. **Git Bash + curl 传 JSON**：非 ASCII（中文点号·等）可能被 GBK 控制台损坏 →
   Rust 返回 400"不是合法 UTF-8"。路径用正斜杠；特殊字符把 body 写文件再 `-d @file`
3. **CSS 属性选择器值以数字开头必须加引号**：`[data-gid="123..."]`（gid 常以数字开头）
4. **Civitai API 按 key 限流**（连续拉取 429）：面板显示 civitai-status-error，点重试
5. **启动期 WS 竞态**：代理协商重启引擎时，恰逢的 addUri 会延迟数秒才回执
   （outbox 重发，自愈）—— 排查时别急着判死，等 15s 再看
6. **对外契约**：所有 `data-testid`、`.modal h2` 结构、控制协议字段都是
   Agent 的操作接口，改动=破坏兼容，必须同步更新 CONTROL.md / SKILL.md / help_json
7. **FadeImg 必须检查 `img.complete`**：命中缓存的图不触发 onLoad，会永远卡在骨架
8. **fake.ts 只注入前端状态**，引擎/磁盘无任务；`data-gid` 以 `f4ke` 开头可识别

## 7. 构建与发布

```bash
pnpm install
pnpm tauri dev          # 开发（Vite HMR；改 Rust/conf 自动重启）
pnpm tauri build        # 完整打包：NSIS + MSI → src-tauri/target/release/bundle/
pnpm tauri build --no-bundle   # 只出 exe 不做安装包（快速迭代）
```

- 版本号三处同步：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`
- **改 Rust / tauri.conf / capabilities 需要重启 dev**（HMR 只覆盖前端）
- 发布流程：bump 版本 → build → `git commit` → `git tag vX.Y.Z && git push --tags`
  → CI（.github/workflows/build.yml）自动构建 → GitHub Release 手动/脚本上传
  NSIS+MSI（资产命名 cvia_ 前缀）
- 调试截图：`tools/shot.ps1 -OutPath xxx.png`（按进程名找窗口截取）；
  演示用假下载摆场景；无视觉能力的 Agent 用子代理（视觉模型）审图

## 8. Agent 控制通道速查（详见 CONTROL.md）

```bash
curl -s http://127.0.0.1:33211/health        # frontendReady 必须为 true
curl -s http://127.0.0.1:33211/help          # 端点/指令/选择器自描述
curl -s "http://127.0.0.1:33211/page?wait=2000"   # 主动快照（无副作用）
curl -X POST http://127.0.0.1:33211/cmd -d '{"type":"batch","payload":{"steps":[...]}}'
curl -X POST http://127.0.0.1:33211/cmd -d '{"type":"fake","payload":{"on":true,"count":4}}'
```

技能副本：`E:\.agents\skills\aria2-app-control\SKILL.md`（与仓库
`skills/aria2-app-control/SKILL.md` 保持同步）。
