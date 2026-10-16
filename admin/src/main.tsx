import { StrictMode, Component, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/poppins/latin-400.css'
import '@fontsource/poppins/latin-500.css'
import '@fontsource/poppins/latin-600.css'
import './index.css'
import App from './App.tsx'
import { startFavicon } from './favicon'
import { startThemeSync } from './theme'
import { reportPanelError, startErrorReports } from './errorReports'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { reportPanelError(error) }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--canvas)', color: 'var(--ink)', padding: '20px' }}>
          <div style={{ width: '100%', maxWidth: '600px', background: 'var(--sheet)', borderRadius: '34px', padding: '44px 40px', textAlign: 'center' }}>
            <h1 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '8px' }}>Admin Panel Error</h1>
            <p style={{ color: 'var(--rose-deep)', fontSize: '14px', marginBottom: '20px' }}>
              {(this.state.error as Error).message}
            </p>
            <pre style={{ background: 'var(--well)', padding: '14px 16px', borderRadius: '16px', fontSize: '11px', textAlign: 'left', overflow: 'auto', color: 'var(--ink-2)', maxHeight: '200px' }}>
              {(this.state.error as Error).stack}
            </pre>
            <button onClick={() => window.location.reload()} style={{ marginTop: '22px', padding: '10px 26px', background: 'var(--sky)', color: 'var(--on-sky)', border: 'none', borderRadius: '999px', fontWeight: 500, cursor: 'pointer' }}>
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// The panel used hash addresses (/admin/#/users). Bookmarks and old links
// keep working: they become the plain address before the router starts.
if (window.location.hash.startsWith('#/')) {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')
  window.history.replaceState(null, '', base + window.location.hash.slice(1))
}

const rootEl = document.getElementById('root')!
startThemeSync()
startFavicon()
startErrorReports()
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
