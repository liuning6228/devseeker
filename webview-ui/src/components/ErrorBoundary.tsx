import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error?: Error;
}

/**
 * ErrorBoundary — 错误边界
 * 捕获子组件渲染错误，展示 fallback UI 而非整个页面白屏。
 * 用法:
 *   <ErrorBoundary fallback={<SkeletonScreen variant="card" />}>
 *     <MessageList />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="error-boundary" role="alert">
          <div className="error-boundary__icon">💥</div>
          <h3 className="error-boundary__title">组件加载失败</h3>
          <p className="error-boundary__message">{this.state.error?.message}</p>
          <div className="error-boundary__actions">
            <button className="btn btn-primary" onClick={this.handleRetry}>🔄 重试</button>
            <button className="btn btn-outline" onClick={() => navigator.clipboard.writeText(this.state.error?.stack || '')}>📋 复制错误信息</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
