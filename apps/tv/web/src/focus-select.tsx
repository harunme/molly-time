import { useEffect, useRef, useState } from 'react';
import { useFocusable } from '@noriginmedia/norigin-spatial-navigation';

export function FocusSelect<T extends string>({ focusKey, label, value, options, disabled = false, onChange }: {
  focusKey: string; label: string; value?: T; options: readonly { value: T; label: string }[]; disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null);
  const { ref, focused, focusSelf } = useFocusable({ focusKey, focusable: !disabled,
    onEnterPress: () => { if (!disabled) setOpen(true); } });
  const close = () => { setOpen(false); focusSelf(); };
  const choose = (next: T) => { close(); if (next !== value) onChange(next); };
  useEffect(() => {
    if (!open) return;
    const buttons = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const focusOption = (node?: HTMLButtonElement) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: 'nearest' });
    };
    focusOption(buttons().find((node) => node.dataset.value === value) || buttons()[0]);
    const oldBack = window.mollyBack;
    const back = () => { close(); return true; };
    window.mollyBack = back;
    const key = (event: KeyboardEvent) => {
      if (['Escape', 'Backspace', 'BrowserBack', 'ContextMenu', 'Menu'].includes(event.key) || [93, 461, 10009].includes(event.keyCode)) {
        event.preventDefault(); event.stopImmediatePropagation(); close();
      } else if (event.key.startsWith('Arrow') || ['Home', 'End', 'Enter', ' '].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        const nodes = buttons(), index = nodes.indexOf(document.activeElement as HTMLButtonElement);
        if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) nodes[index]?.click();
        else if (event.key === 'ArrowDown') focusOption(nodes[Math.min(index + 1, nodes.length - 1)]);
        else if (event.key === 'ArrowUp') focusOption(nodes[Math.max(index - 1, 0)]);
        else if (event.key === 'Home') focusOption(nodes[0]);
        else if (event.key === 'End') focusOption(nodes[nodes.length - 1]);
      } else if (event.key === 'Tab') setOpen(false);
    };
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', outside);
    return () => {
      if (window.mollyBack === back) window.mollyBack = oldBack;
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  const current = options.find((option) => option.value === value);
  return <div ref={container} className="focus-select">
    <button ref={ref} type="button" role="combobox" aria-label={label} aria-haspopup="listbox"
      aria-expanded={open} aria-controls={open ? `${focusKey}-options` : undefined} disabled={disabled}
      data-focus={focusKey} className={`focus-select-trigger ${focused && !open ? 'focused' : ''}`}
      onFocus={() => focusSelf()} onClick={() => { if (open) close(); else setOpen(true); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation();
          if (!event.repeat) setOpen(true);
        }
      }}>
      <span>{current?.label ?? '正在加载…'}</span><span className="select-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div ref={list} id={`${focusKey}-options`} className="focus-select-options" role="listbox" aria-label={label}>
      {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={value === option.value}
        data-value={option.value} tabIndex={-1} onClick={() => choose(option.value)}>
        <span>{option.label}</span><span aria-hidden="true">{value === option.value ? '✓' : ''}</span>
      </button>)}
    </div>}
  </div>;
}
