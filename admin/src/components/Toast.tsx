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
      <div
        className="fixed z-[200] flex flex-col gap-2 pointer-events-none
          bottom-4 left-4 right-4
          sm:top-5 sm:right-5 sm:bottom-auto sm:left-auto sm:w-auto"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="toast-item pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-[14px]"
            style={{
              background: 'rgba(28,28,30,0.9)',
              backdropFilter: 'blur(24px) saturate(180%)',
              WebkitBackdropFilter: 'blur(24px) saturate(180%)',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.06) inset',
              minWidth: '260px',
              maxWidth: '340px',
            }}
          >
            <span
              className="flex-shrink-0"
              style={{ color: toast.type === 'success' ? '#30d158' : '#ff453a' }}
            >
              {toast.type === 'success'
                ? <CheckCircle2 size={16} />
                : <XCircle size={16} />
              }
            </span>
            <span className="text-[13px] flex-1 leading-snug" style={{ color: 'rgba(235,235,245,0.85)' }}>
              {toast.message}
            </span>
            <button
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              className="flex-shrink-0 p-0.5 rounded-[6px] transition-colors"
              style={{ color: 'rgba(235,235,245,0.3)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.75)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(235,235,245,0.3)'; }}
            >
              <X size={12} />
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
