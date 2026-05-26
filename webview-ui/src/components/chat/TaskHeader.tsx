import { cn } from '../../lib/utils.js';
import type { TodoItem } from '../../protocol';

interface TaskHeaderProps {
  /** 首条用户消息 */
  userMessage?: string;
  /** 是否正在执行任务 */
  isRunning?: boolean;
  /** 任务进度：Agent todo_write 维护的 todo 列表 */
  todoList?: TodoItem[];
  className?: string;
}

/**
 * TaskHeader — 当前会话顶部信息栏
 *
 * 展示：
 * 1. 会话标题 + 执行状态小圆点
 * 2. TASK 进度条（已执行 / 总任务数，基于 todoList）
 */
export function TaskHeader({
  userMessage,
  isRunning,
  todoList,
  className,
}: TaskHeaderProps) {
  // ── TASK 进度计算 ──
  const totalTasks = todoList?.length ?? 0;
  const doneTasks = todoList?.filter(
    (t) => t.status === 'COMPLETE' || t.status === 'CANCELLED',
  ).length ?? 0;
  const taskRatio = totalTasks > 0 ? (doneTasks / totalTasks) * 100 : 0;
  const showTaskProgress = totalTasks > 0;

  const taskBarColor =
    taskRatio >= 100 ? 'bg-blue-500' :
    isRunning ? 'bg-blue-400' :
    'bg-blue-300';

  return (
    <div className={cn(
      'border-b border-vscode-input-border bg-vscode-editor-background',
      className,
    )}>
      <div className="px-4 py-2 space-y-1.5">
        {/* 标题行 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <span className="text-sm font-medium text-vscode-fg truncate">
              {userMessage || '新会话'}
            </span>
            {isRunning && (
              <span className="inline-flex items-center shrink-0">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
