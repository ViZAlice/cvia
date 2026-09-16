import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import { aria2 } from "./api";
import { initControlBridge, registerFakeToggle, setStateProvider } from "./control";
import { makeFakeTasks, tickFake } from "./fake";
import { loadProxyPref, resolveProxy, setCertCheck, setProxy } from "./proxy";
import { applySiteAuth } from "./sitekeys";
import { applyDownloadPrefs, loadDownloadPrefs } from "./prefs";
import type { Aria2Task, GlobalStat } from "./types";
import { fmtSpeed, taskName } from "./format";
import { applyTheme, loadTheme, type Theme } from "./theme";
import TaskList from "./components/TaskList";
import AddTask from "./components/AddTask";
import Settings from "./components/Settings";

type Tab = "downloading" | "complete" | "stopped";

/** 失败任务自动重试上限 */
const MAX_AUTO_RETRY = 3;

/** 收集任务的原始下载链接（BT/磁力任务拿不到，返回空数组） */
function collectUris(t: Aria2Task): string[] {
  const set = new Set<string>();
  for (const f of t.files ?? []) {
    for (const u of f.uris ?? []) {
      if (u.uri) set.add(u.uri);
    }
  }
  return [...set];
}

/** 任务的稳定标识：鉴权后的主链接（gid 每次重试都会变） */
function taskKey(t: Aria2Task): string {
  const u = collectUris(t)[0];
  return u ? applySiteAuth(u).uri : "";
}

/**
 * 取回任务添加时显式指定的下载选项（out / header / checksum）。
 * 重开、重试必须原样带回：丢掉 out 会让文件名回到默认值，
 * 与已有分片的 .aria2 控制文件对不上，断点续传失效、进度归零、产生重复文件。
 * getOption 只返回显式设置过的键（实测未设置的 out/header/checksum 键不存在），
 * 且必须在任务被移除前调用，gid 从引擎消失后就取不到了。
 */
async function taskOptions(t: Aria2Task): Promise<Record<string, string | string[]>> {
  const options: Record<string, string | string[]> = {};
  if (t.dir) options.dir = t.dir;
  try {
    const o = await aria2.getOption(t.gid);
    if (o.out) options.out = o.out;
    if (o.checksum) options.checksum = o.checksum;
    // getOption 把列表型 header 以 \n 连接的字符串返回，addUri 则接受数组
    const headers = o.header?.split("\n").map((s) => s.trim()).filter(Boolean) ?? [];
    if (headers.length > 0) options.header = headers;
  } catch {
    // 引擎繁忙取不到原始选项时退回旧行为（仅带 dir）
  }
  return options;
}

interface RetryState {
  count: number;
  nextAt: number;
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [downloading, setDownloading] = useState<Aria2Task[]>([]);
  const [stopped, setStopped] = useState<Aria2Task[]>([]);
  const [stat, setStat] = useState<GlobalStat | null>(null);
  const [version, setVersion] = useState("");
  const [proxyPort, setProxyPort] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("downloading");
  const [showAdd, setShowAdd] = useState(false);
  const [addPreset, setAddPreset] = useState<"civitai" | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<Theme>(loadTheme);
  /** 假下载（调试）：离线注入的合成任务组，调下载态视觉/截图用 */
  const [fakeTasks, setFakeTasks] = useState<Aria2Task[]>([]);
  const busyRef = useRef(false);
  /** 自动重试状态（次数 + 下次允许重试的时间戳），按链接记录 */
  const retryRef = useRef(new Map<string, RetryState>());
  /** 正在重试中的链接，防止轮询重复触发 */
  const retryingRef = useRef(new Set<string>());
  /** stopped 列表降频轮询时的缓存 */
  const stoppedRef = useRef<Aria2Task[]>([]);
  const tickRef = useRef(0);

  /**
   * 主动重开任务：移除任务（保留分片和控制文件）后用同一链接重新添加，
   * 新任务应用最新全局设置，--continue 自动断点续传。
   */
  const restartTask = useCallback(async (t: Aria2Task) => {
    const uris = collectUris(t).map((u) => applySiteAuth(u).uri);
    if (uris.length === 0) throw new Error("找不到原始下载链接，无法重开");
    const options = await taskOptions(t);
    await aria2.remove(t.gid);
    await aria2.addUri(uris, options);
    await aria2.removeDownloadResult(t.gid).catch(() => {});
  }, []);

  /**
   * 用原始链接重新添加失败任务（aria2 靠 .aria2 控制文件断点续传）。
   * reset=true 表示用户手动重试，清零重试计数。
   */
  const retryTask = useCallback(async (t: Aria2Task, opts: { reset?: boolean } = {}) => {
    const uris = collectUris(t).map((u) => applySiteAuth(u).uri);
    if (uris.length === 0) throw new Error("找不到原始下载链接，无法重试");
    if (opts.reset) retryRef.current.delete(uris[0]);
    const options = await taskOptions(t);
    await aria2.addUri(uris, options);
    await aria2.removeDownloadResult(t.gid).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    if (busyRef.current || !aria2.connected) return;
    busyRef.current = true;
    try {
      tickRef.current++;
      // stopped 列表每 5 秒拉一次，降低高负载时的 RPC 压力
      const pollStopped = tickRef.current % 5 === 1;
      const [active, waiting, globalStat] = await Promise.all([
        aria2.tellActive(),
        aria2.tellWaiting(),
        aria2.getGlobalStat(),
      ]);
      let stoppedList = stoppedRef.current;
      if (pollStopped) {
        stoppedList = await aria2.tellStopped();
        stoppedRef.current = stoppedList;
      }
      setDownloading([...active, ...waiting]);
      setStopped(stoppedList);
      setStat(globalStat);

      // 正常下载中（有速度）的任务，重置重试计数
      for (const t of [...active, ...waiting]) {
        if (t.status === "active" && Number(t.downloadSpeed) > 0) {
          const key = taskKey(t);
          if (key) retryRef.current.delete(key);
        }
      }
      // 失败任务自动重试（BT/磁力拿不到原始链接，跳过），退避 10s/20s/30s
      const now = Date.now();
      for (const t of stoppedList) {
        if (t.status !== "error" || t.bittorrent || t.infoHash) continue;
        const key = taskKey(t);
        if (!key || retryingRef.current.has(key)) continue;
        const st = retryRef.current.get(key) ?? { count: 0, nextAt: 0 };
        if (st.count >= MAX_AUTO_RETRY || now < st.nextAt) continue;
        retryRef.current.set(key, {
          count: st.count + 1,
          nextAt: now + (st.count + 1) * 10000,
        });
        retryingRef.current.add(key);
        retryTask(t)
          .catch(() => {})
          .finally(() => retryingRef.current.delete(key));
      }
    } catch {
      // 瞬断时忽略，下轮轮询会恢复
    } finally {
      busyRef.current = false;
    }
  }, [retryTask]);

  useEffect(() => {
    // Agent 调试控制桥（同 UI 通道：点击/填表 → React 处理函数 → Aria2Client）
    initControlBridge().catch(() => {});
    aria2.onConnectedChange = (v) => {
      setConnected(v);
      if (v) {
        aria2
          .getVersion()
          .then((r) => setVersion(r.version))
          .catch(() => {});
        refresh();
      }
    };
    aria2.onAria2Event = () => {
      refresh();
    };
    aria2
      .init()
      .then(async () => {
        setProxyPort(aria2.proxy);
        // 应用本地保存的代理偏好（自动检测 / 手动 / 关闭）
        const target = await resolveProxy(loadProxyPref());
        if (target !== aria2.proxy) {
          await setProxy(target);
          await aria2.reconfigure();
          setProxyPort(aria2.proxy);
        }
        // 证书校验开关只能通过启动参数生效，与本地偏好不一致则重启引擎
        const wantSkip = loadDownloadPrefs()?.skipCertCheck ?? false;
        if (wantSkip !== aria2.certCheck) {
          if (await setCertCheck(wantSkip)) await aria2.reconfigure();
        }
        // 重放本地保存的下载设置（引擎重启后全局选项会回到默认值）
        await applyDownloadPrefs().catch(() => {});
      })
      .catch((e) => setError(String(e)));
    const timer = setInterval(refresh, 1000);
    // 连接看门狗：掉线超过 3 秒则重新读取引擎配置并重连（引擎可能已被重启换端口）
    let lostTicks = 0;
    const watchdog = setInterval(() => {
      if (!aria2.started) return;
      if (aria2.connected) {
        lostTicks = 0;
      } else if (++lostTicks >= 3) {
        lostTicks = 0;
        aria2.reconfigure().catch(() => {});
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      clearInterval(watchdog);
    };
  }, [refresh]);

  const showError = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    window.setTimeout(() => setError(""), 5000);
  };

  const run = (fn: () => Promise<unknown>): Promise<void> =>
    fn()
      .then(() => refresh())
      .catch(showError);

  /** 批量清除下载记录（不动磁盘文件） */
  const clearAllRecords = (list: Aria2Task[]) => {
    const label = tab === "complete" ? "已完成" : "失败";
    if (list.length === 0) return;
    if (!window.confirm(`确定清除全部 ${list.length} 条${label}记录吗？（磁盘上的文件会保留）`))
      return;
    run(() =>
      Promise.allSettled(list.map((t) => aria2.removeDownloadResult(t.gid))).then(() => undefined),
    );
  };

  // 展示层用的下载中列表：真实任务 + 可选的假任务（计数/页签/氛围层/快照统一走它）
  const downloadingView = [...fakeTasks, ...downloading];

  // 假下载注册 + 进度推进（封顶 97% 不完成，便于观察）
  useEffect(() => {
    registerFakeToggle((on, count) => setFakeTasks(on ? makeFakeTasks(count) : []));
  }, []);
  const fakeOn = fakeTasks.length > 0;
  useEffect(() => {
    if (!fakeOn) return;
    const timer = setInterval(() => setFakeTasks((f) => (f.length ? tickFake(f) : f)), 1000);
    return () => clearInterval(timer);
  }, [fakeOn]);

  const complete = stopped.filter((t) => t.status === "complete");
  const failed = stopped.filter((t) => t.status !== "complete");
  const current =
    tab === "downloading" ? downloadingView : tab === "complete" ? complete : failed;
  /** 有任务在跑（含排队/假下载）：整窗进入「下载中」氛围（左下角拉起的背景切换） */
  const engineActive =
    fakeOn || downloading.some((t) => t.status === "active" || t.status === "waiting");

  // 窗口标题实时反映下载速度，最小化/切走时也能一眼看到状态
  useEffect(() => {
    const dl = Number(stat?.downloadSpeed ?? 0);
    const title = dl > 0 ? `↓ ${fmtSpeed(dl)} · Aria2 下载器` : "Aria2 下载器";
    document.title = title;
    // 原生窗口标题（标题栏/任务栏显示的）需要单独设置
    getCurrentWindow().setTitle(title).catch(() => {});
  }, [stat]);

  // 任务栏总进度：进行中任务的合计完成比例，无任务时清除
  useEffect(() => {
    const active = downloading.filter((t) => t.status === "active" || t.status === "waiting");
    let ratio: number | null = null;
    if (active.length > 0) {
      const total = active.reduce((s, t) => s + Number(t.totalLength), 0);
      const done = active.reduce((s, t) => s + Number(t.completedLength), 0);
      if (total > 0) ratio = Math.min(1, done / total);
    }
    getCurrentWindow()
      .setProgressBar(
        ratio != null
          ? { status: ProgressBarStatus.Normal, progress: ratio * 100 }
          : { status: ProgressBarStatus.None },
      )
      .catch(() => {});
  }, [downloading]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // 控制桥状态快照：每次渲染后更新，供调试通道的 page 指令读取。
  // 只读当前渲染的值，不在渲染期间写任何共享状态。
  useEffect(() => {
    const brief = (t: Aria2Task) => ({
      gid: t.gid,
      status: t.status,
      name: taskName(t),
      totalLength: t.totalLength,
      completedLength: t.completedLength,
      dir: t.dir,
      errorCode: t.errorCode,
      errorMessage: t.errorMessage,
      files: t.files?.map((f) => f.path).filter(Boolean),
    });
    setStateProvider(() => ({
      connected,
      aria2Connected: aria2.connected,
      version,
      proxyPort,
      tab,
      theme,
      showAdd,
      showSettings,
      error,
      downloadSpeed: stat?.downloadSpeed ?? "0",
      tasks: {
        downloading: downloadingView.map(brief),
        stopped: stopped.map(brief),
      },
    }));
  });

  return (
    <div className="app" data-dl={engineActive ? "on" : "off"}>
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="logo" aria-hidden>
            ⇣
          </span>
          <span className="title">Aria2 下载器</span>
        </div>
        <div className="header-actions">
          <button
            className="icon-ghost"
            data-testid="btn-theme"
            title={theme === "dark" ? "切换到亮色" : "切换到深色"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <button
            className="icon-ghost"
            data-testid="btn-settings"
            title="设置"
            onClick={() => setShowSettings(true)}
          >
            ⚙
          </button>
          <div className="win-controls">
            <button
              className="win-btn"
              data-testid="win-min"
              title="最小化"
              onClick={() => getCurrentWindow().minimize()}
            >
              ─
            </button>
            <button
              className="win-btn"
              data-testid="win-max"
              title="最大化 / 还原"
              onClick={() => getCurrentWindow().toggleMaximize()}
            >
              ▢
            </button>
            <button
              className="win-btn close"
              data-testid="win-close"
              title="关闭（最小化到托盘，下载继续）"
              onClick={() => getCurrentWindow().close()}
            >
              ✕
            </button>
          </div>
        </div>
      </header>

      {/* 中间内容区：独立的圆角面板，页签 / 列表 / 下载氛围层都在圆角内 */}
      <div className="content-frame">
        {/* 下载中氛围层：从左下角斜向拉起 / 收起，内部光斑缓慢漂移 */}
        <div className="dl-wash" aria-hidden>
          <div className="dl-blob b1" />
          <div className="dl-blob b2" />
        </div>
        <div className="tabs-row">
          <nav className="segmented">
            {(
              [
                ["downloading", `下载中`],
                ["complete", `已完成`],
                ["stopped", `已停止`],
              ] as [Tab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                className={`tab ${tab === key ? "active" : ""}`}
                data-testid={`tab-${key}`}
                onClick={() => setTab(key)}
              >
                {label}
              <span className="tab-count">
                {key === "downloading"
                  ? downloadingView.length
                  : key === "complete"
                    ? complete.length
                    : failed.length}
              </span>
              </button>
            ))}
          </nav>
          <button
            className="icon-ghost"
            data-testid="btn-pause-all"
            title="全部暂停"
            onClick={() => run(() => aria2.pauseAll())}
          >
            ⏸
          </button>
          <button
            className="icon-ghost"
            data-testid="btn-resume-all"
            title="全部继续"
            onClick={() => run(() => aria2.unpauseAll())}
          >
            ▶
          </button>
          <span className="spacer" />
          {tab !== "downloading" && current.length > 0 && (
            <button
              className="btn small"
              data-testid="btn-clear-all"
              onClick={() => clearAllRecords(current)}
            >
              清除全部记录
            </button>
          )}
          <button
            className="btn civitai-btn"
            data-testid="btn-civitai"
            title="粘贴 Civitai 模型页链接，自动列出版本 / 文件 / 预览"
            onClick={() => {
              setAddPreset("civitai");
              setShowAdd(true);
            }}
          >
            ⌁ Civitai
          </button>
          <button
            className="btn primary"
            data-testid="btn-add"
            onClick={() => {
              setAddPreset(null);
              setShowAdd(true);
            }}
          >
            + 新建下载
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <main className="main">
          {!connected ? (
            <div className="empty">
              <div className="empty-icon" aria-hidden>
                ⌛
              </div>
              <div>正在连接 aria2 引擎…</div>
            </div>
          ) : current.length === 0 ? (
            <div className="empty">
              <div className="empty-icon" aria-hidden>
                ⇣
              </div>
              <div>{tab === "downloading" ? "暂无下载任务" : "暂无记录"}</div>
              {tab === "downloading" && (
                <div className="empty-hint">
                  点击右上角「+ 新建下载」开始 · 支持直链 / 磁力 / Civitai 模型页链接
                </div>
              )}
            </div>
          ) : (
            <TaskList
              tasks={current}
              onAction={run}
              onRestart={(t) => restartTask(t).catch(showError)}
              onRetry={(t) => retryTask(t, { reset: true }).catch(showError)}
              isRetryExhausted={(t) => {
                const key = taskKey(t);
                const st = key ? retryRef.current.get(key) : undefined;
                return !!st && st.count >= MAX_AUTO_RETRY;
              }}
              onError={showError}
            />
          )}
        </main>
      </div>

      <footer className="footer">
        <span className={`dot ${connected ? "on" : "off"}`} />
        <span>{connected ? `已连接 · aria2 ${version}` : "未连接"}</span>
        <span className={proxyPort != null ? "proxy-on" : ""}>
          {proxyPort != null ? `代理 127.0.0.1:${proxyPort}` : "无代理"}
        </span>
        <span className="spacer" />
        <span className="num">↓ {fmtSpeed(Number(stat?.downloadSpeed ?? 0))}</span>
        <span className="num">↑ {fmtSpeed(Number(stat?.uploadSpeed ?? 0))}</span>
      </footer>

      {showAdd && (
        <AddTask
          preset={addPreset ?? undefined}
          onClose={() => setShowAdd(false)}
          onDone={() => {
            setShowAdd(false);
            // 新任务出现在下载中页签，自动切过去给用户即时反馈
            setTab("downloading");
            refresh();
          }}
          onError={showError}
        />
      )}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onError={showError}
          onProxyChanged={() => setProxyPort(aria2.proxy)}
        />
      )}
    </div>
  );
}
