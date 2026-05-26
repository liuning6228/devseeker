/**
 * W9.14 · Markdown 渲染器 React 组件（DESIGN §M11.8）
 *
 * - 使用 extension 侧 `@core/markdown` 的纯 TS 解析器
 * - file:/// 链接点击 → 发消息给 extension 要求 openFile
 * - Mermaid 暂不在 webview 打包 mermaid.js（留给 W12.2）；渲染为带标注的 pre 块
 * - 代码块含行号前缀时，左侧灰色展示行号列
 */

import { useMemo } from 'react';
import { parseMarkdown, stripLineNumberPrefix, isSafeHref, type MdNode } from '@core/markdown';

export interface MarkdownRendererProps {
  text: string;
  /** 点击 file:/// 链接时的回调（由 App 注入，通常发送 vscode.postMessage） */
  onOpenFile?: (req: { path: string; lineStart?: number; lineEnd?: number }) => void;
}

export function MarkdownRenderer({ text, onOpenFile }: MarkdownRendererProps): JSX.Element {
  const nodes = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="markdown">
      {nodes.map((n, i) => (
        <NodeRenderer key={i} node={n} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

function NodeRenderer({
  node,
  onOpenFile,
}: {
  node: MdNode;
  onOpenFile?: MarkdownRendererProps['onOpenFile'];
}): JSX.Element {
  switch (node.type) {
    case 'text':
      return <>{node.value}</>;
    case 'paragraph':
      return (
        <p className="md-p">
          {node.children.map((c, i) => (
            <NodeRenderer key={i} node={c} onOpenFile={onOpenFile} />
          ))}
        </p>
      );
    case 'code_block':
      return <CodeBlock lang={node.lang} code={node.code} hasLineNumbers={node.hasLineNumbers} />;
    case 'mermaid':
      return (
        <pre className="md-mermaid" data-mermaid>
          <code>{node.code}</code>
        </pre>
      );
    case 'inline_code':
      return <code className="md-inline-code">{node.code}</code>;
    case 'bold':
      return (
        <strong>
          {node.children.map((c, i) => (
            <NodeRenderer key={i} node={c} onOpenFile={onOpenFile} />
          ))}
        </strong>
      );
    case 'italic':
      return (
        <em>
          {node.children.map((c, i) => (
            <NodeRenderer key={i} node={c} onOpenFile={onOpenFile} />
          ))}
        </em>
      );
    case 'file_link':
      return (
        <a
          href={node.href}
          className="md-file-link"
          onClick={(e) => {
            e.preventDefault();
            onOpenFile?.({
              path: node.path,
              ...(node.lineStart !== undefined ? { lineStart: node.lineStart } : {}),
              ...(node.lineEnd !== undefined ? { lineEnd: node.lineEnd } : {}),
            });
          }}
          title={
            node.lineStart !== undefined
              ? `${node.path} (L${node.lineStart}${node.lineEnd && node.lineEnd !== node.lineStart ? `-L${node.lineEnd}` : ''})`
              : node.path
          }
        >
          {node.label}
        </a>
      );
    case 'image':
      return <img className="md-image" src={node.src} alt={node.alt || node.src} loading="lazy" />;
    case 'link':
      if (!isSafeHref(node.href)) {
        return <span className="md-blocked-link">{node.label}</span>;
      }
      return (
        <a href={node.href} className="md-link" target="_blank" rel="noreferrer noopener">
          {node.label}
        </a>
      );
    // ── W9.14 新增 ──
    case 'heading': {
      const H = `h${node.level}` as keyof JSX.IntrinsicElements;
      return (
        <H className={`md-h md-h${node.level}`}>
          {node.children.map((c, i) => (
            <NodeRenderer key={i} node={c} onOpenFile={onOpenFile} />
          ))}
        </H>
      );
    }
    case 'list': {
      const ListTag = node.ordered ? 'ol' : 'ul';
      return (
        <ListTag className={`md-list md-list--${node.ordered ? 'ordered' : 'unordered'}`}>
          {node.items.map((item, i) => (
            <li key={i} className="md-list-item">
              {item.map((c, j) => (
                <NodeRenderer key={j} node={c} onOpenFile={onOpenFile} />
              ))}
            </li>
          ))}
        </ListTag>
      );
    }
    case 'table': {
      const { headers, rows } = node;
      return (
        <div className="md-table-wrapper">
          <table className="md-table">
            {headers.length > 0 && (
              <thead>
                {headers.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <th key={ci}>
                        {cell.map((c, j) => (
                          <NodeRenderer key={j} node={c} onOpenFile={onOpenFile} />
                        ))}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
            )}
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci}>
                      {cell.map((c, j) => (
                        <NodeRenderer key={j} node={c} onOpenFile={onOpenFile} />
                      ))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'blockquote':
      return (
        <blockquote className="md-blockquote">
          {node.children.map((c, i) => (
            <NodeRenderer key={i} node={c} onOpenFile={onOpenFile} />
          ))}
        </blockquote>
      );
    case 'thematic_break':
      return <hr className="md-hr" />;
  }
}

function CodeBlock({
  lang,
  code,
  hasLineNumbers,
}: {
  lang: string;
  code: string;
  hasLineNumbers: boolean;
}): JSX.Element {
  const { stripped, lineNumbers } = hasLineNumbers
    ? stripLineNumberPrefix(code)
    : { stripped: code, lineNumbers: [] as Array<number | undefined> };
  const displayLines = stripped.split(/\r?\n/);
  const onCopy = () => {
    try {
      void navigator.clipboard?.writeText(stripped);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="md-code-block" data-lang={lang || 'text'}>
      <div className="md-code-block__header">
        <span className="md-code-block__lang">{lang || 'text'}</span>
        <button className="md-code-block__copy" type="button" onClick={onCopy}>
          Copy
        </button>
      </div>
      <pre className="md-code-block__pre">
        <code>
          {displayLines.map((line, i) => {
            const lineNo = lineNumbers[i];
            return (
              <span key={i} className="md-code-line">
                {lineNo !== undefined && <span className="md-code-lineno">{lineNo}</span>}
                <span className="md-code-content">{line}</span>
                {i < displayLines.length - 1 ? '\n' : ''}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
