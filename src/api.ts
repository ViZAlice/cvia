import { invoke } from "@tauri-apps/api/core";
import type { Aria2Task, GlobalOption, GlobalStat } from "./types";

const STATUS_KEYS = [
  "gid",
  "status",
  "totalLength",
  "completedLength",
  "uploadLength",
  "downloadSpeed",
  "uploadSpeed",
  "connections",
  "dir",
  "files",
  "bittorrent",
  "infoHash",
  "numSeeders",
  "seeder",
  "errorCode",
  "errorMessage",
];

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

export interface RpcConfig {
  port: number;
  secret: string;
  proxy: number | null;
  skipCert: boolean;
}

export class Aria2Client {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private outbox: string[] = [];
  private url = "";
  private token = "";
  /** 每次新建连接递增，用于作废旧 socket 的事件和重连定时器 */
  private generation = 0;

  started = false;
  connected = false;
  proxy: number | null = null;
  certCheck = false;
  onConnectedChange: (v: boolean) => void = () => {};
  onAria2Event: () => void = () => {};

  async init() {
    if (this.started) return;
    this.started = true;
    await this.applyConfig();
    this.connect();
  }

  /** 引擎重启后重新读取连接信息并重连（可安全重复调用） */
  async reconfigure() {
    await this.applyConfig();
    // 递增 generation：旧 socket 的 onclose / 重连定时器全部失效
    this.generation++;
    const old = this.ws;
    this.ws = null;
    if (old) {
      try {
        old.close();
      } catch {
        // 忽略关闭异常
      }
    }
    for (const [, p] of this.pending) p.reject(new Error("引擎重启，连接重建中"));
    this.pending.clear();
    this.setConnected(false);
    this.connect();
  }

  private async applyConfig() {
    const cfg = await invoke<RpcConfig>("rpc_config");
    this.url = `ws://127.0.0.1:${cfg.port}/jsonrpc`;
    this.token = `token:${cfg.secret}`;
    this.proxy = cfg.proxy;
    this.certCheck = cfg.skipCert;
  }

  private setConnected(v: boolean) {
    if (this.connected !== v) {
      this.connected = v;
      this.onConnectedChange(v);
    }
  }

  private connect() {
    const gen = ++this.generation;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.generation) {
        ws.close();
        return;
      }
      this.setConnected(true);
      for (const m of this.outbox.splice(0)) ws.send(m);
    };
    ws.onclose = () => {
      if (gen !== this.generation) return;
      this.setConnected(false);
      for (const [, p] of this.pending) p.reject(new Error("连接已断开"));
      this.pending.clear();
      setTimeout(() => {
        if (gen === this.generation) this.connect();
      }, 1000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // 忽略关闭异常
      }
    };
    ws.onmessage = (ev) => {
      if (gen !== this.generation) return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (Array.isArray(msg)) msg.forEach((m) => this.handle(m));
      else this.handle(msg);
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handle(msg: any) {
    if (msg == null || typeof msg !== "object") return;
    if (msg.id != null) {
      const p = this.pending.get(Number(msg.id));
      if (p) {
        this.pending.delete(Number(msg.id));
        if (msg.error) p.reject(new Error(msg.error.message || "aria2 错误"));
        else p.resolve(msg.result);
      }
    } else if (typeof msg.method === "string" && msg.method.startsWith("aria2.on")) {
      this.onAria2Event();
    }
  }

  private call<T>(method: string, params: unknown[] = []): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      // 高负载时 aria2 可能迟迟不响应，超时兜底避免 UI 永久挂起
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`请求超时：aria2.${method}`));
        }
      }, 15000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: `aria2.${method}`,
        params: [this.token, ...params],
      });
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(payload);
      else this.outbox.push(payload);
    });
  }

  tellActive() {
    return this.call<Aria2Task[]>("tellActive", [STATUS_KEYS]);
  }
  tellWaiting() {
    return this.call<Aria2Task[]>("tellWaiting", [0, 1000, STATUS_KEYS]);
  }
  tellStopped() {
    return this.call<Aria2Task[]>("tellStopped", [0, 1000, STATUS_KEYS]);
  }
  getGlobalStat() {
    return this.call<GlobalStat>("getGlobalStat");
  }
  getGlobalOption() {
    return this.call<GlobalOption>("getGlobalOption");
  }
  /** 任务的原始选项：只返回添加时显式设置过的项（out/header/checksum 等） */
  getOption(gid: string) {
    return this.call<Record<string, string>>("getOption", [gid]);
  }
  changeGlobalOption(opts: Record<string, string>) {
    return this.call<string>("changeGlobalOption", [opts]);
  }
  getVersion() {
    return this.call<{ version: string }>("getVersion");
  }

  addUri(uris: string[], options: Record<string, string | string[]>) {
    return this.call<string>("addUri", [uris, options]);
  }
  pause(gid: string) {
    return this.call<string>("pause", [gid]);
  }
  unpause(gid: string) {
    return this.call<string>("unpause", [gid]);
  }
  remove(gid: string) {
    return this.call<string>("remove", [gid]);
  }
  removeDownloadResult(gid: string) {
    return this.call<string>("removeDownloadResult", [gid]);
  }
  pauseAll() {
    return this.call<string>("pauseAll");
  }
  unpauseAll() {
    return this.call<string>("unpauseAll");
  }
}

export const aria2 = new Aria2Client();
