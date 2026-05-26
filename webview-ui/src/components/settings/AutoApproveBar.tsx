import React, { useState } from 'react';
import { Shield, ShieldCheck, ShieldAlert, Settings2 } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Switch } from '../ui/switch.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Separator } from '../ui/separator.js';

interface AutoApproveRule {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

const DEFAULT_RULES: AutoApproveRule[] = [
  { id: 'read_only', label: '只读工具', description: 'read_file / search_codebase / lsp 等', enabled: true },
  { id: 'workspace_write', label: '工作区写工具', description: 'write_file / search_replace / append_file', enabled: false },
  { id: 'bash_read', label: 'Bash（只读命令）', description: 'ls / cat / grep / find 等', enabled: false },
  { id: 'bash_write', label: 'Bash（写命令）', description: 'rm / mv / chmod / npm install 等', enabled: false },
  { id: 'network', label: '网络工具', description: 'search_web / fetch_content', enabled: true },
];

/**
 * AutoApproveBar — 工具自动审批策略配置
 *
 * 在 Settings 页面中展示，支持按安全级别单独配置。
 * 与 .dualmind/approval-policy.yaml 联动。
 */
export function AutoApproveBar() {
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [showModal, setShowModal] = useState(false);

  const toggleRule = (id: string) => {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    );
  };

  const enabledCount = rules.filter((r) => r.enabled).length;

  return (
    <>
      {/* Compact 状态条 */}
      <div className="flex items-center justify-between p-3 rounded-lg border border-vscode-input-border">
        <div className="flex items-center gap-2">
          {enabledCount === rules.length ? (
            <ShieldCheck className="h-4 w-4 text-green-500" />
          ) : enabledCount === 0 ? (
            <ShieldAlert className="h-4 w-4 text-red-500" />
          ) : (
            <Shield className="h-4 w-4 text-yellow-500" />
          )}
          <span className="text-sm text-vscode-fg">
            自动审批：{enabledCount}/{rules.length} 项已启用
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowModal(true)}>
          <Settings2 className="h-3.5 w-3.5" />
          详细配置
        </Button>
      </div>

      {/* 详细配置弹窗 */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>自动审批配置</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {rules.map((rule, i) => (
              <React.Fragment key={rule.id}>
                {i > 0 && <Separator />}
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-vscode-fg">{rule.label}</div>
                    <div className="text-xs text-vscode-fg/50">{rule.description}</div>
                  </div>
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={() => toggleRule(rule.id)}
                  />
                </div>
              </React.Fragment>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
