import type { ReactNode } from "react";

/**
 * CSS-only tooltip (see .tt-bubble rules in globals.css).
 * Works on hover and keyboard focus of the wrapped control.
 */
export function Tooltip({
  label,
  children,
  width = 220,
  fullWidth = false,
}: {
  label: string;
  children: ReactNode;
  width?: number;
  /** Wrap full-width (grid cell) children: sizes the wrapper to the cell. */
  fullWidth?: boolean;
}) {
  return (
    <span className={fullWidth ? "group/tt relative block w-full" : "group/tt relative inline-flex"}>
      {children}
      <span
        role="tooltip"
        className="tt-bubble absolute bottom-full left-1/2 z-50 mb-2 rounded-lg border px-3 py-2 text-center text-[11px] font-medium leading-snug shadow-2xl"
        style={{
          width,
          background: "var(--sp-tip-bg)",
          borderColor: "var(--sp-tip-line)",
          color: "var(--sp-ink)",
          boxShadow: "0 12px 32px -8px rgba(0,0,0,0.45)",
        }}
      >
        {label}
      </span>
    </span>
  );
}
