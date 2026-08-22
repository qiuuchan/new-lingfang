import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from 'next-themes';
import App from '@/App';
import '@/index.css';

// 渲染树顶层 ErrorBoundary：捕获渲染阶段错误，提供重置入口。
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('应用渲染崩溃：', error, info?.componentStack);
  }

  handleReset = () => {
    try {
      localStorage.clear();
    } catch {
      /* localStorage 不可用则忽略 */
    }
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: 'flex',
            minHeight: '100vh',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0b0e14',
            color: '#e2e8f0',
            padding: 24,
          }}
        >
          <div
            style={{
              maxWidth: 480,
              textAlign: 'center',
              fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
            }}
          >
            <h1 style={{ fontSize: 20, marginBottom: 8 }}>应用遇到错误</h1>
            <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 16 }}>
              页面渲染过程中出现问题。可以重置本地状态后重新进入应用。
            </p>
            <pre
              style={{
                textAlign: 'left',
                background: '#0f172a',
                padding: 12,
                borderRadius: 8,
                fontSize: 12,
                overflow: 'auto',
                maxHeight: 200,
                marginBottom: 16,
              }}
            >
              {this.state.error.message || String(this.state.error)}
            </pre>
            <button
              type="button"
              onClick={this.handleReset}
              style={{
                padding: '8px 16px',
                background: '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              重置本地状态并重载
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </ThemeProvider>
);
