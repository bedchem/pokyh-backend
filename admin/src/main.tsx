import { StrictMode, Component, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#080810', color: '#e2e8f0', fontFamily: 'sans-serif', padding: '20px' }}>
          <div style={{ maxWidth: '600px', textAlign: 'center' }}>
            <div style={{ color: '#ef4444', fontSize: '48px', marginBottom: '16px' }}>⚠</div>
            <h1 style={{ fontSize: '20px', marginBottom: '8px' }}>Admin Panel Error</h1>
            <p style={{ color: '#64748b', fontSize: '14px', marginBottom: '16px' }}>
              {(this.state.error as Error).message}
            </p>
            <pre style={{ background: '#0e0f1c', padding: '12px', borderRadius: '8px', fontSize: '11px', textAlign: 'left', overflow: 'auto', color: '#94a3b8', maxHeight: '200px' }}>
              {(this.state.error as Error).stack}
            </pre>
            <button onClick={() => window.location.reload()} style={{ marginTop: '16px', padding: '8px 20px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

const rootEl = document.getElementById('root')!
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
