/**
 * 时间格式化工具（子代理卡片 / 分组条共用）
 */

/** 时长格式化：<1s 显示 ms，<60s 显示 s，其余 m:ss */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m${rs.toString().padStart(2, '0')}s`;
}

/** ETA 粗粒度格式化（估算值不需要秒级精度） */
export function fmtEta(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return '>1h';
}
