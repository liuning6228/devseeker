import React from 'react';
import { cn } from '../../../lib/utils.js';
import { DebouncedTextField } from '../../common/DebouncedTextField.js';

interface ApiKeyFieldProps {
  /**
   * 用户正在输入的新 Key（明文）。
   * 宿主出于安全只回传 apiKeySet 布尔值、不回传明文，因此已保存但未编辑时此值为空字符串。
   */
  value: string;
  onChange: (value: string) => void;
  /** 宿主是否已保存该 Key */
  isSet?: boolean;
  /** 清除已保存的 Key（含备用 Key 池） */
  onClear?: () => void;
  disabled?: boolean;
}

/**
 * ApiKeyField — API Key 输入框
 *
 * 不用掩码字符（••••）充当输入框的值：那样用户删掉部分圆点后无法判断意图
 * （是想清空还是想改？），也容易把掩码字符本身写进配置。
 * 改为「输入框只承载新输入 + placeholder 提示已保存 + 独立清除按钮」，意图始终明确。
 */
export function ApiKeyField({ value, onChange, isSet, onClear, disabled }: ApiKeyFieldProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs text-vscode-fg/60">API Key</label>
        {isSet && onClear && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="text-xs text-vscode-fg/50 underline cursor-pointer hover:text-red-500"
          >
            清除
          </button>
        )}
      </div>
      <DebouncedTextField
        value={value}
        onChange={onChange}
        placeholder={isSet ? '已保存 ••••••••（输入新值可覆盖）' : 'sk-...'}
        type="password"
        disabled={disabled}
      />
      {isSet && !value && (
        <p className={cn('text-xs text-green-600/80')}>✓ 已配置</p>
      )}
    </div>
  );
}
