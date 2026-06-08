import type { ContextItemEntry } from '../state/reducer';

export interface ContextPanelProps {
  /** 上下文条目列表 */
  items: ContextItemEntry[];
  /** 当前是否可见 */
  visible: boolean;
  /** 关闭面板 */
  onClose: () => void;
  /** 从上下文移除某项（可选） */
  onRemove?: (id: string) => void;
  /** 清空全部上下文（可选） */
  onClear?: () => void;
}

/**
 * ContextPanel — 上下文可视化弹出层
 *
 * 显示当前 Agent 引用的文件/符号/记忆列表及其 token 消耗。
 * 使用弹出层（popover）而非 Drawer，减少布局占用。
 * 数据来源：context_stats TaskEvent 的 items[] 字段。
 */
export function ContextPanel({ items, visible, onClose, onRemove, onClear }: ContextPanelProps): JSX.Element | null {
  if (!visible || !items || items.length === 0) return null;

  const grouped = {
    file: items.filter((i) => i.type === 'file'),
    symbol: items.filter((i) => i.type === 'symbol'),
    memory: items.filter((i) => i.type === 'memory'),
  };

  const totalTokens = items.reduce((sum, i) => sum + (i.estimatedTokens ?? 0), 0);

  return (
    <div className="context-panel" role="region" aria-label="当前上下文">
      <div className="context-panel__header">
        <span className="context-panel__title">📋 当前上下文 ({items.length})</span>
        <div className="context-panel__actions">
          {onClear && (
            <button className="context-panel__btn" onClick={onClear} title="清空全部上下文">
              清空
            </button>
          )}
          <button className="context-panel__btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
      </div>
      <div className="context-panel__body">
        {(['file', 'symbol', 'memory'] as const).map((type) =>
          grouped[type].length > 0 && (
            <div key={type} className="context-panel__group">
              <div className="context-panel__group-label">
                {type === 'file' ? '📄 文件' : type === 'symbol' ? '🔣 符号' : '🧠 记忆'}
                <span className="context-panel__group-count">{grouped[type].length}</span>
              </div>
              {grouped[type].map((item) => (
                <div key={item.id} className="context-panel__item">
                  <div className="context-panel__item-info">
                    <span className="context-panel__item-name">{item.name}</span>
                    <span className="context-panel__item-path">{item.path}</span>
                  </div>
                  <span className="context-panel__item-tokens" title={`约 ${item.estimatedTokens} tokens`}>
                    ~{item.estimatedTokens} tk
                  </span>
                  {onRemove && (
                    <button
                      className="context-panel__item-remove"
                      onClick={() => onRemove(item.id)}
                      title="从上下文移除"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )
        )}
      </div>
      <div className="context-panel__footer">
        <span className="context-panel__total">总 Token: ~{totalTokens.toLocaleString()}</span>
      </div>
    </div>
  );
}
