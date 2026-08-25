import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { Check, Copy } from 'lucide-react'
import type { BotStatus } from '../lib/types'

export function cn(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------- button
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger' | 'outline'
  size?: 'sm' | 'md'
}
export function Btn({ variant = 'ghost', size = 'md', className, ...props }: BtnProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-sm',
        variant === 'primary' && 'bg-accent text-black hover:bg-accent-dim',
        variant === 'ghost' && 'bg-panel2 text-text hover:bg-border2 border border-border',
        variant === 'outline' && 'border border-border text-muted hover:text-text hover:border-border2',
        variant === 'danger' && 'bg-transparent text-danger border border-danger/30 hover:bg-danger/10',
        className,
      )}
      {...props}
    />
  )
}

// ---------------------------------------------------------------- card
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-xl border border-border bg-panel', className)}>{children}</div>
}

// ---------------------------------------------------------------- fields
export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
      {help && <span className="mt-1 block text-xs text-muted/80">{help}</span>}
    </label>
  )
}

const inputCls =
  'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted/50 outline-none focus:border-accent/60 font-mono'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={inputCls} {...props} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputCls, 'min-h-20 resize-y')} {...props} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(inputCls, 'appearance-none')} {...props} />
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 rounded-full transition-colors disabled:opacity-30',
        checked ? 'bg-accent' : 'bg-border2',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
          checked ? 'translate-x-5.5 left-0 ml-0.5' : 'left-0.5',
        )}
      />
    </button>
  )
}

// ---------------------------------------------------------------- status
export const STATUS_META: Record<BotStatus, { label: string; cls: string; dot: string }> = {
  created: { label: 'Created', cls: 'text-muted', dot: 'bg-muted' },
  starting: { label: 'Starting', cls: 'text-warn', dot: 'bg-warn dot-running' },
  running: { label: 'Running', cls: 'text-accent', dot: 'bg-accent dot-running' },
  stopped: { label: 'Stopped', cls: 'text-muted', dot: 'bg-muted' },
  failed: { label: 'Failed', cls: 'text-danger', dot: 'bg-danger' },
  crashed: { label: 'Crashed', cls: 'text-danger', dot: 'bg-danger' },
  updating: { label: 'Updating', cls: 'text-warn', dot: 'bg-warn dot-running' },
}

export function StatusPill({ status }: { status: BotStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.stopped
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', meta.cls)}>
      <span className={cn('h-2 w-2 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  )
}

// ---------------------------------------------------------------- misc
export function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-muted hover:text-text transition-colors"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      title="Copy"
    >
      {copied ? <Check size={13} className="text-accent" /> : <Copy size={13} />}
      {label && <span className="text-xs">{copied ? 'copied' : label}</span>}
    </button>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border2 py-16 text-center">
      <p className="text-muted">{title}</p>
      {children}
    </div>
  )
}
