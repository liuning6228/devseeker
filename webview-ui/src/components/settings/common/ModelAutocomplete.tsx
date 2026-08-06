import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface ModelAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ id: string; name: string }>;
  placeholder?: string;
}

/**
 * ModelAutocomplete — 模型名输入自动补全
 *
 * - 聚焦时展示当前 Provider 的全部可选模型（空输入也可见）
 * - 输入时模糊匹配过滤
 * - 支持自定义输入（不强制从列表选择）
 * - 外部 value 变化时自动同步输入框显示
 * - 下拉列表通过 React Portal 渲染到 body，避免被父级 overflow 裁剪
 */
export function ModelAutocomplete({ value, onChange, options, placeholder }: ModelAutocompleteProps) {
  const [focused, setFocused] = useState(false);
  const [input, setInput] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // 外部 value 变化时同步输入框（如 Provider 切换导致 model 重置）
  useEffect(() => {
    setInput(value);
  }, [value]);

  // 聚焦时计算下拉位置（fixed 定位，相对于 viewport）
  useEffect(() => {
    if (!focused || !inputRef.current) {
      setDropdownPos(null);
      return;
    }
    const update = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (rect) {
        setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
      }
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [focused, input]);

  // 聚焦时显示全部选项；输入时按关键字模糊匹配
  // 当输入与当前值完全相同时（用户刚聚焦，还没开始输入），也展示全部选项
  const filtered = (() => {
    if (!focused) return [];
    const isUnmodified = !input || input === value;
    const source = isUnmodified
      ? options
      : options.filter((o) =>
          o.id.toLowerCase().includes(input.toLowerCase()) ||
          o.name.toLowerCase().includes(input.toLowerCase()),
        );
    return source.slice(0, 20);
  })();

  const handleSelect = (id: string) => {
    setInput(id);
    onChange(id);
    setFocused(false);
  };

  return (
    <div className="relative space-y-1">
      <label className="text-xs text-vscode-fg/60">模型</label>
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          onChange(e.target.value);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 200)}
        placeholder={placeholder || '选择或输入模型名'}
        className="w-full px-3 py-2 text-sm rounded border bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border
                   focus:outline-none focus:ring-2 focus:ring-vscode-focus placeholder:text-vscode-fg/40"
      />
      {focused && filtered.length > 0 && dropdownPos && createPortal(
        <div
          className="rounded border border-vscode-input-border bg-vscode-bg shadow-lg max-h-48 overflow-y-auto"
          style={{
            position: 'fixed',
            zIndex: 1000,
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
          }}
        >
          {filtered.map((o) => (
            <button
              key={o.id}
              onMouseDown={() => handleSelect(o.id)}
              className="w-full px-3 py-2 text-sm text-left text-vscode-fg hover:bg-vscode-sidebar-bg cursor-pointer"
            >
              <div>{o.name}</div>
              <div className="text-xs text-vscode-fg/40">{o.id}</div>
            </button>
          ))}
        </div>,
        document.body,
      )}
      {/* 输入不匹配任何选项时提示可自由输入 */}
      {focused && filtered.length === 0 && options.length > 0 && input && dropdownPos && createPortal(
        <div
          className="rounded border border-vscode-input-border bg-vscode-bg shadow-lg px-3 py-2"
          style={{
            position: 'fixed',
            zIndex: 1000,
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
          }}
        >
          <div className="text-xs text-vscode-fg/50">
            无匹配项，将使用自定义输入: <code className="text-vscode-focus">{input}</code>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
