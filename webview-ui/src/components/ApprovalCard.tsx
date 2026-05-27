/**
 * ApprovalCard —— 工具审批内联卡片
 *
 * 在聊天流中展示审批请求，用户点击按钮决策：
 * - 允许一次
 * - 本次会话记住（仅 allowRemember 时显示）
 * - 拒绝
 *
 * W-UI8 · 增强命令展示：对 bash 工具高亮显示完整命令文本，
 * 并提示用户命令不会自动执行，审批通过后才开始运行。
 */

import type { ApprovalRequestPayload } from '../protocol';

export interface ApprovalCardProps {
  payload: ApprovalRequestPayload;
  onRespond: (requestId: string, decision: 'allow_once' | 'remember' | 'deny') => void;
}

export function ApprovalCard({ payload, onRespond }: ApprovalCardProps): JSX.Element {
  const isBash = payload.toolName === 'bash';
  return (
    <div className="approval-card" role="dialog" aria-label="工具审批请求">
      <div className="approval-card__title">
        {isBash ? '💻 DevSeeker 请求执行命令' : 'DevSeeker 请求执行工具'}
      </div>
      <div className="approval-card__info">
        <div className="approval-card__row">
          <span className="approval-card__label">工具:</span>
          <span className="approval-card__value">{payload.toolName}</span>
          <span className="approval-card__badge">{payload.safetyLevel}</span>
        </div>
        <div className="approval-card__row">
          <span className="approval-card__label">原因:</span>
          <span className="approval-card__value">{payload.reason}</span>
        </div>
        {payload.command && (
          <div className="approval-card__row approval-card__row--command">
            <span className="approval-card__label">命令:</span>
            <pre className="approval-card__code-block">
              <code>{payload.command}</code>
            </pre>
          </div>
        )}
        <div className="approval-card__row">
          <span className="approval-card__label">参数:</span>
          <span className="approval-card__value approval-card__args">{payload.argsPreview}</span>
        </div>
        {isBash && (
          <div className="approval-card__hint">
            命令将在你同意后在终端中执行，执行中的输出会在上方实时显示。
          </div>
        )}
      </div>
      <div className="approval-card__actions">
        <button
          type="button"
          className="approval-card__btn approval-card__btn--deny"
          onClick={() => onRespond(payload.requestId, 'deny')}
        >
          拒绝
        </button>
        {payload.allowRemember && (
          <button
            type="button"
            className="approval-card__btn approval-card__btn--remember"
            onClick={() => onRespond(payload.requestId, 'remember')}
          >
            本次会话记住
          </button>
        )}
        <button
          type="button"
          className="approval-card__btn approval-card__btn--allow"
          onClick={() => onRespond(payload.requestId, 'allow_once')}
        >
          允许一次
        </button>
      </div>
    </div>
  );
}
