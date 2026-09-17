#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod control;

/// 启动时自动探测的本地代理端口（如 v2ray 的 10808、clash 的 7890）
const DEFAULT_PROXY_PORTS: [u16; 2] = [10808, 7890];

struct Aria2Inner {
    port: u16,
    secret: String,
    proxy: Option<u16>,
    skip_cert: bool,
    child: Option<CommandChild>,
}

struct Aria2State(Mutex<Aria2Inner>);

impl Aria2State {
    /// 当前引擎使用的本地代理端口（控制服务的图片代理等复用同一条通道）
    pub fn current_proxy(&self) -> Option<u16> {
        self.0.lock().ok().map(|g| g.proxy).flatten()
    }
}

struct Spawned {
    port: u16,
    secret: String,
    child: CommandChild,
}

fn config_json(g: &Aria2Inner) -> serde_json::Value {
    serde_json::json!({
        "port": g.port,
        "secret": g.secret,
        "proxy": g.proxy,
        "skipCert": g.skip_cert,
    })
}

#[tauri::command]
fn rpc_config(state: State<Aria2State>) -> serde_json::Value {
    let g = state.0.lock().unwrap();
    config_json(&g)
}

/// 依次探测端口，返回第一个可建立 TCP 连接的端口
#[tauri::command]
fn scan_proxy(ports: Vec<u16>) -> Option<u16> {
    ports.into_iter().find(|&p| probe_port(p))
}

fn probe_port(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// 本地 JSON-RPC 调用（std 实现，无需引入 HTTP 库），用于托盘快捷操作和优雅关停
fn rpc_call(port: u16, secret: &str, method: &str) -> Result<(), String> {
    let body = format!(
        r#"{{"jsonrpc":"2.0","id":"1","method":"aria2.{}","params":["token:{}"]}}"#,
        method, secret
    );
    let stream = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(600),
    )
    .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1200)))
        .ok();
    let mut stream = stream;
    let req = format!(
        "POST /jsonrpc HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    // 读一下响应给引擎处理请求的时间；内容不重要
    let mut buf = [0u8; 512];
    let _ = stream.read(&mut buf);
    Ok(())
}

fn rpc_state(app: &AppHandle, method: &str) {
    let state = app.state::<Aria2State>();
    // .ok() 把 Result 变成 Option 局部值，避免 if let 临时值活得比 state 久
    let g = state.0.lock().ok();
    if let Some(g) = g {
        let _ = rpc_call(g.port, &g.secret, method);
    }
}

/// 优雅停掉引擎：先请求 aria2.shutdown 让它把会话落盘
/// （--save-session-interval 之外只有退出时会写盘），等待后再 kill 兜底。
/// 直接硬杀会丢失/复活最近 30 秒内的任务变动。
fn stop_engine(g: &mut Aria2Inner) {
    if let Some(child) = g.child.take() {
        let _ = rpc_call(g.port, &g.secret, "shutdown");
        std::thread::sleep(Duration::from_millis(1200));
        let _ = child.kill();
    }
}

/// 切换代理：重启 aria2 引擎使其生效（进行中的任务靠 session 自动恢复）
#[tauri::command]
fn set_proxy(app: AppHandle, proxy: Option<u16>) -> Result<serde_json::Value, String> {
    let state = app.state::<Aria2State>();
    let mut g = state.0.lock().map_err(|_| "state lock failed")?;
    if g.proxy == proxy {
        return Ok(config_json(&g));
    }
    stop_engine(&mut g);
    let spawned = spawn_aria2(&app, proxy, g.skip_cert).map_err(|e| e.to_string())?;
    g.port = spawned.port;
    g.secret = spawned.secret;
    g.proxy = proxy;
    g.child = Some(spawned.child);
    Ok(config_json(&g))
}

/// 切换证书校验：check-certificate 只能通过启动参数生效，必须重启引擎。
/// 返回是否发生了重启。
#[tauri::command]
fn set_cert_check(app: AppHandle, skip: bool) -> Result<bool, String> {
    let state = app.state::<Aria2State>();
    let mut g = state.0.lock().map_err(|_| "state lock failed")?;
    if g.skip_cert == skip {
        return Ok(false);
    }
    stop_engine(&mut g);
    let spawned = spawn_aria2(&app, g.proxy, skip).map_err(|e| e.to_string())?;
    g.port = spawned.port;
    g.secret = spawned.secret;
    g.skip_cert = skip;
    g.child = Some(spawned.child);
    Ok(true)
}

/// 删除任务对应的本地文件及其 .aria2 控制文件（尽力而为，忽略单个失败）
#[tauri::command]
async fn delete_files(paths: Vec<String>) {
    for p in paths {
        for target in [&p, &format!("{}.aria2", p)] {
            let path = std::path::Path::new(target);
            if !path.exists() {
                continue;
            }
            // aria2 刚释放句柄时可能有短暂占用，重试几次
            for _ in 0..5 {
                if !path.exists() || std::fs::remove_file(path).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    }
}

/// 在资源管理器中显示该文件所在目录并选中它（目录则直接打开）
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{}", path));
    }
    #[cfg(target_os = "windows")]
    {
        // /select, 必须和路径连成一个参数，否则 explorer 无法识别
        let arg = if p.is_file() {
            format!("/select,{}", path)
        } else {
            path.clone()
        };
        std::process::Command::new("explorer.exe")
            .arg(arg)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" })
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 用系统默认程序打开文件
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{}", path));
    }
    if p.is_dir() {
        return reveal_path(path);
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" })
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 读剪贴板文本（新建任务时自动预填链接用）
#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.get_text().map_err(|e| e.to_string())
}

/// 通用 HTTPS GET，返回响应体文本。headers 为 ["Key: Value", ...]。
/// 用于拉取 Civitai 模型信息：WebView 内 fetch 会被 CORS 拦，也不走本地代理；
/// proxy 传引擎当前使用的本地代理端口，保证与下载同一条网络通道可达。
#[tauri::command]
fn http_get(url: String, headers: Vec<String>, proxy: Option<u16>) -> Result<String, String> {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30));
    if let Some(p) = proxy {
        let addr = format!("http://127.0.0.1:{}", p);
        builder = builder.proxy(ureq::Proxy::new(&addr).map_err(|e| e.to_string())?);
    }
    let agent = builder.build();
    let mut req = agent.get(&url);
    for h in &headers {
        if let Some((k, v)) = h.split_once(':') {
            req = req.set(k.trim(), v.trim());
        }
    }
    req.call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

fn random_secret() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..16)
        .map(|_| format!("{:02x}", rng.gen::<u8>()))
        .collect()
}

fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.local_addr().map(|a| a.port())
}

fn spawn_aria2(
    app: &AppHandle,
    proxy: Option<u16>,
    skip_cert: bool,
) -> Result<Spawned, Box<dyn std::error::Error>> {
    let port = free_port()?;
    let secret = random_secret();

    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let session = data_dir.join("session.txt");
    if !session.exists() {
        std::fs::write(&session, "")?;
    }
    let download_dir = app.path().download_dir().unwrap_or_else(|_| data_dir.clone());

    let mut args = vec![
        "--enable-rpc".to_string(),
        format!("--rpc-listen-port={}", port),
        format!("--rpc-secret={}", secret),
        "--rpc-max-request-size=16M".to_string(),
        "--max-connection-per-server=16".to_string(),
        "--continue=true".to_string(),
        "--file-allocation=none".to_string(),
        "--summary-interval=0".to_string(),
        "--save-session-interval=30".to_string(),
        "--quiet=true".to_string(),
        // GUI 崩溃/被强杀时让引擎自行退出，避免孤儿 aria2c 进程
        format!("--stop-with-process={}", std::process::id()),
        format!("--dir={}", download_dir.display()),
        format!("--save-session={}", session.display()),
        format!("--input-file={}", session.display()),
    ];
    if let Some(p) = proxy {
        args.push(format!("--all-proxy=http://127.0.0.1:{}", p));
    }
    if skip_cert {
        // WinTLS 吊销服务器不可达（80092013）的唯一绕法，只能启动参数传入
        args.push("--check-certificate=false".to_string());
    }

    let sidecar = app.shell().sidecar("aria2c")?;
    let (mut rx, child) = sidecar.args(args).spawn()?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[aria2] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[aria2] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[aria2] process exited: {:?}", status);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(Spawned { port, secret, child })
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // 单实例插件必须第一个注册：二次启动在插件初始化阶段就唤起已有
        // 窗口并退出，不会走到 setup，也就不会拉起第二个 aria2c / 第二个托盘
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| {
            // 关闭窗口 = 最小化到托盘，下载继续；真正退出走托盘菜单
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            let proxy = DEFAULT_PROXY_PORTS.into_iter().find(|&p| probe_port(p));
            if let Some(p) = proxy {
                println!("[proxy] auto-detected local proxy at 127.0.0.1:{}", p);
            }
            let spawned = spawn_aria2(app.handle(), proxy, false)?;
            app.manage(Aria2State(Mutex::new(Aria2Inner {
                port: spawned.port,
                secret: spawned.secret,
                proxy,
                skip_cert: false,
                child: Some(spawned.child),
            })));

            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "全部暂停", true, None::<&str>)?;
            let resume = MenuItem::with_id(app, "resume", "全部继续", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &pause, &resume, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("cvia（关闭窗口后仍继续下载）")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "pause" => rpc_state(app, "pauseAll"),
                    "resume" => rpc_state(app, "unpauseAll"),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Agent 调试控制服务：127.0.0.1 HTTP → 事件 → 前端同一条 UI 代码路径
            control::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc_config,
            scan_proxy,
            set_proxy,
            set_cert_check,
            delete_files,
            reveal_path,
            open_path,
            read_clipboard,
            http_get,
            control::control_ready,
            control::control_reply
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                if let Some(state) = app.try_state::<Aria2State>() {
                    if let Ok(mut g) = state.0.lock() {
                        stop_engine(&mut g);
                    }
                }
            }
            _ => {}
        });
}
