/** Five animated equalizer bars — the "live / processing" indicator. */
export function EqualizerBars({ className = "" }: { className?: string }) {
  return (
    <span className={`eq ${className}`} aria-hidden>
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
