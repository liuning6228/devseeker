import React, { useMemo } from 'react';
import { cn } from '../../lib/utils.js';
import { CopyButton } from './CopyButton.js';

/**
 * 从文件路径推断语言标签
 */
function inferLanguage(filePath?: string): string {
  if (!filePath) return '';
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby',
    vue: 'vue', svelte: 'svelte', css: 'css', scss: 'scss', less: 'less',
    html: 'html', hbs: 'handlebars', json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', xml: 'xml', sql: 'sql', sh: 'bash', bash: 'bash',
    dockerfile: 'dockerfile', tf: 'terraform', toml: 'toml',
  };
  return langMap[ext ?? ''] ?? ext ?? '';
}

interface MarkdownBlockProps {
  /** 代码块内容（纯代码文本，不含```围栏） */
  code: string;
  /** 可选的语法语言 */
  language?: string;
  /** 可选的文件路径（用于推断语言） */
  filePath?: string;
  /** 是否显示行号 */
  showLineNumbers?: boolean;
  className?: string;
}

/**
 * MarkdownBlock — 代码块渲染
 *
 * 支持：
 * - 语法高亮（通过简单的关键词着色，实际使用可替换为 rehype-highlight）
 * - 行号显示
 * - 复制按钮
 * - 语言标签
 */
export function MarkdownBlock({
  code,
  language: langProp,
  filePath,
  showLineNumbers = true,
  className,
}: MarkdownBlockProps) {
  const language = langProp || inferLanguage(filePath);
  const lines = useMemo(() => code.split('\n'), [code]);

  return (
    <div className={cn('rounded-lg border border-vscode-input-border overflow-hidden text-sm', className)}>
      {/* 头部：语言标签 + 复制按钮 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-vscode-sidebar-bg border-b border-vscode-input-border">
        <div className="flex items-center gap-2">
          {language && (
            <span className="text-xs font-mono text-vscode-fg/50 uppercase">{language}</span>
          )}
          <span className="text-xs text-vscode-fg/40">{lines.length} 行</span>
        </div>
        <CopyButton text={code} />
      </div>
      {/* 代码内容 */}
      <pre className="overflow-x-auto p-0">
        <code className="block text-xs font-mono leading-5">
          {lines.map((line, i) => (
            <div key={i} className="flex hover:bg-vscode-sidebar-bg/50">
              {showLineNumbers && (
                <span className="select-none text-right px-3 text-vscode-fg/30 w-[3em] shrink-0 border-r border-vscode-input-border mr-3">
                  {i + 1}
                </span>
              )}
              <span className="flex-1 min-w-0">{renderHighlightedLine(line, language)}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

/** 简单的关键词着色（替代 rehype-highlight 的轻量版） */
function renderHighlightedLine(line: string, language: string): React.ReactNode {
  // 注释着色
  const commentMatch = line.match(/^(\s*)(\/\/.*$)/);
  if (commentMatch) {
    return (
      <>
        <span>{commentMatch[1]}</span>
        <span className="text-green-600/70 dark:text-green-400/70">{commentMatch[2]}</span>
      </>
    );
  }

  // 字符串着色
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const stringRegex = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let match: RegExpExecArray | null;

  while ((match = stringRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={`t${lastIndex}`}>{line.slice(lastIndex, match.index)}</span>);
    }
    parts.push(
      <span key={`s${match.index}`} className="text-orange-600/80 dark:text-orange-400/80">
        {match[1]}
      </span>,
    );
    lastIndex = match.index + match[1].length;
  }
  if (lastIndex < line.length) {
    parts.push(<span key={`e${lastIndex}`}>{line.slice(lastIndex)}</span>);
  }
  return <>{parts}</>;
}
