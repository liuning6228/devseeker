import React, { type ReactNode, type ErrorInfo } from 'react';

interface ChatErrorBoundaryProps {
  children: ReactNode;
}

interface ChatErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * ChatErrorBoundary — 捕获 MessageList 及子组件的渲染异常
 *
 * 防止单个工具调用卡片渲染异常导致整个 Webview 白屏。
 * 仅在 render 阶段生效（不捕获 async/setTimeout 事件），
 * 展示友好错误界面 + 重试按钮。
 */
export class ChatErrorBoundary extends React.Component<
  ChatErrorBoundaryProps,
  ChatErrorBoundaryState
> {
  state: ChatErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ChatErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ChatErrorBoundary] caught:', error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center p-8 text-center gap-4">
          <div className="text-vscode-error-fg text-lg font-semibold">
            渲染异常
          </div>
          <p className="text-sm text-vscode-fg/70 max-w-md">
            {this.state.error?.message || '消息列表渲染时发生了意外错误'}
          </p>
          <div className="flex gap-3 mt-2">
            <button
              onClick={this.handleRetry}
              className="px-4 py-2 rounded bg-vscode-btn-bg text-vscode-btn-fg text-sm
                         hover:bg-vscode-btn-hover-bg cursor-pointer"
            >
              重试
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded border border-vscode-input-border
                         text-sm text-vscode-fg cursor-pointer"
            >
              重新加载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
