//! Agent 控制服务：本机 HTTP 入口 → Tauri 事件 → WebView 前端控制桥。
//!
//! 指令不在 Rust 侧执行，而是原样转发给前端页面，由页面里和用户点击按钮
//! 完全相同的 React 处理函数执行（aria2 调用仍走 Aria2Client 的 WebSocket），
//! 保证调试时走的是和 GUI 用户同一条通道。只监听 127.0.0.1。
//!
//! 前端每条指令的回执都是一个信封：{ok, result?, error?, page}，
//! page 是执行后的完整结构化页面快照（弹窗、控件、任务列表），
//! 这样外部调用者每次操作完都能立刻看到 UI 现状，弹窗意外消失也能发现。

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

/// 控制端口默认值；被占用时向后顺延尝试，实际端口写入 app data 的 control.json
pub const CONTROL_PORT_BASE: u16 = 33211;
/// 等待前端回执的上限（前端 aria2 请求自身的超时是 15s）
const REPLY_TIMEOUT: Duration = Duration::from_secs(25);
/// 请求体上限
const MAX_BODY: u64 = 1024 * 1024;

struct Inner {
    app: AppHandle,
    next_id: AtomicU64,
    frontend_ready: AtomicBool,
    pending: Mutex<HashMap<u64, Sender<serde_json::Value>>>,
    port: Mutex<u16>,
}

pub struct ControlHub {
    inner: Arc<Inner>,
}

impl Inner {
    fn health(&self) -> serde_json::Value {
        serde_json::json!({
            "status": "ok",
            "app": "cvia",
            "version": env!("CARGO_PKG_VERSION"),
            "frontendReady": self.frontend_ready.load(Ordering::Relaxed),
            "port": *self.port.lock().unwrap(),
        })
    }

    /// 把指令转发给主窗口的前端控制桥，阻塞等待 control_reply 回执
    fn exec(&self, kind: &str, payload: serde_json::Value) -> Result<serde_json::Value, String> {
        if !self.frontend_ready.load(Ordering::Relaxed) {
            return Err("前端未就绪（窗口还没加载完），稍后重试".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx): (Sender<serde_json::Value>, Receiver<serde_json::Value>) = channel();
        self.pending.lock().unwrap().insert(id, tx);

        let emit = self.app.emit_to(
            "main",
            "control:command",
            serde_json::json!({ "id": id, "type": kind, "payload": payload }),
        );
        if let Err(e) = emit {
            self.pending.lock().unwrap().remove(&id);
            return Err(format!("转发到前端失败：{e}"));
        }

        let outcome = rx.recv_timeout(REPLY_TIMEOUT);
        self.pending.lock().unwrap().remove(&id);
        match outcome {
            // 前端信封（自带 ok/error/result/page）原样透传给 HTTP 客户端
            Ok(envelope) => Ok(envelope),
            Err(_) => Err("前端执行超时（25s）".into()),
        }
    }
}

/// 前端控制桥挂载完成后调用，标记可接收指令；返回实际控制端口
/// （前端用它拼接 /img 本地图片代理地址）
#[tauri::command]
pub fn control_ready(hub: State<'_, ControlHub>) -> u16 {
    hub.inner
        .frontend_ready
        .store(true, Ordering::Relaxed);
    println!("[control] frontend bridge ready");
    *hub.inner.port.lock().unwrap()
}

/// 前端执行完指令后回传结果信封
#[tauri::command]
pub fn control_reply(hub: State<'_, ControlHub>, id: u64, data: serde_json::Value) {
    if let Some(tx) = hub.inner.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(data);
    }
}

/// 启动控制服务（独立线程，端口冲突向后顺延，最多试 10 个）
pub fn start(app: AppHandle) {
    let hub = ControlHub {
        inner: Arc::new(Inner {
            app: app.clone(),
            next_id: AtomicU64::new(1),
            frontend_ready: AtomicBool::new(false),
            pending: Mutex::new(HashMap::new()),
            port: Mutex::new(0),
        }),
    };
    let inner = Arc::clone(&hub.inner);
    app.manage(hub);

    let mut port = CONTROL_PORT_BASE;
    let server = loop {
        match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(s) => break s,
            Err(_) if port < CONTROL_PORT_BASE + 10 => port += 1,
            Err(_) => {
                eprintln!("[control] no free port in {CONTROL_PORT_BASE}.., control disabled");
                return;
            }
        }
    };
    *inner.port.lock().unwrap() = port;
    println!("[control] listening on http://127.0.0.1:{port}");

    // 把实际端口落到 app data 目录，方便外部工具发现
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(
            dir.join("control.json"),
            serde_json::json!({ "port": port }).to_string(),
        );
    }

    let server = Arc::new(server);
    // 4 个工作线程：/cmd 指令 + 预览图并发加载（2 线程时 6 张图排队明显）
    for _ in 0..4 {
        let server = Arc::clone(&server);
        let inner = Arc::clone(&inner);
        std::thread::spawn(move || {
            loop {
                match server.recv() {
                    Ok(req) => handle(&inner, req),
                    Err(_) => return,
                }
            }
        });
    }
}

fn handle(inner: &Inner, mut req: tiny_http::Request) {
    let method = req.method().to_string();
    let path = req.url().split('?').next().unwrap_or("/").to_string();

    match (method.as_str(), path.as_str()) {
        ("GET", "/health") => respond(req, 200, &inner.health()),
        // 自描述：给 Agent / 排查者一份完整的使用说明
        ("GET", "/help") => respond(req, 200, &help_json()),
        // 主动查看端点：不附带任何操作，直接取当前页面快照
        ("GET", "/page") => {
            let wait = parse_wait(&req.url());
            match inner.exec("page", serde_json::json!({ "wait": wait })) {
                Ok(envelope) => respond(req, 200, &envelope),
                Err(e) => respond(req, 200, &err_json(&e)),
            }
        }
        // 本地图片代理：WebView 的 <img> 走系统代理，被墙环境下加载不出
        // civitai 预览图；这里经引擎同款代理取图回传，保证与下载同路可达。
        // 仅放行 civitai 域名，避免变成开放代理。
        ("GET", "/img") => {
            let Some(target) = req.url().split_once('?').and_then(|(_, q)| {
                q.split('&').find(|kv| kv.starts_with("u=")).map(|kv| kv["u=".len()..].to_string())
            }) else {
                return respond(req, 400, &err_json("缺少 u 参数"));
            };
            let Ok(url) = percent_decode(&target) else {
                return respond(req, 400, &err_json("u 参数编码错误"));
            };
            match proxy_fetch(inner, &url) {
                Ok((ctype, bytes)) => {
                    let ct: tiny_http::Header = format!("Content-Type: {ctype}")
                        .parse()
                        .expect("dynamic header");
                    let cache: tiny_http::Header = "Cache-Control: public, max-age=86400"
                        .parse()
                        .expect("static header");
                    let resp = tiny_http::Response::from_data(bytes)
                        .with_header(ct)
                        .with_header(cache);
                    let _ = req.respond(resp);
                }
                Err(e) => respond(req, 502, &err_json(&e)),
            }
        }
        ("POST", "/cmd") => {
            let mut body = String::new();
            if req
                .as_reader()
                .take(MAX_BODY)
                .read_to_string(&mut body)
                .is_err()
            {
                return respond(req, 400, &err_json("请求体不是合法 UTF-8"));
            }
            let parsed: serde_json::Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(e) => return respond(req, 400, &err_json(&format!("JSON 解析失败：{e}"))),
            };
            let Some(kind) = parsed.get("type").and_then(|v| v.as_str()) else {
                return respond(req, 400, &err_json("缺少 type 字段"));
            };
            let payload = parsed
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::json!({}));
            match inner.exec(kind, payload) {
                Ok(envelope) => respond(req, 200, &envelope),
                Err(e) => respond(req, 200, &err_json(&e)),
            }
        }
        _ => respond(req, 404, &err_json("未知路由，可用：GET /health、POST /cmd")),
    }
}

fn err_json(msg: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": msg })
}

/// 控制通道自描述（GET /help）
fn help_json() -> serde_json::Value {
    serde_json::json!({
        "app": "cvia",
        "purpose": "与 GUI 用户同一条通道操控 APP：指令在页面里以真实 UI 事件执行，aria2 调用始终由 APP 前端发出；请勿绕过 APP 直接调用 aria2 RPC",
        "endpoints": {
            "GET /health": "存活/就绪检查（frontendReady 为 true 才能发指令）",
            "GET /help": "本说明",
            "GET /page?wait=ms": "主动获取页面快照（结构化现场，无副作用），wait 上限 5000",
            "GET /img?u=<percent-encoded>": "civitai 图片本地代理（域名白名单，走引擎代理）",
            "POST /cmd": "执行指令，body {\"type\":...,\"payload\":{...}}，响应自带执行后的 page 快照"
        },
        "commands": {
            "ping": "连通测试",
            "page": "取快照（等价 GET /page）",
            "click": "payload {selector, confirm?=true}；点击元素，confirm 弹窗自动代答，confirm:false 等同用户取消",
            "fill": "payload {selector, value}；填充 input/textarea/select（React 兼容）；select 按可见文本/值/模糊匹配，快照 elements 中 select 带 options 列表",
            "batch": "payload {steps:[{type,payload,wait?}], snapshots?=\"all\"|\"last\", wait?}；顺序执行多步，任一步失败立即停止并返回失败现场快照",
            "fake": "payload {on: true|false}；假下载开关：离线注入/移除合成任务（带占位封面，进度自动走到 97%），调下载态视觉不碰网络"
        },
        "pageEnvelope": {
            "modal": "当前弹窗标题，null=无弹窗（弹窗意外消失一眼可见）",
            "banners": "错误横幅文本",
            "elements": "可见交互控件（selector/text/value/disabled/gid）",
            "state": "App 状态：connected/proxyPort/tab/tasks{downloading,stopped} 等"
        },
        "selectors": {
            "头部": "btn-add / btn-pause-all / btn-resume-all / btn-settings",
            "页签": "tab-downloading / tab-complete / tab-stopped / btn-clear-all",
            "任务行": "行定位 [data-gid=\"GID\"]，行内按钮 btn-pause/btn-resume/btn-restart/btn-retry/btn-delete/btn-clear-record/btn-delete-complete/btn-open/btn-reveal/btn-copy-link",
            "新建弹窗": "input-uris / input-dir / btn-submit-add 等",
            "Civitai": "civitai-panel / civitai-version-select / civitai-dl-<fileId> / civitai-retry / civitai-status-error"
        },
        "gotchas": [
            "已停止/已完成列表每 5s 轮询，操作后断言前加 wait:2000",
            "Git Bash/curl 传 JSON 时路径用正斜杠，反斜杠会被 MSYS 损坏",
            "Civitai API 有按 key 限流，连续拉取可能 429，稍后点 civitai-retry 重试",
            "APP 为全局单实例，控制端口（默认 33211，顺延最多 +10）唯一"
        ]
    })
}

/// 从 "/page?wait=2000" 之类的 URL 取 wait 毫秒数（上限与前端 MAX_WAIT 一致）
fn parse_wait(url: &str) -> u64 {
    url.split_once('?')
        .and_then(|(_, q)| q.split('&').find(|kv| kv.starts_with("wait=")))
        .and_then(|kv| kv["wait=".len()..].parse::<u64>().ok())
        .unwrap_or(0)
        .min(5000)
}

/// 极简 percent-decoding（仅用于 /img 的 u 参数）
fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|_| "编码错误".to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "编码错误".to_string())?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "编码错误".to_string())
}

fn url_host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    Some(rest.split(['/', '?', '#']).next()?.split(':').next()?.to_string())
}

/// civitai 图片代理的域名白名单，避免变成开放代理
fn is_allowed_image_host(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "civitai.com" || h.ends_with(".civitai.com")
}

/// 经引擎当前代理拉取图片（限 30MB），返回 (Content-Type, 字节)
fn proxy_fetch(inner: &Inner, url: &str) -> Result<(String, Vec<u8>), String> {
    let host = url_host(url).ok_or("无法解析图片地址")?;
    if !is_allowed_image_host(&host) {
        return Err(format!("不允许的图片域名：{host}"));
    }
    let proxy = inner.app.try_state::<crate::Aria2State>().and_then(|s| s.current_proxy());
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30));
    if let Some(p) = proxy {
        let addr = format!("http://127.0.0.1:{p}");
        builder = builder.proxy(ureq::Proxy::new(&addr).map_err(|e| e.to_string())?);
    }
    let resp = builder.build().get(url).call().map_err(|e| e.to_string())?;
    let ctype = resp.header("Content-Type").unwrap_or("image/jpeg").to_string();
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(30 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("图片内容为空".into());
    }
    Ok((ctype, bytes))
}

fn respond(req: tiny_http::Request, status: u16, body: &serde_json::Value) {
    let ct: tiny_http::Header = "Content-Type: application/json; charset=utf-8"
        .parse()
        .expect("static header");
    let cors: tiny_http::Header = "Access-Control-Allow-Origin: *"
        .parse()
        .expect("static header");
    let resp = tiny_http::Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(ct)
        .with_header(cors);
    let _ = req.respond(resp);
}
