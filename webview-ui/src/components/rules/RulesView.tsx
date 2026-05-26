import React, { useState } from 'react';
import { BookOpen, Plus, Trash2, ToggleLeft, ToggleRight, Eye } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { ViewHeader } from '../common/ViewHeader.js';
import { Button } from '../ui/button.js';
import { Switch } from '../ui/switch.js';
import { Separator } from '../ui/separator.js';
import { AlertDialog } from '../common/AlertDialog.js';

interface RuleItem {
  id: string;
  name: string;
  kind: 'model_decision' | 'always' | 'agent' | 'plan' | 'debug' | 'ask';
  enabled: boolean;
  filePath: string;
}

interface RulesViewProps {
  onBack?: () => void;
  className?: string;
}

const DEMO_RULES: RuleItem[] = [
  { id: '1', name: 'TypeScript coding style', kind: 'always', enabled: true, filePath: '.dualmind/rules/typescript-style.md' },
  { id: '2', name: 'React best practices', kind: 'model_decision', enabled: true, filePath: '.dualmind/rules/react-best-practices.md' },
  { id: '3', name: 'API design conventions', kind: 'agent', enabled: false, filePath: '.dualmind/rules/api-design.md' },
];

const KIND_LABELS: Record<string, string> = {
  always: '始终生效',
  model_decision: 'AI 决策',
  agent: 'Agent 模式',
  plan: 'Plan 模式',
  debug: 'Debug 模式',
  ask: 'Ask 模式',
};

export function RulesView({ onBack, className }: RulesViewProps) {
  const [rules, setRules] = useState(DEMO_RULES);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const handleToggle = (id: string) => {
    setRules((prev) => prev.map((r) => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  const handleDelete = (id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id));
    setDeleteId(null);
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <ViewHeader
        title="Rules 管理"
        onBack={onBack}
        actions={
          <Button size="sm" onClick={() => {}}>
            <Plus className="h-3.5 w-3.5" />
            新建规则
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {rules.length === 0 ? (
          <div className="text-sm text-vscode-fg/50 text-center py-8">
            暂无规则。点击「新建规则」创建。
          </div>
        ) : (
          rules.map((rule, i) => (
            <React.Fragment key={rule.id}>
              {i > 0 && <Separator />}
              <div className="flex items-center justify-between py-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-vscode-fg/40 shrink-0" />
                    <span className="text-sm text-vscode-fg truncate">{rule.name}</span>
                    <span className={cn(
                      'text-xs px-1.5 py-0.5 rounded',
                      rule.enabled ? 'bg-green-500/10 text-green-600' : 'bg-vscode-sidebar-bg text-vscode-fg/40',
                    )}>
                      {KIND_LABELS[rule.kind] || rule.kind}
                    </span>
                  </div>
                  <div className="text-xs text-vscode-fg/40 mt-0.5 truncate ml-6">{rule.filePath}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setPreviewId(rule.id)}
                    title="预览"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={() => handleToggle(rule.id)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleteId(rule.id)}
                    title="删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </React.Fragment>
          ))
        )}
      </div>

      <AlertDialog
        open={!!deleteId}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="删除规则"
        description="此操作不可撤销，确认删除？"
        confirmLabel="删除"
        destructive
        onConfirm={() => deleteId && handleDelete(deleteId)}
      />
    </div>
  );
}
