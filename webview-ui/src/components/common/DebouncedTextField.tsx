import React, { useState, useEffect, useRef } from 'react';
import { cn } from '../../lib/utils.js';

interface DebouncedTextFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  className?: string;
  type?: 'text' | 'password';
  disabled?: boolean;
}

/**
 * DebouncedTextField — 防抖文本输入框
 *
 * 用于 API Key / Base URL 等频繁输入但不希望每击键都写入的设置项。
 * 用户停止输入 debounceMs 毫秒后才触发 onChange。
 */
export function DebouncedTextField({
  value,
  onChange,
  placeholder,
  debounceMs = 500,
  className,
  type = 'text',
  disabled,
}: DebouncedTextFieldProps) {
  const [localValue, setLocalValue] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setLocalValue(newVal);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChange(newVal), debounceMs);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <input
      type={type}
      value={localValue}
      onChange={handleChange}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(
        'w-full px-3 py-2 text-sm rounded border',
        'bg-vscode-input-bg text-vscode-input-fg border-vscode-input-border',
        'focus:outline-none focus:ring-2 focus:ring-vscode-focus',
        'placeholder:text-vscode-fg/40',
        className,
      )}
    />
  );
}
