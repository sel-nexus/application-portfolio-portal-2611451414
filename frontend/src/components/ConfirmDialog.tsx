/** Provide a native modal confirmation with browser-managed focus trapping. */
import { useEffect, useId, useRef } from 'react';
interface Props { open: boolean; title: string; message: string; pending?: boolean; onClose: () => void; onConfirm: () => void }

/** Show a keyboard-accessible confirmation and restore trigger focus when closed. */
export function ConfirmDialog({ open, title, message, pending, onClose, onConfirm }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    if (open) { dialog?.showModal(); document.body.style.overflow = 'hidden'; }
    return () => { dialog?.close(); document.body.style.overflow = ''; previous?.focus(); };
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} aria-modal="true" onCancel={onClose}
      onClick={event => { if (event.target === ref.current) onClose(); }}>
      <h2 id={titleId}>{title}</h2>
      <p>{message}</p>
      <div className="actions">
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button disabled={pending} onClick={onConfirm}>{pending ? 'Saving…' : 'Confirm'}</button>
      </div>
    </dialog>
  );
}
