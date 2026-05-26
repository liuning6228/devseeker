/**
 * PlanSwitchBanner —— Plan 模式且 plan 文档已就绪时，
 * 在对话头部展示"切换到 Agent 执行"按钮。
 *
 * 用户点击后发送 switch_to_agent_after_plan 消息给 extension，
 * extension 切回 Agent 模式并保留 planDoc 路径，下一轮输入自动注入。
 */
import { type JSX } from 'react';

export interface PlanSwitchBannerProps {
  visible: boolean;
  onSwitchToAgent: () => void;
}

export function PlanSwitchBanner({
  visible,
  onSwitchToAgent,
}: PlanSwitchBannerProps): JSX.Element | null {
  if (!visible) return null;

  return (
    <div className="plan-switch-banner">
      <span className="plan-switch-banner__text">
        📋 Plan 文档已就绪，等待您切换到 Agent 模式执行。
      </span>
      <button
        type="button"
        className="plan-switch-banner__btn"
        onClick={onSwitchToAgent}
        title="切换到 Agent 模式，按 Plan 文档执行编码任务"
      >
        ⚡ 切换到 Agent 执行
      </button>
    </div>
  );
}
