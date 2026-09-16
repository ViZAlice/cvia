import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { aria2 } from "../api";
import {
  loadProxyPref,
  parsePortList,
  resolveProxy,
  saveProxyPref,
  scanProxy,
  setCertCheck,
  setProxy,
  type ProxyMode,
} from "../proxy";
import { prefsToOptions, saveDownloadPrefs } from "../prefs";
import { loadCivitaiKey, saveCivitaiKey } from "../sitekeys";

interface Props {
  onClose: () => void;
  onError: (e: unknown) => void;
  onProxyChanged: () => void;
}

export default function Settings({ onClose, onError, onProxyChanged }: Props) {
  const [dir, setDir] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState("5");
  const [maxConnection, setMaxConnection] = useState("16");
  const [speedLimitKb, setSpeedLimitKb] = useState("0");
  const [split, setSplit] = useState("5");
  const [minSplitMb, setMinSplitMb] = useState("20");
  const [skipCertCheck, setSkipCertCheck] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [civitaiKey, setCivitaiKey] = useState(loadCivitaiKey());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const pref = loadProxyPref();
  const [proxyMode, setProxyMode] = useState<ProxyMode>(pref.mode);
  const [portsText, setPortsText] = useState(pref.ports.join(", "));
  const [manualPort, setManualPort] = useState(String(pref.port));
  const [detectMsg, setDetectMsg] = useState("");

  useEffect(() => {
    aria2
      .getGlobalOption()
      .then((o) => {
        setDir(o.dir ?? "");
        setMaxConcurrent(o["max-concurrent-downloads"] ?? "5");
        setMaxConnection(o["max-connection-per-server"] ?? "16");
        const limit = o["max-overall-download-limit"] ?? "0";
        setSpeedLimitKb(String(Math.floor(Number(limit) / 1024)));
        setSplit(o.split ?? "5");
        // min-split-size 返回的是字节数，界面按 MB 展示
        const mss = Number(o["min-split-size"] ?? 0);
        setMinSplitMb(mss > 0 ? String(Math.round(mss / 1048576)) : "20");
        setSkipCertCheck((o["check-certificate"] ?? "true") === "false");
        setLoaded(true);
      })
      .catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickDir = async () => {
    const selected = await open({ directory: true, title: "选择默认下载目录" });
    if (typeof selected === "string") setDir(selected);
  };

  const openDir = () => {
    if (dir) invoke("reveal_path", { path: dir }).catch(onError);
  };

  const detect = async () => {
    setDetectMsg("检测中…");
    try {
      const found = await scanProxy(parsePortList(portsText));
      setDetectMsg(
        found != null ? `检测到可用代理：127.0.0.1:${found}` : "未检测到可用代理端口",
      );
    } catch (e) {
      setDetectMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      // 先处理代理（切换会重启引擎、全局选项复位），再应用下载设置
      const ports = parsePortList(portsText);
      const newProxyPref = {
        mode: proxyMode,
        port: Number(manualPort) || 7890,
        ports: ports.length > 0 ? ports : [10808, 7890],
      };
      saveProxyPref(newProxyPref);
      const target = await resolveProxy(newProxyPref);
      let restarted = false;
      if (target !== aria2.proxy) {
        await setProxy(target);
        restarted = true;
      }
      // 证书校验开关只能通过启动参数生效（RPC 动态修改会被静默忽略）
      if (await setCertCheck(skipCertCheck)) restarted = true;
      if (restarted) {
        await aria2.reconfigure();
        onProxyChanged();
      }

      const prefs = { dir, maxConcurrent, maxConnection, speedLimitKb, split, minSplitMb, skipCertCheck };
      saveDownloadPrefs(prefs);
      await aria2.changeGlobalOption(prefsToOptions(prefs));
      saveCivitaiKey(civitaiKey.trim());
      onClose();
    } catch (e) {
      onError(e);
      setSaving(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>
        {!loaded ? (
          <div className="empty">加载中…</div>
        ) : (
          <>
            <label className="field">
              <span>默认下载目录</span>
              <div className="dir-row">
                <input
                  type="text"
                  data-testid="input-settings-dir"
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                />
                <button className="btn" data-testid="btn-browse-settings-dir" onClick={pickDir}>
                  浏览…
                </button>
                <button
                  className="btn"
                  data-testid="btn-open-settings-dir"
                  disabled={!dir}
                  onClick={openDir}
                  title="在资源管理器中打开"
                >
                  打开
                </button>
              </div>
            </label>
            <div className="field-grid">
              <label className="field">
                <span>最大同时下载数</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  data-testid="input-max-concurrent"
                  value={maxConcurrent}
                  onChange={(e) => setMaxConcurrent(e.target.value)}
                />
              </label>
              <label className="field">
                <span>全局下载限速 (KB/s，0 为不限)</span>
                <input
                  type="number"
                  min={0}
                  data-testid="input-speed-limit"
                  value={speedLimitKb}
                  onChange={(e) => setSpeedLimitKb(e.target.value)}
                />
              </label>
            </div>

            <label className="field">
              <span>Civitai API Key（civitai.com 链接自动附加鉴权，仅保存在本机）</span>
              <input
                type="password"
                data-testid="input-civitai-key"
                value={civitaiKey}
                placeholder="留空则不附加"
                onChange={(e) => setCivitaiKey(e.target.value)}
              />
            </label>

            <div className="advanced">
              <button
                type="button"
                className="advanced-toggle"
                data-testid="btn-advanced-toggle"
                onClick={() => setAdvancedOpen(!advancedOpen)}
              >
                <span className={`arrow ${advancedOpen ? "open" : ""}`}>▸</span> 高级
              </button>
              {advancedOpen && (
                <div className="advanced-body">
                  <div className="field-grid">
                    <label className="field">
                      <span>单任务分片数（split，决定实际连接数）</span>
                      <input
                        type="number"
                        min={1}
                        max={16}
                        data-testid="input-split"
                        value={split}
                        onChange={(e) => setSplit(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>最小分片大小 (MB)</span>
                      <input
                        type="number"
                        min={1}
                        max={1024}
                        data-testid="input-min-split"
                        value={minSplitMb}
                        onChange={(e) => setMinSplitMb(e.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>单任务最大连接数（上限）</span>
                      <input
                        type="number"
                        min={1}
                        max={16}
                        data-testid="input-max-connection"
                        value={maxConnection}
                        onChange={(e) => setMaxConnection(e.target.value)}
                      />
                    </label>
                  </div>

                  <label className="check-row">
                    <input
                      type="checkbox"
                      data-testid="check-skip-cert"
                      checked={skipCertCheck}
                      onChange={(e) => setSkipCertCheck(e.target.checked)}
                    />
                    <span>
                      跳过 HTTPS 证书校验（报「吊销服务器已脱机 80092013」时开启；切换会重启下载引擎；会降低安全性，按需使用）
                    </span>
                  </label>

                  <div className="proxy-section">
              <div className="proxy-title">代理（切换会重启下载引擎，任务自动恢复）</div>
              <div className="proxy-modes">
                {(
                  [
                    ["auto", "自动检测"],
                    ["manual", "手动指定"],
                    ["off", "不使用"],
                  ] as [ProxyMode, string][]
                ).map(([m, label]) => (
                  <label key={m} className="radio">
                    <input
                      type="radio"
                      name="proxy-mode"
                      data-testid={`radio-proxy-${m}`}
                      checked={proxyMode === m}
                      onChange={() => setProxyMode(m)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {proxyMode === "auto" && (
                  <label className="field">
                    <span>探测端口列表（逗号分隔，按顺序取第一个可用）</span>
                    <div className="dir-row">
                      <input
                        type="text"
                        data-testid="input-ports"
                        value={portsText}
                        onChange={(e) => setPortsText(e.target.value)}
                      />
                      <button className="btn" data-testid="btn-detect" onClick={detect}>
                        检测
                      </button>
                    </div>
                  </label>
              )}
              {proxyMode === "manual" && (
                <label className="field">
                  <span>本地代理端口（http://127.0.0.1:端口）</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    data-testid="input-manual-port"
                    value={manualPort}
                    onChange={(e) => setManualPort(e.target.value)}
                  />
                </label>
              )}
              {detectMsg && proxyMode === "auto" && (
                <div className="detect-msg">{detectMsg}</div>
              )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" data-testid="btn-cancel-settings" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            data-testid="btn-save-settings"
            disabled={!loaded || saving}
            onClick={save}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
