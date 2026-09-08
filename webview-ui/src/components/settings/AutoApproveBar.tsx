import React, { useEffect, useState } from 'react';
import { Shield, ShieldCheck, ShieldAlert, Settings2 } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { Switch } from '../ui/switch.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Separator } from '../ui/separator.js';
import { postToHost } from '../../vscode-api.js';
import type { ApprovalPolicyConfigPayload } from '../../protocol.js';

interface AutoApproveRule {
  id: 'read_only' | 'workspace_write' | 'bash_read' | 'bash_write' | 'network';
  label: string;
  description: string;
  enabled: boolean;
}

const DEFAULT_RULES: AutoApproveRule[] = [
  { id: 'read_only', label: '只读工具', description: 'read_file / search_codebase / lsp 等', enabled: true },
  { id: 'workspace_write', label: '工作区写工具', description: 'write_file / search_replace / append_file', enabled: true },
  { id: 'bash_read', label: 'Bash（只读命令）', description: 'ls / cat / grep / find 等', enabled: false },
  { id: 'bash_write', label: 'Bash（写命令）', description: 'rm / mv / chmod / npm install 等', enabled: false },
  { id: 'network', label: '网络工具', description: 'search_web / fetch_content', enabled: true },
];

/**
 * AutoApproveBar — 工具自动审批策略配置
 *
 * 数据源为 Extension Host 推送的 approval_policy_config（默认表 + bash 命令级规则），
 * 开关变更即写 .devseeker/approval-policy.yaml（update_approval_policy），宿主写盘后回推同步。
 */
export function AutoApproveBar({ config }: { config?: ApprovalPolicyConfigPayload | null }) {
  const [rules, setRules] = useState<AutoApproveRule[]>(DEFAULT_RULES);
  const [showModal, setShowModal] = useState(false);

  // 宿主推送/写盘回推 → 同步本地开关状态（含外部手工编辑 yaml 后的最新值）
  useEffect(() => {
    if (!config) return;
    const decisionOn = (d: 'auto' | 'confirm' | 'deny') => d === 'auto';
    setRules((prev) =>
      prev.map((r) => {
        switch (r.id) {
          case 'read_only':
            return { ...r, enabled: decisionOn(config.defaults.read_only) };
          case 'workspace_write':
            return { ...r, enabled: decisionOn(config.defaults.workspace_write) };
          case 'network':
            return { ...r, enabled: decisionOn(config.defaults.network) };
          case 'bash_read':
            return { ...r, enabled: config.bashRead };
          case 'bash_write':
            return { ...r, enabled: config.bashWrite };
          default:
            return r;
        }
      }),
    );
  }, [config]);

  // 开关变更：本地乐观更新 + 即改即写（单次点击只携带变更字段）
  const toggleRule = (id: AutoApproveRule['id']) => {
    const current = rules.find((r) => r.id === id);
    if (!current) return;
    const next = !current.enabled;
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: next } : r)));
    const values: {
      read_only?: 'auto' | 'confirm';
      workspace_write?: 'auto' | 'confirm';
      network?: 'auto' | 'confirm';
      bash_read?: boolean;
      bash_write?: boolean;
    } = {};
    if (id === 'read_only') values.read_only = next ? 'auto' : 'confirm';
    if (id === 'workspace_write') values.workspace_write = next ? 'auto' : 'confirm';
    if (id === 'network') values.network = next ? 'auto' : 'confirm';
    if (id === 'bash_read') values.bash_read = next;
    if (id === 'bash_write') values.bash_write = next;
    postToHost({ type: 'update_approval_policy', values });
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
          {!config && (
            <span className="text-xs text-vscode-fg/40">（等待宿主策略…）</span>
          )}
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
          <p className={cn('text-xs text-vscode-fg/40')}>
            修改立即写入 .devseeker/approval-policy.yaml 并在下一个任务生效；黑名单与 has_risk 硬规则不受影响。
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}