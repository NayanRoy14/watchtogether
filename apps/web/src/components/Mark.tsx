/** Two overlapping circles: two people, one picture. */
export function Mark({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="12.5" cy="16" r="7" fill="none" stroke="var(--color-accent)" strokeWidth="2.5" />
      <circle cx="19.5" cy="16" r="7" fill="none" stroke="var(--color-fg)" strokeWidth="2.5" />
    </svg>
  );
}
