// Small shared UI primitives used across views.
import { useState } from 'react';

/** Spinning loader. */
export function Spinner() {
  return <div className="spinner" role="status" aria-label="Loading" />;
}

/** Full-block loading state with a label. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

/** Copy-to-clipboard button that confirms with a brief ✓. */
export function Copy({ value, label = '⧉' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`copy${done ? ' done' : ''}`}
      aria-label="Copy to clipboard"
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? '✓' : label}
    </button>
  );
}

/** Labelled, copyable read-only value. */
export function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="field-value">
        <code>{value}</code>
        <Copy value={value} />
      </div>
    </div>
  );
}
