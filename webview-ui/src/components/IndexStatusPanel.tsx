import { useEffect, useRef, useState } from 'react';
import type { IndexProgressPayload, IndexStatusPayload } from '../protocol';

interface IndexStatusPanelProps {
  progress?: IndexProgressPayload;
  status?: IndexStatusPayload;
  onReindex: () => void;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * IndexStatusPanel — 索引状态面板
 * 直接使用现有 IndexProgressPayload + IndexStatusPayload 类型。
 */
export function IndexStatusPanel({ progress, status, onReindex }: IndexStatusPanelProps): JSX.Element | null {
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (progress && (progress.phase === 'scanning' || progress.phase === 'chunking' || progress.phase === 'embedding' || progress.phase === 'saving')) {
      timerRef.current = setInterval(() => setElapsed((prev) => prev + 1000), 1000);
    } else {
      setElapsed(0);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [progress?.phase]);

  if (!status || !progress) return null;

  const showProgress = progress.phase !== 'idle' && progress.phase !== 'done';
  const pct = progress.filesTotal > 0 ? Math.round((progress.filesDone / progress.filesTotal) * 100) : 0;
  const phaseLabel: Record<string, string> = {
    scanning: '扫描文件中', chunking: '分块处理中', embedding: '向量化中', saving: '保存索引中',
    done: '已完成', idle: '空闲',
  };

  return (
    <div className="index-status-panel">
      <div className="index-status-panel__header">
        <h3>🔍 代码库索引</h3>
        <span className={`index-status-badge index-status-badge--${status?.ready ? 'ready' : 'not-ready'}`}>
          {status?.ready ? '✓ 就绪' : status?.scannedButEmpty ? '无源码' : '未就绪'}
        </span>
      </div>
      {showProgress && progress && (
        <div className="index-status-panel__progress">
          <div className="index-progress-bar">
            <div className="index-progress-bar__fill index-progress-bar__fill--animated" style={{ width: `${pct}%` }} />
          </div>
          <span className="index-progress-text">{phaseLabel[progress.phase] || progress.phase} · {progress.filesDone}/{progress.filesTotal} 文件 · {pct}%</span>
        </div>
      )}
      <div className="index-stat-grid">
        <div className="index-stat-row"><span>文件数</span><span>{status?.fileCount ?? '-'}</span></div>
        {status?.modelId && <div className="index-stat-row"><span>模型</span><span>{status.modelId}</span></div>}
        {status?.indexSize != null && <div className="index-stat-row"><span>索引大小</span><span>{formatBytes(status.indexSize)}</span></div>}
        {elapsed > 0 && <div className="index-stat-row"><span>已用时</span><span>{formatDurationMs(elapsed)}</span></div>}
      </div>
      <button className="btn btn-primary" onClick={onReindex}>🔄 重新索引</button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
