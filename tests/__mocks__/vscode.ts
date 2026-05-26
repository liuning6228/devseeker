/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * vscode 模块最小 stub，仅供单测使用。
 */
export const ExtensionMode = {
  Production: 1,
  Development: 2,
  Test: 3,
} as const;

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
} as const;

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;

export const window = {
  createStatusBarItem: () => ({
    text: '',
    command: '',
    tooltip: '' as unknown,
    backgroundColor: undefined as unknown,
    name: '',
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
  }),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showTextDocument: async () => undefined,
  createTreeView: <T>(_id: string, opts: { treeDataProvider: T }) => ({
    dispose: () => undefined,
    treeDataProvider: opts.treeDataProvider,
  }),
  createTextEditorDecorationType: (_opts?: unknown) => ({
    key: 'mock-decoration-type',
    dispose: () => undefined,
  }),
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(_k: string): T | undefined => undefined,
  }),
  openTextDocument: async () => ({}),
  workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
};

export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
  executeCommand: async () => undefined,
};

export const env = {
  clipboard: {
    writeText: async (_s: string) => undefined,
  },
};

export class Uri {
  static file(p: string) {
    return { fsPath: p, path: p, scheme: 'file' };
  }
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class MarkdownString {
  public value = '';
  public isTrusted = false;
  constructor(s?: string) {
    if (s) this.value = s;
  }
  appendMarkdown(s: string): this {
    this.value += s;
    return this;
  }
}

export class TreeItem {
  public id?: string;
  public description?: string;
  public tooltip?: unknown;
  public contextValue?: string;
  public iconPath?: unknown;
  public command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public readonly label: string,
    public readonly collapsibleState: number = TreeItemCollapsibleState.None,
  ) {}
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  public event = (fn: (e: T) => void) => {
    this.listeners.push(fn);
    return { dispose: () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    } };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

