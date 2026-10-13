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
            role="status"
            className="toast-item pointer-events-auto flex items-center gap-3 rounded-[16px] bg-tip py-3 pl-4 pr-3"
            style={{
              boxShadow: '0 18px 30px -18px rgb(0 0 0 / 0.55)',
              minWidth: '260px',
              maxWidth: '360px',
            }}
          >
            <span
              className="flex-shrink-0"
              style={{ color: toast.type === 'success' ? 'var(--mint)' : 'var(--rose)' }}
            >
              {toast.type === 'success'
                ? <CheckCircle2 size={16} />
                : <XCircle size={16} />
              }
            </span>
            <span className="flex-1 text-[13.5px] leading-snug text-tip-ink">
              {toast.message}
            </span>
            <button
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              aria-label="Schließen"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-tip-dim transition-colors hover:text-tip-ink"
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
