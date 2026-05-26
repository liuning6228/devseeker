import React, { useState } from 'react';
import { GitBranch, Plus, Trash2, GitCommit, FileCode } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { ViewHeader } from '../common/ViewHeader.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog.js';
import { DebouncedTextField } from '../common/DebouncedTextField.js';

interface Worktree {
  id: string;
  name: string;
  path: string;
  branch: string;
  changesCount: number;
  lastCommit: string;
}

interface WorktreesViewProps {
  onBack?: () => void;
  className?: string;
}

const DEMO_WORKTREES: Worktree[] = [
  { id: '1', name: 'feature/new-ui', path: '../dualmind-new-ui', branch: 'feat/ui-phase-5b', changesCount: 12, lastCommit: 'feat: Navbar + Welcome' },
  { id: '2', name: 'hotfix/billing', path: '../dualmind-hotfix', branch: 'fix/billing-error', changesCount: 3, lastCommit: 'fix: billing insufficient notification' },
];

export function WorktreesView({ onBack, className }: WorktreesViewProps) {
  const [worktrees, setWorktrees] = useState(DEMO_WORKTREES);
  const [showCreate, setShowCreate] = useState(false);
  const [showDelete, setShowDelete] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newBranch, setNewBranch] = useState('');

  const handleCreate = () => {
    if (!newName) return;
    setWorktrees((prev) => [...prev, {
      id: `wt-${Date.now()}`,
      name: newName,
      path: `../${newName}`,
      branch: newBranch || 'main',
      changesCount: 0,
      lastCommit: '新建工作树',
    }]);
    setShowCreate(false);
    setNewName('');
    setNewBranch('');
  };

  const handleDelete = (id: string) => {
    setWorktrees((prev) => prev.filter((w) => w.id !== id));
    setShowDelete(null);
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <ViewHeader
        title="工作树"
        onBack={onBack}
        actions={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-3.5 w-3.5" />
            新建
          </Button>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {worktrees.length === 0 ? (
          <div className="text-sm text-vscode-fg/50 text-center py-8">
            暂无工作树。点击「新建」创建。
          </div>
        ) : (
          worktrees.map((wt) => (
            <div key={wt.id} className="rounded-lg border border-vscode-input-border overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-vscode-sidebar-bg/50">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <GitBranch className="h-4 w-4 text-vscode-btn-bg shrink-0" />
                  <span className="text-sm font-medium text-vscode-fg truncate">{wt.name}</span>
                  <span className="text-xs text-vscode-fg/40">({wt.branch})</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowDelete(wt.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除
                </Button>
              </div>
              <div className="px-3 py-2 text-xs text-vscode-fg/60 space-y-1">
                <div className="flex items-center gap-1">
                  <FileCode className="h-3 w-3" />
                  <span>{wt.path}</span>
                </div>
                <div className="flex items-center gap-1">
                  <GitCommit className="h-3 w-3" />
                  <span>{wt.lastCommit}</span>
                </div>
                <div>
                  变更：{wt.changesCount} 个文件
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 创建弹窗 */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建工作树</DialogTitle>
            <DialogDescription>创建一个新的 Git 工作树</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <DebouncedTextField
              value={newName}
              onChange={setNewName}
              placeholder="工作树名称（如：feature/new-ui）"
            />
            <DebouncedTextField
              value={newBranch}
              onChange={setNewBranch}
              placeholder="分支名称（可选，默认 main）"
            />
            <Button onClick={handleCreate} disabled={!newName}>创建</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={!!showDelete} onOpenChange={(o) => !o && setShowDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除工作树</DialogTitle>
            <DialogDescription>确定删除该工作树？此操作不会影响 Git 仓库。</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowDelete(null)}>取消</Button>
            <Button variant="destructive" onClick={() => showDelete && handleDelete(showDelete)}>删除</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
