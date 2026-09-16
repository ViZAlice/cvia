import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Agent 控制桥：Rust 侧的本地 HTTP 服务把指令以 control:command 事件
 * 转发进来，这里在页面上下文执行 —— 点击/填表走的是和用户操作完全相同的
 * React 处理函数，aria2 调用仍由 Aria2Client 的 WebSocket 发出（同一通道）。
 *
 * 每条指令的回执都附带执行后的完整页面快照（page 字段）：当前弹窗、
 * 可见交互控件及其值、App 状态。这样调用方做完一个操作立刻能看到 UI
 * 现状 —— 弹窗意外消失、按钮被禁用等异常一眼可见，不会盲操作。
 */

interface Command {
  id: number;
  type: string;
  payload?: Record<string, unknown>;
}

interface Step {
  type: string;
  payload?: Record<string, unknown>;
  /** 该步执行完的额外等待（毫秒，让轮询状态刷新），上限 5s */
  wait?: number;
}

const MAX_WAIT = 5000;
/** 快照收集的交互元素范围 */
const EL_SELECTOR = "button, input, select, textarea, [data-testid]";

let stateProvider: (() => unknown) | null = null;
let started = false;
/** 假下载开关（App 注册；控制通道 {"type":"fake"} 调用，离线调视觉/截图用） */
let fakeToggle: ((on: boolean, count: number) => void) | null = null;
/** 控制服务地址（control_ready 返回实际端口；图片代理等本地资源用） */
let baseUrl = "http://127.0.0.1:33211";

export function controlBaseUrl(): string {
  return baseUrl;
}

export function registerFakeToggle(fn: (on: boolean, count: number) => void) {
  fakeToggle = fn;
}

/** App 每次渲染后调用，注册最新的状态快照取值函数 */
export function setStateProvider(fn: () => unknown) {
  stateProvider = fn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function q(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`元素不存在：${selector}`);
  return el as HTMLElement;
}

/**
 * React 受控组件兼容的赋值：必须用原型链上的原生 setter 改 value，
 * 再派发 input/change 事件，直接 el.value= 会被 React 无视。
 */
function setValue(el: Element, value: string) {
  if (el instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(el, value);
  } else if (el instanceof HTMLInputElement && !["checkbox", "radio", "file"].includes(el.type)) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, value);
  } else if (el instanceof HTMLSelectElement) {
    el.value = value;
  } else if (el instanceof HTMLInputElement) {
    throw new Error("checkbox/radio 请用 click 指令切换");
  } else {
    throw new Error(`不支持填充的元素：<${el.tagName.toLowerCase()}>`);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 点击时自动代答 window.confirm/alert —— 原生弹窗会卡死自动化；confirm:false 等同用户点了取消 */
function clickEl(el: HTMLElement, autoConfirm: boolean) {
  const oc = window.confirm;
  const oa = window.alert;
  if (autoConfirm) {
    window.confirm = () => true;
    window.alert = () => {};
  }
  try {
    el.click();
  } finally {
    window.confirm = oc;
    window.alert = oa;
  }
}

function visible(el: Element): boolean {
  const e = el as HTMLElement;
  return !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
}

/** 元素的展示文本：按钮取文字；输入框取关联的 label（字段名） */
function elText(el: Element): string | undefined {
  const e = el as HTMLElement;
  let s: string;
  if (
    e instanceof HTMLInputElement ||
    e instanceof HTMLTextAreaElement ||
    e instanceof HTMLSelectElement
  ) {
    const ph = (e as HTMLInputElement).placeholder ?? "";
    s = e.closest("label")?.querySelector("span")?.textContent ?? ph;
  } else {
    s = e.innerText ?? "";
  }
  s = s.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 48) : undefined;
}

function selectorOf(el: Element): string | undefined {
  const tid = el.getAttribute("data-testid");
  if (tid) return `[data-testid="${tid}"]`;
  const id = el.getAttribute("id");
  if (id) return `#${id}`;
  // 没有稳定选择器的元素（如任务行内的动态按钮）仍会列出，便于理解页面
  return undefined;
}

/** 完整结构化页面快照 */
function buildPage() {
  const elements = [...document.querySelectorAll(EL_SELECTOR)]
    .filter(visible)
    .map((el) => {
      const field =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      const input = el as HTMLInputElement;
      return {
        tag: el.tagName.toLowerCase(),
        testid: el.getAttribute("data-testid") ?? undefined,
        selector: selectorOf(el),
        text: elText(el),
        // 密码框只回显长度，避免密钥进日志
        value: field
          ? input.type === "password"
            ? `<masked:${input.value.length}>`
            : input.value.slice(0, 120)
          : undefined,
        checked:
          el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")
            ? el.checked
            : undefined,
        disabled: el.matches(":disabled") || undefined,
        gid: el.closest("[data-gid]")?.getAttribute("data-gid") ?? undefined,
      };
    });
  return {
    at: Date.now(),
    title: document.title,
    /** 当前弹窗标题（.modal h2），null = 没有弹窗 */
    modal: document.querySelector(".modal h2")?.textContent?.trim() ?? null,
    banners: [...document.querySelectorAll(".error-banner")]
      .map((b) => b.textContent?.trim())
      .filter(Boolean),
    state: stateProvider?.() ?? null,
    elements,
  };
}

/** 单个原语指令；batch / page 在 runCommand 里单独处理 */
async function execType(type: string, p: Record<string, unknown>): Promise<unknown> {
  switch (type) {
    case "ping":
      return { pong: true };
    case "click": {
      const el = q(String(p.selector));
      if (el.matches(":disabled")) throw new Error(`元素已禁用：${p.selector}`);
      clickEl(el, p.confirm !== false);
      return { clicked: String(p.selector) };
    }
    case "fake": {
      // 假下载开关：离线注入/移除合成任务组（带占位封面、进度自动走到 97%）
      if (!fakeToggle) throw new Error("假下载未就绪（页面还没加载完）");
      const on = p.on !== false;
      const count = Math.min(Math.max(Number(p.count ?? 1) || 1, 1), 6);
      fakeToggle(on, count);
      return { fake: on, count: on ? count : 0 };
    }
    case "fill": {
      const el = q(String(p.selector));
      if (el.matches(":disabled")) throw new Error(`元素已禁用：${p.selector}`);
      setValue(el, String(p.value ?? ""));
      return { filled: String(p.selector) };
    }
    default:
      throw new Error(`未知指令：${type}`);
  }
}

/**
 * 执行指令并组装回执信封。batch 按顺序执行多个步骤，任何一步失败立即
 * 停止 —— 无论成功失败，page 字段都反映「最后时刻」的页面现场。
 */
async function runCommand(
  type: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const wait = Math.min(Math.max(Number(payload.wait ?? 0) || 0, 0), MAX_WAIT);

  if (type === "page") {
    if (wait) await sleep(wait);
    return { ok: true, page: buildPage() };
  }

  if (type === "batch") {
    const steps = Array.isArray(payload.steps) ? (payload.steps as Step[]) : [];
    if (steps.length === 0) throw new Error("batch 需要 steps 数组");
    const wantAll = payload.snapshots === "all";
    const results: unknown[] = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s || typeof s.type !== "string") throw new Error(`步骤 ${i} 缺少 type`);
      try {
        const r = await execType(s.type, s.payload ?? {});
        if (s.wait) await sleep(Math.min(s.wait, MAX_WAIT));
        results.push({
          step: i,
          type: s.type,
          ok: true,
          result: r,
          ...(wantAll ? { page: buildPage() } : {}),
        });
      } catch (e) {
        await sleep(0); // 让 React 完成本轮渲染，快照反映失败现场
        return {
          ok: false,
          error: `步骤 ${i}（${s.type}）失败：${errMsg(e)}`,
          results,
          page: buildPage(),
        };
      }
    }
    if (wait) await sleep(wait);
    return { ok: true, results, page: buildPage() };
  }

  const result = await execType(type, payload);
  if (wait) await sleep(wait);
  return { ok: true, result, page: buildPage() };
}

/** 挂载控制桥：先注册事件监听，再通知 Rust 已就绪并取回实际端口 */
export async function initControlBridge(): Promise<void> {
  if (started) return;
  started = true;
  await listen<Command>("control:command", (ev) => {
    const cmd = ev.payload;
    runCommand(cmd.type, cmd.payload ?? {})
      .then((data) => invoke("control_reply", { id: cmd.id, data }))
      .catch((e: unknown) =>
        invoke("control_reply", {
          id: cmd.id,
          data: { ok: false, error: errMsg(e), page: buildPage() },
        }),
      )
      .catch(() => {}); // app 正在退出等极端情况，回执失败只能放弃
  });
  const port = await invoke<number>("control_ready");
  if (typeof port === "number" && port > 0) baseUrl = `http://127.0.0.1:${port}`;
}
