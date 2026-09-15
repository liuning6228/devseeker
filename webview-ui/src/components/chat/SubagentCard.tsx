import React from 'react';
import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { fmtDuration, fmtEta } from '../../utils/duration.js';
import type { SubagentState, SubagentStep } from '../../state/reducer';

interface SubagentCardProps {
  /** 子代理过程状态（reducer 由 subagent_event 累积） */
  state: SubagentState;
  className?: string;
}

/** 展开时最多展示的步骤数（更早的折叠为一行提示），避免长任务堆屏 */
const MAX_VISIBLE_STEPS = 20;

function StepIcon({ status }: { status: SubagentStep['status'] }): JSX.Element {
  if (status === 'done') return <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />;
  if (status === 'error') return <XCircle className="h-3 w-3 text-red-500 shrink-0" />;
  if (status === 'running') return <Loader2 className="h-3 w-3 text-blue-500 animate-spin shrink-0" />;
  return <Circle className="h-3 w-3 text-vscode-fg/30 shrink-0" />;
}

/**
 * SubagentCard — 子代理执行过程卡片
 *
 * 展示 Agent 工具派生的子代理的实时过程：工具步骤列表 + 正文尾部 + 终态摘要。
 * 数据来自 `subagent_event`（Agent 工具事件桥），仅 UI 旁路，不进 LLM 上下文。
 */
export function SubagentCard({ state, className }: SubagentCardProps): JSX.Element {
  const isRunning = state.status === 'running';
  const [expanded, setExpanded] = React.useState(isRunning);

  // 运行中展开看过程；终态自动折叠为摘要行
  const prevRunningRef = React.useRef(isRunning);
  React.useEffect(() => {
    if (prevRunningRef.current !== isRunning) {
      setExpanded(isRunning);
      prevRunningRef.current = isRunning;
    }
  }, [isRunning]);

  const visibleSteps = state.steps.length > MAX_VISIBLE_STEPS
    ? state.steps.slice(state.steps.length - MAX_VISIBLE_STEPS)
    : state.steps;
  const hiddenCount = state.steps.length - visibleSteps.length;

  // 1s ticker：运行中刷新「已用时 / ETA / 进行中步骤耗时」
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  // ── 时间指标：已用时（运行中）/ 总耗时（终态）──
  const elapsedMs = isRunning
    ? (state.startTime !== undefined ? Math.max(0, now - state.startTime) : undefined)
    : state.durationMs;

  // ETA：按「已完成步骤的墙钟平均耗时 × 剩余预算步数」估算。
  // 用墙钟而非步骤耗时之和：LLM 每回合思考/生成时间常占大头，只累加工具耗时会系统性低估。
  // 需 ≥1 个已完成步骤、已知预算、且已运行 ≥3s（避开早期抖动）。
  const completedSteps = state.steps.filter((s) => s.status !== 'running').length;
  const wallPerStepMs = completedSteps > 0 && elapsedMs !== undefined
    ? elapsedMs / completedSteps
    : undefined;
  const remainingBudget = state.maxTurns !== undefined
    ? Math.max(0, state.maxTurns - state.steps.length)
    : undefined;
  const etaMs = isRunning
    && wallPerStepMs !== undefined
    && remainingBudget !== undefined
    && remainingBudget > 0
    && elapsedMs !== undefined
    && elapsedMs >= 3000
    ? wallPerStepMs * remainingBudget
    : undefined;

  const lastStep = state.steps[state.steps.length - 1];
  const collapsedLine = isRunning
    ? (lastStep ? `→ ${lastStep.name}` : state.description)
    : (state.summary || state.description).split('\n')[0];

  // 运行中看流式尾部；完成/失败看最终摘要（更完整）
  const bodyText = isRunning ? state.textTail : (state.summary || state.textTail);

  return (
    <div
      className={cn(
        'subagent-card rounded-lg border overflow-hidden',
        isRunning ? 'border-blue-500/30 bg-blue-500/5' : 'border-vscode-input-border',
        className,
      )}
    >
      {/* 头部（点击折叠/展开） */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-2 w-full px-3 py-2 text-left cursor-pointer"
      >
        <span className={cn('p-1 rounded shrink-0', isRunning ? 'bg-blue-500/10' : 'bg-vscode-sidebar-bg')}>
          {isRunning
            ? <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
            : state.status === 'done'
              ? <CheckCircle2 className="h-4 w-4 text-green-500" />
              : <XCircle className="h-4 w-4 text-red-500" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-sm font-medium text-vscode-fg truncate block">
            {state.agentType}
            {isRunning ? ' 执行中...' : state.status === 'done' ? ' 已完成' : ' 失败'}
          </span>
          {!expanded && collapsedLine && (
            <span className="text-xs text-vscode-fg/60 truncate block">{collapsedLine}</span>
          )}
        </span>
        {elapsedMs !== undefined && (
          <span
            className="text-xs text-vscode-fg/40 shrink-0 font-mono"
            title={isRunning ? '已用时' : '总耗时'}
          >
            ⏱ {fmtDuration(elapsedMs)}
          </span>
        )}
        {etaMs !== undefined && (
          <span
            className="text-xs text-vscode-fg/40 shrink-0 font-mono"
            title={`按已完成 ${completedSteps} 步的平均耗时 × 剩余预算 ${remainingBudget ?? 0} 步估算（预算为 maxTurns 回合上界）`}
          >
            预计 ~{fmtEta(etaMs)}
          </span>
        )}
        {state.steps.length > 0 && (
          <span className="text-xs text-vscode-fg/40 shrink-0">
            {state.toolCalls || state.steps.length}{state.maxTurns ? `/${state.maxTurns}` : ''} 步
          </span>
        )}
        <svg
          className={cn('w-3 h-3 text-vscode-fg/40 transition-transform shrink-0', expanded && 'rotate-180')}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {/* 步数预算进度条（仅运行中且已知预算时展示） */}
      {isRunning && state.maxTurns !== undefined && state.maxTurns > 0 && (
        <div className="h-0.5 w-full bg-vscode-input-border/40">
          <div
            className="h-full bg-blue-500/60 transition-all duration-500"
            style={{ width: `${Math.min(100, Math.round((state.steps.length / state.maxTurns) * 100))}%` }}
          />
        </div>
      )}

      {/* 展开详情：步骤列表 + 正文 */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1 border-t border-vscode-input-border pt-2">
          {hiddenCount > 0 && (
            <div className="text-xs text-vscode-fg/40">… 更早 {hiddenCount} 步已省略</div>
          )}
          {visibleSteps.map((step) => (
            <div key={step.toolId} className="flex items-center gap-2 text-xs">
              <StepIcon status={step.status} />
              <span className={cn('font-mono text-vscode-fg/70 truncate', step.status === 'error' && 'text-red-500')}>
                {step.name}
              </span>
              <span className="ml-auto shrink-0 font-mono text-vscode-fg/40">
                {step.status === 'running'
                  ? (step.startTime !== undefined ? fmtDuration(Math.max(0, now - step.startTime)) : '')
                  : (step.durationMs !== undefined ? fmtDuration(step.durationMs) : '')}
              </span>
            </div>
          ))}
          {bodyText.trim().length > 0 && (
            <pre className="subagent-card__text mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-vscode-fg/70 font-mono">
              {isRunning ? bodyText : bodyText.trim()}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
