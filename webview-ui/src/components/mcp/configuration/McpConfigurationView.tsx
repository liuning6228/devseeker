import React, { useState } from 'react';
import { Globe, Terminal, Plus, RefreshCw } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { ViewHeader } from '../../common/ViewHeader.js';
import { Tab } from '../../common/Tab.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/dialog.js';
import { DebouncedTextField } from '../../common/DebouncedTextField.js';
import { Separator } from '../../ui/separator.js';

interface McpServer {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error';
  type: 'local' | 'remote';
  command?: string;
  url?: string;
  toolsCount: number;
  resourcesCount: number;
}

interface McpConfigurationViewProps {
  onBack?: () => void;
  className?: string;
  onTestConnection?: (url: string) => void;
}

const MCP_TABS = [
  { id: 'installed', label: '已安装' },
  { id: 'add', label: '添加 Server' },
];

const DEMO_SERVERS: McpServer[] = [
  { id: '1', name: 'filesystem', status: 'running', type: 'local', command: 'npx -y @modelcontextprotocol/server-filesystem', toolsCount: 5, resourcesCount: 2 },
  { id: '2', name: 'github', status: 'error', type: 'remote', url: 'https://api.github.com/mcp', toolsCount: 0, resourcesCount: 0 },
];

export function McpConfigurationView({ onBack, className }: McpConfigurationViewProps) {
  const [activeTab, setActiveTab] = useState('installed');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addType, setAddType] = useState<'local' | 'remote'>('local');
  const [servers, setServers] = useState(DEMO_SERVERS);

  // 添加 Local Server
  const [localCommand, setLocalCommand] = useState('');
  const [localName, setLocalName] = useState('');

  // 添加 Remote Server
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteKey, setRemoteKey] = useState('');

  const handleAddServer = () => {
    if (addType === 'local' && localCommand) {
      setServers((prev) => [...prev, {
        id: `s-${Date.now()}`,
        name: localName || `mcp-${servers.length + 1}`,
        status: 'running',
        type: 'local',
        command: localCommand,
        toolsCount: 0,
        resourcesCount: 0,
      }]);
    } else if (addType === 'remote' && remoteUrl) {
      setServers((prev) => [...prev, {
        id: `s-${Date.now()}`,
        name: `remote-${servers.length + 1}`,
        status: 'running',
        type: 'remote',
        url: remoteUrl,
        toolsCount: 0,
        resourcesCount: 0,
      }]);
    }
    setShowAddDialog(false);
    setLocalCommand('');
    setLocalName('');
    setRemoteUrl('');
    setRemoteKey('');
  };

  const handleDeleteServer = (id: string) => {
    setServers((prev) => prev.filter((s) => s.id !== id));
  };

  const handleToggleServer = (id: string) => {
    setServers((prev) =>
      prev.map((s) =>
        s.id === id
          ? { ...s, status: s.status === 'running' ? 'stopped' : 'running' as const }
          : s,
      ),
    );
  };

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <ViewHeader title="MCP 配置" onBack={onBack} actions={
        <Button size="sm" onClick={() => setShowAddDialog(true)}>
          <Plus className="h-3.5 w-3.5" />
          添加 Server
        </Button>
      } />
      <Tab tabs={MCP_TABS} activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="flex-1 overflow-y-auto p-4">
        {/* 已安装标签 */}
        {activeTab === 'installed' && (
          <div className="space-y-3">
            {servers.length === 0 ? (
              <div className="text-sm text-vscode-fg/50 text-center py-8">
                暂无已安装的 MCP Server。点击右上角「添加 Server」按钮配置。
              </div>
            ) : (
              servers.map((server) => (
                <div key={server.id} className="rounded-lg border border-vscode-input-border overflow-hidden">
                  {/* Server 头部 */}
                  <div className="flex items-center justify-between px-3 py-2 bg-vscode-sidebar-bg/50">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={cn(
                        'inline-block w-2 h-2 rounded-full shrink-0',
                        server.status === 'running' ? 'bg-green-500' :
                        server.status === 'error' ? 'bg-red-500' : 'bg-yellow-500',
                      )} />
                      <span className="text-sm font-medium text-vscode-fg truncate">{server.name}</span>
                      <span className="text-xs text-vscode-fg/40">
                        {server.type === 'local' ? '🖥️ Stdio' : '🌐 Remote'}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleToggleServer(server.id)}
                      >
                        {server.status === 'running' ? '停止' : '启动'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteServer(server.id)}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                  {/* Server 详情 */}
                  <div className="px-3 py-2 text-xs text-vscode-fg/60 space-y-1">
                    {server.command && (
                      <div><span className="text-vscode-fg/40">命令：</span><code className="font-mono">{server.command}</code></div>
                    )}
                    {server.url && (
                      <div><span className="text-vscode-fg/40">URL：</span><code className="font-mono">{server.url}</code></div>
                    )}
                    <div className="flex gap-3 mt-1">
                      <span>工具：{server.toolsCount}</span>
                      <span>资源：{server.resourcesCount}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* 添加 Server 标签 */}
        {activeTab === 'add' && (
          <div className="max-w-md mx-auto space-y-6">
            {/* Local Server */}
            <div className="p-4 rounded-lg border border-vscode-input-border">
              <div className="flex items-center gap-2 mb-3">
                <Terminal className="h-5 w-5 text-vscode-btn-bg" />
                <h3 className="text-sm font-medium text-vscode-fg">Local Server（Stdio）</h3>
              </div>
              <div className="space-y-3">
                <DebouncedTextField
                  value={localName}
                  onChange={setLocalName}
                  placeholder="Server 名称（可选）"
                />
                <DebouncedTextField
                  value={localCommand}
                  onChange={setLocalCommand}
                  placeholder="启动命令，如：npx -y @modelcontextprotocol/server-filesystem"
                />
                <Button size="sm" disabled={!localCommand} onClick={() => {
                  setAddType('local');
                  handleAddServer();
                }}>
                  <Plus className="h-3.5 w-3.5" />
                  添加
                </Button>
              </div>
            </div>

            {/* Remote Server */}
            <div className="p-4 rounded-lg border border-vscode-input-border">
              <div className="flex items-center gap-2 mb-3">
                <Globe className="h-5 w-5 text-vscode-btn-bg" />
                <h3 className="text-sm font-medium text-vscode-fg">Remote Server（URL）</h3>
              </div>
              <div className="space-y-3">
                <DebouncedTextField
                  value={remoteUrl}
                  onChange={setRemoteUrl}
                  placeholder="Server URL，如：https://api.example.com/mcp"
                />
                <DebouncedTextField
                  value={remoteKey}
                  onChange={setRemoteKey}
                  placeholder="API Key（可选）"
                  type="password"
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={!remoteUrl} onClick={() => {
                    setAddType('remote');
                    handleAddServer();
                  }}>
                    <Plus className="h-3.5 w-3.5" />
                    添加
                  </Button>
                  {remoteUrl && (
                    <Button size="sm" variant="outline" onClick={() => {}}>
                      <RefreshCw className="h-3.5 w-3.5" />
                      测试连接
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
