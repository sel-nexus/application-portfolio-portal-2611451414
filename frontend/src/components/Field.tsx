/** Render consistent labels, required markers, and associated inline errors. */
import type { ReactNode } from 'react';

interface FieldProps { id: string; label: string; error?: string; required?: boolean; children: ReactNode }

/** Group one stable control with its accessible label and validation feedback. */
export function Field({ id, label, error, required, children }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={id} className={required ? 'required-label' : undefined}>
        {label}
      </label>
      {children}
      {error && <p id={`${id}-error`} className="error" role="alert">{error}</p>}
    </div>
  );
}
