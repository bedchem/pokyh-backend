import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error';
}

interface ToastContextValue {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Desktop: top-right · Mobile: bottom, full-width */}
      <div
        className="fixed z-[200] flex flex-col gap-2 pointer-events-none
          bottom-4 left-4 right-4
          sm:top-5 sm:right-5 sm:bottom-auto sm:left-auto sm:w-auto"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="toast-item pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl"
            style={{
              background: '#13141f',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.05) inset',
              borderLeft: `3px solid ${toast.type === 'success' ? '#10b981' : '#ef4444'}`,
              minWidth: '260px',
              backdropFilter: 'blur(12px)',
            }}
          >
            <span className="flex-shrink-0" style={{ color: toast.type === 'success' ? '#10b981' : '#ef4444' }}>
              {toast.type === 'success'
                ? <CheckCircle2 size={16} />
                : <XCircle size={16} />
              }
            </span>
            <span className="text-sm flex-1" style={{ color: '#e2e8f0' }}>{toast.message}</span>
            <button
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              className="flex-shrink-0 p-0.5 rounded transition-colors"
              style={{ color: '#4a4a5e' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#e2e8f0'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a4a5e'; }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
