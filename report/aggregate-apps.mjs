// 生ログ(windows配列)からアプリ別の合計秒数を決定的に集計する。AI不使用。
export function computeAppTotals(windows) {
  const totals = new Map();
  for (const w of windows ?? []) {
    const app = w.app || "(不明)";
    totals.set(app, (totals.get(app) ?? 0) + Math.round(w.duration_seconds ?? 0));
  }
  return Array.from(totals, ([app, seconds]) => ({ app, seconds }));
}
