import React from 'react';
import { Sparkles, Code2, Search, Bug } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import logoSvg from '../../assets/logo.svg';

interface QuickTask {
  id: string;
  icon: React.ReactNode;
  label: string;
  description: string;
  prompt: string;
}

const QUICK_TASKS: QuickTask[] = [
  {
    id: 'read-project',
    icon: <Code2 className="h-5 w-5" />,
    label: '了解项目',
    description: '读一下 package.json 和项目结构',
    prompt: '读一下 package.json，告诉我用了哪些依赖和技术栈',
  },
  {
    id: 'search-code',
    icon: <Search className="h-5 w-5" />,
    label: '搜索代码',
    description: '搜索特定函数或类的实现',
    prompt: '搜索项目中所有 API 路由的定义',
  },
  {
    id: 'fix-bug',
    icon: <Bug className="h-5 w-5" />,
    label: '排查问题',
    description: '分析错误日志找到原因',
    prompt: '帮我看看最近的错误日志，找出根本原因',
  },
];

interface WelcomeViewProps {
  onTaskSelect: (prompt: string) => void;
  recentSessions?: Array<{ id: string; title: string; updatedAt: number }>;
  onSessionSelect?: (id: string) => void;
  onBackToChat?: () => void;
  className?: string;
}

/**
 * WelcomeView — 欢迎首页
 *
 * Phase 5b 首页视图，展示：
 * - 品牌 + 版本号
 * - 快捷任务卡片（点击自动填入 Composer）
 * - 最近会话列表
 */
export function WelcomeView({ onTaskSelect, recentSessions, onSessionSelect, onBackToChat, className }: WelcomeViewProps) {
  return (
    <div className={cn('flex flex-col gap-6 p-6', className)}>
      {/* 品牌区域 */}
      <div className="text-center py-6 relative">
        <img src={logoSvg} alt="DevSeeker" className="w-24 h-24 mx-auto mb-4" />
        <h1 className="text-2xl font-bold text-vscode-fg">DevSeeker</h1>
        <p className="text-sm text-vscode-fg/60 mt-2">
          技术 leader 型 AI 编码助手
        </p>
        <p className="text-xs text-vscode-fg/40 mt-1">
          v2.5.0
        </p>
        {onBackToChat && (
          <button
            type="button"
            onClick={onBackToChat}
            className="mt-4 px-4 py-2 text-sm rounded-md border border-vscode-input-border
                       hover:border-vscode-btn-bg hover:bg-vscode-sidebar-bg/50 transition-colors cursor-pointer"
          >
            ← 回到对话
          </button>
        )}
      </div>

      {/* 快捷任务卡片 */}
      <div>
        <h2 className="text-sm font-medium text-vscode-fg mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-yellow-500" />
          快速开始
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {QUICK_TASKS.map((task) => (
            <button
              key={task.id}
              onClick={() => onTaskSelect(task.prompt)}
              className="flex flex-col items-start gap-2 p-4 rounded-lg border border-vscode-input-border
                         hover:border-vscode-btn-bg hover:bg-vscode-sidebar-bg/50 transition-colors text-left cursor-pointer"
            >
              <div className="p-2 rounded-md bg-vscode-sidebar-bg text-vscode-btn-bg">
                {task.icon}
              </div>
              <div>
                <div className="text-sm font-medium text-vscode-fg">{task.label}</div>
                <div className="text-xs text-vscode-fg/60 mt-0.5">{task.description}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 最近会话 */}
      {recentSessions && recentSessions.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-vscode-fg mb-3">最近会话</h2>
          <div className="space-y-1">
            {recentSessions.slice(0, 5).map((s) => (
              <button
                key={s.id}
                onClick={() => onSessionSelect?.(s.id)}
                className="w-full flex items-center justify-between px-3 py-2 rounded
                           hover:bg-vscode-sidebar-bg cursor-pointer text-left"
              >
                <span className="text-sm text-vscode-fg truncate">{s.title}</span>
                <span className="text-xs text-vscode-fg/40 shrink-0 ml-2">
                  {formatRelativeTime(s.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}
