import React from 'react';
import { Search, FileCode, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface SearchResult {
  type: 'codebase' | 'web';
  relevance?: number;
  filePath?: string;
  title?: string;
  url?: string;
  snippet: string;
  lines?: string; // 行号范围
}

interface SearchResultsDisplayProps {
  results: SearchResult[];
  query?: string;
  onOpenFile?: (path: string, line?: number) => void;
  className?: string;
}

/**
 * SearchResultsDisplay — 搜索工具结果卡片
 *
 * 渲染 search_codebase / search_web 工具返回的结果为结构化卡片：
 * - 文件路径 + 行号（可点击跳转）
 * - 代码预览 + 相关度标记
 * - 折叠/展开长结果
 */
export function SearchResultsDisplay({
  results,
  query,
  onOpenFile,
  className,
}: SearchResultsDisplayProps) {
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set([0]));

  if (results.length === 0) return null;

  const toggleExpand = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div className={cn('rounded-lg border border-vscode-input-border overflow-hidden', className)}>
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 bg-vscode-sidebar-bg/50 border-b border-vscode-input-border">
        <Search className="h-4 w-4 text-vscode-fg/60" />
        <span className="text-sm font-medium text-vscode-fg">{results[0]?.type === 'codebase' ? '代码搜索' : '网络搜索'}</span>
        {query && <span className="text-xs text-vscode-fg/40">"{query}"</span>}
        <span className="text-xs text-vscode-fg/40 ml-auto">{results.length} 条结果</span>
      </div>

      {/* 结果列表 */}
      <div className="divide-y divide-vscode-input-border">
        {results.map((result, i) => (
          <div key={i}>
            <button
              onClick={() => toggleExpand(i)}
              className="w-full flex items-start gap-2 px-3 py-2 hover:bg-vscode-sidebar-bg/50 text-left cursor-pointer"
            >
              <div className="mt-0.5 shrink-0">
                {expanded.has(i) ? <ChevronDown className="h-3.5 w-3.5 text-vscode-fg/40" /> : <ChevronRight className="h-3.5 w-3.5 text-vscode-fg/40" />}
              </div>
              <div className="flex-1 min-w-0">
                {/* 标题行 */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-vscode-btn-bg font-mono truncate">
                    {result.filePath || result.title}
                  </span>
                  {result.lines && (
                    <span className="text-xs text-vscode-fg/40 shrink-0">· {result.lines}</span>
                  )}
                  {result.relevance !== undefined && (
                    <span className={cn(
                      'text-xs shrink-0',
                      result.relevance > 0.8 ? 'text-green-500' :
                      result.relevance > 0.5 ? 'text-yellow-500' : 'text-vscode-fg/40',
                    )}>
                      {(result.relevance * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                {/* 代码解析链接 */}
                {result.filePath && onOpenFile && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const lineMatch = result.lines?.match(/L(\d+)/);
                      onOpenFile(result.filePath!, lineMatch ? parseInt(lineMatch[1]) : undefined);
                    }}
                    className="text-xs text-vscode-fg/40 hover:text-vscode-btn-bg mt-0.5 cursor-pointer"
                  >
                    <FileCode className="h-3 w-3 inline mr-0.5" />
                    打开文件
                  </button>
                )}
                {result.url && (
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-vscode-fg/40 hover:text-vscode-btn-bg mt-0.5 inline-flex items-center gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="h-3 w-3" />
                    {result.url}
                  </a>
                )}
                {/* 片段 */}
                {expanded.has(i) && (
                  <pre className="mt-1 text-xs font-mono text-vscode-fg/70 overflow-x-auto bg-vscode-sidebar-bg/30 rounded p-2 border border-vscode-input-border">
                    {result.snippet}
                  </pre>
                )}
              </div>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
