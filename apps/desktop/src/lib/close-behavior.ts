// close-behavior.ts — 关窗行为偏好（项 11）。
//
// lf:close-action: 'ask' | 'tray' | 'quit'，默认 'ask'。
// - 'tray'：隐藏到系统托盘（进程保留，后台运行）。
// - 'quit'：直接退出进程。
// - 'ask'：每次弹询问（首次默认）。
//
// 由 App.tsx 的 close-requested 监听读取，由 SettingsDialog「通用」tab 修改。
const KEY = 'lf:close-action';

export type CloseAction = 'ask' | 'tray' | 'quit';

export function loadCloseAction(): CloseAction {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'tray' || v === 'quit' ? v : 'ask';
  } catch {
    return 'ask';
  }
}

export function saveCloseAction(action: CloseAction) {
  try {
    localStorage.setItem(KEY, action);
  } catch {
    /* 忽略配额/禁用 */
  }
}
