import React from 'react';
import { cn } from '../../../lib/utils.js';
import { DebouncedTextField } from '../../common/DebouncedTextField.js';

interface BaseUrlFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function BaseUrlField({ value, onChange, placeholder, disabled }: BaseUrlFieldProps) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-vscode-fg/60">API 端点</label>
      <DebouncedTextField
        value={value}
        onChange={onChange}
        placeholder={placeholder || 'https://api.example.com/v1'}
        disabled={disabled}
      />
    </div>
  );
}
