import React from 'react';
import { cn } from '../../../lib/utils.js';
import { DebouncedTextField } from '../../common/DebouncedTextField.js';

interface ApiKeyFieldProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function ApiKeyField({ value, onChange, disabled }: ApiKeyFieldProps) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-vscode-fg/60">API Key</label>
      <DebouncedTextField
        value={value}
        onChange={onChange}
        placeholder="sk-..."
        type="password"
        disabled={disabled}
      />
    </div>
  );
}
