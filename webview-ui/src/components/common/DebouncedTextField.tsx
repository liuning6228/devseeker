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
  /** 是否正在编辑（聚焦中，或有未提交的防抖写入） */
  const editingRef = useRef(false);

  useEffect(() => {
    // 用户正在编辑时忽略外部回显：
    // 宿主每次写配置都会回推一次 model_config，若直接覆盖会把正在输入的内容
    // （或刚输入的 API Key）替换成旧值/掩码，表现为「输入到一半又变回去」。
    if (editingRef.current) return;
    setLocalValue(value);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setLocalValue(newVal);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onChange(newVal);
    }, debounceMs);
  };

  const handleFocus = () => {
    editingRef.current = true;
  };

  const handleBlur = () => {
    editingRef.current = false;
    // 失焦时立即提交未到期的防抖写入，避免用户切走后丢失最后一次输入
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      onChange(localValue);
    }
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
      onFocus={handleFocus}
      onBlur={handleBlur}
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
