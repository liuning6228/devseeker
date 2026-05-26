import React from 'react';
import { Image, Link as LinkIcon, FileJson } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { UnsafeImage } from '../../common/UnsafeImage.js';

interface McpImageResult {
  type: 'image';
  url: string;
  alt?: string;
}

interface McpLinkResult {
  type: 'link';
  url: string;
  title?: string;
  description?: string;
}

interface McpJsonResult {
  type: 'json';
  data: unknown;
}

type McpResultItem = McpImageResult | McpLinkResult | McpJsonResult;

interface McpResponseDisplayProps {
  results: McpResultItem[];
  className?: string;
}

/**
 * McpResponseDisplay — MCP 工具返回的富媒体结果展示
 *
 * 支持的格式：
 * - 图片 → 安全图片渲染（可缩放）
 * - 链接 → 链接卡片预览（标题 + 描述 + 图标）
 * - JSON → 可折叠 JSON 视图
 */
export function McpResponseDisplay({ results, className }: McpResponseDisplayProps) {
  if (results.length === 0) return null;

  return (
    <div className={cn('space-y-2', className)}>
      {results.map((item, i) => {
        switch (item.type) {
          case 'image':
            return (
              <div key={i} className="space-y-1">
                <div className="flex items-center gap-1 text-xs text-vscode-fg/50">
                  <Image className="h-3 w-3" />
                  MCP 图片结果
                </div>
                <UnsafeImage src={item.url} alt={item.alt} maxWidth={400} />
              </div>
            );

          case 'link':
            return (
              <a
                key={i}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-3 p-3 rounded-lg border border-vscode-input-border
                           hover:bg-vscode-sidebar-bg/50 transition-colors"
              >
                <LinkIcon className="h-5 w-5 text-vscode-btn-bg mt-0.5 shrink-0" />
                <div className="min-w-0">
                  {item.title && <div className="text-sm font-medium text-vscode-fg truncate">{item.title}</div>}
                  {item.description && <div className="text-xs text-vscode-fg/60 mt-0.5">{item.description}</div>}
                  <div className="text-xs text-vscode-fg/40 mt-0.5 truncate">{item.url}</div>
                </div>
              </a>
            );

          case 'json':
            return (
              <details key={i} className="rounded-lg border border-vscode-input-border overflow-hidden">
                <summary className="flex items-center gap-2 px-3 py-2 text-xs text-vscode-fg/60 bg-vscode-sidebar-bg/50 cursor-pointer">
                  <FileJson className="h-3.5 w-3.5" />
                  MCP 结构化数据
                </summary>
                <pre className="px-3 py-2 text-xs font-mono text-vscode-fg/70 overflow-x-auto">
                  {JSON.stringify(item.data, null, 2)}
                </pre>
              </details>
            );
        }
      })}
    </div>
  );
}
