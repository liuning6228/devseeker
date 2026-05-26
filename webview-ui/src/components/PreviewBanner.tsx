/**
 * W11.4 · PreviewBanner
 *
 * 显示 `run_preview` 工具登记的本地 Web 预览 URL。用户点击「打开预览」后
 * 由 Host 侧通过 vscode.env.openExternal 在外部浏览器打开。
 */

import type { PendingPreview } from '../state/reducer';

export interface PreviewBannerProps {
  previews: PendingPreview[];
  onOpen: (url: string, toolCallId: string) => void;
  onDismiss: (toolCallId: string) => void;
}

export function PreviewBanner(props: PreviewBannerProps): JSX.Element | null {
  const { previews, onOpen, onDismiss } = props;
  if (previews.length === 0) return null;

  return (
    <div className="preview-banner">
      {previews.map((p) => (
        <div key={p.toolCallId} className="preview-banner__item">
          <span className="preview-banner__badge">Preview</span>
          <span className="preview-banner__name" title={p.name}>
            {p.name}
          </span>
          <code className="preview-banner__url" title={p.url}>
            {p.url}
          </code>
          <button
            type="button"
            className="preview-banner__action"
            onClick={() => onOpen(p.url, p.toolCallId)}
            title="在外部浏览器中打开"
          >
            打开预览
          </button>
          <button
            type="button"
            className="preview-banner__dismiss"
            onClick={() => onDismiss(p.toolCallId)}
            title="关闭此提示"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
