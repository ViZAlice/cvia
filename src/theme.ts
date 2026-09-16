/** 明暗主题：默认跟随系统，手动切换后记住选择 */

const KEY = "aria2-app:theme";

export type Theme = "dark" | "light";

export function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // 忽略存储失败
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // 忽略存储失败
  }
}
