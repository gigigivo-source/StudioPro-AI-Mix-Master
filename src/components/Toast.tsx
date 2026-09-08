"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  title: string;
  message?: string;
}

interface ToastContextValue {
  toast: (t: { type: ToastType; title: string; message?: string }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const STYLES: Record<
  ToastType,
  { icon: typeof Info; color: string; bg: string }
> = {
  success: { icon: CircleCheck, color: "var(--sp-ok)", bg: "rgba(52, 225, 176, 0.1)" },
  error: { icon: TriangleAlert, color: "var(--sp-err)", bg: "rgba(255, 92, 122, 0.1)" },
  info: { icon: Info, color: "var(--sp-aqua)", bg: "rgba(0, 212, 255, 0.1)" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (t: { type: ToastType; title: string; message?: string }) => {
      const id = nextId.current++;
      setItems((prev) => [...prev.slice(-3), { id, ...t }]);
      window.setTimeout(() => dismiss(id), 5200);
    },
    [dismiss]
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="fixed bottom-5 right-5 z-[100] flex w-[min(380px,calc(100vw-2.5rem))] flex-col gap-3"
        role="status"
        aria-live="polite"
      >
        {items.map((t) => {
          const s = STYLES[t.type];
          const Icon = s.icon;
          return (
            <div
              key={t.id}
              className="toast-in glass-strong flex items-start gap-3 rounded-xl p-4 shadow-2xl"
              style={{ borderLeft: `3px solid ${s.color}` }}
            >
              <span
                className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg"
                style={{ background: s.bg, color: s.color }}
              >
                <Icon size={17} strokeWidth={2.2} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-snug text-ink">{t.title}</p>
                {t.message && (
                  <p className="mt-0.5 break-words text-xs leading-relaxed text-mut">
                    {t.message}
                  </p>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="btn-icon h-6 w-6 flex-none"
                aria-label="Dismiss notification"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
