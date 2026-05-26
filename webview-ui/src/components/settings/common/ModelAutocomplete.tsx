import React, { useState } from 'react';
import { cn } from '../../../lib/utils.js';

interface ModelAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ id: string; name: string }>;
  placeholder?: string;
}

/**
 * ModelAutocomplete — 模型名输入自动补全
 *
 * 输入时从预置列表模糊匹配，支持自定义输入。
 */
export function ModelAutocomplete({ value, onChange, options, placeholder }: ModelAutocompleteProps) {
  const [focused, setFocused] = useState(false);
  const [input, setInput] = useState(value);

  const filtered = input
    ? options.filter((o) =>
        o.id.toLowerCase().includes(input.toLowerCase()) ||
        o.name.toLowerCase().includes(input.toLowerCase())
      ).slice(0, 10)
    : [];

  const handleSelect = (id: string) => {
    setInput(id);
    onChange(id);
    setFocused(false);
  };

  return (
    <div className="relative space-y-1">
      <label className="text-xs text-vscode-fg/60">模型</label>
      <input
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
      {focused && filtered.length > 0 && (
        <div className="absolute z-10 w-full mt-1 rounded border border-vscode-input-border bg-vscode-bg shadow-lg max-h-48 overflow-y-auto">
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
        </div>
      )}
    </div>
  );
}
