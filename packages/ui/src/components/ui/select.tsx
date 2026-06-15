import * as React from "react"
import {Check, ChevronDown} from "lucide-react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import {cn} from "@/lib/utils"
import {inputVariants} from "@/components/ui/input"

/**
 * A custom `Select` — a Radix-Popover listbox styled to match {@link Input},
 * replacing the native `<select>` for a consistent, themed experience (the OS
 * dropdown looked foreign and ignored our palette). It deliberately keeps the
 * native API so call sites migrate by renaming the element only: it accepts
 * `<option>` / `<optgroup>` children, a `value`, and an `onChange` that fires
 * with a synthetic `{target: {value}}` event. Keyboard parity with the native
 * control: arrows, Home/End, type-ahead, Enter/Space to pick, Esc to close.
 *
 * Pass `unstyled` when the caller's `className` fully styles the trigger (the
 * dense database menus and the kit inputs do this); otherwise the trigger wears
 * the shared input styling.
 */

/** The native-compatible change event shape the control emits. */
export interface SelectChangeEvent {
  target: {value: string}
  currentTarget: {value: string}
}

export interface SelectProps {
  value?: string | number
  onChange?: (event: SelectChangeEvent) => void
  children?: React.ReactNode
  placeholder?: string
  disabled?: boolean
  inputSize?: "default" | "sm"
  /** Skip the default input styling — the caller's `className` styles the trigger. */
  unstyled?: boolean
  className?: string
  /** Class for the trigger's wrapper (e.g. width); the popup matches its width. */
  wrapperClassName?: string
  align?: "start" | "center" | "end"
  "aria-label"?: string
  id?: string
  name?: string
}

interface OptionItem {
  value: string
  node: React.ReactNode
  label: string
  disabled?: boolean
  group?: string
}

/** Flatten a React node to its text, for type-ahead and the trigger fallback. */
function nodeText(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join("")
  if (React.isValidElement(node)) return nodeText((node.props as {children?: React.ReactNode}).children)
  return ""
}

/** Collect `<option>` / `<optgroup>` children into a flat item list. */
function collectItems(children: React.ReactNode): OptionItem[] {
  const items: OptionItem[] = []
  const walk = (nodes: React.ReactNode, group?: string): void => {
    React.Children.forEach(nodes, (child) => {
      if (!React.isValidElement(child)) return
      if (child.type === "optgroup") {
        const p = child.props as {label?: string; children?: React.ReactNode}
        walk(p.children, p.label)
      } else if (child.type === "option") {
        const p = child.props as {value?: string | number; children?: React.ReactNode; disabled?: boolean}
        items.push({value: String(p.value ?? ""), node: p.children, label: nodeText(p.children), disabled: p.disabled, group})
      }
    })
  }
  walk(children)
  return items
}

const Select = React.forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {value, onChange, children, placeholder, disabled, inputSize = "default", unstyled, className, wrapperClassName, align = "start", id, name, ...rest},
  ref,
) {
  const items = React.useMemo(() => collectItems(children), [children])
  const current = String(value ?? "")
  const [open, setOpen] = React.useState(false)
  const listRef = React.useRef<HTMLDivElement>(null)
  const typeahead = React.useRef<{buffer: string; at: number}>({buffer: "", at: 0})
  const selected = items.find((it) => it.value === current)

  const pick = (v: string): void => {
    setOpen(false)
    onChange?.({target: {value: v}, currentTarget: {value: v}})
  }

  const enabledOptions = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])') ?? [])

  const focusSelected = (): void => {
    const opts = enabledOptions()
    if (opts.length === 0) return
    const target = opts.find((el) => el.dataset.value === current) ?? opts[0]
    target.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const opts = enabledOptions()
    if (opts.length === 0) return
    const at = opts.indexOf(document.activeElement as HTMLElement)
    const focusAt = (i: number): void => {
      e.preventDefault()
      opts[Math.max(0, Math.min(opts.length - 1, i))]?.focus()
    }
    switch (e.key) {
    case "ArrowDown":
      return focusAt(at < 0 ? 0 : at + 1)
    case "ArrowUp":
      return focusAt(at < 0 ? opts.length - 1 : at - 1)
    case "Home":
      return focusAt(0)
    case "End":
      return focusAt(opts.length - 1)
    default:
      break
    }
    // Type-ahead: jump to the next option whose label starts with the typed run.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = (e.timeStamp || 0)
      const ta = typeahead.current
      ta.buffer = now - ta.at > 800 ? e.key : ta.buffer + e.key
      ta.at = now
      const lower = ta.buffer.toLowerCase()
      const order = [...opts.slice(at + 1), ...opts.slice(0, at + 1)]
      const hit = order.find((el) => (el.dataset.label ?? "").toLowerCase().startsWith(lower))
      if (hit) {
        e.preventDefault()
        hit.focus()
      }
    }
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <div className={cn("relative", wrapperClassName)}>
        <PopoverPrimitive.Trigger asChild>
          <button
            ref={ref}
            type="button"
            id={id}
            name={name}
            role="combobox"
            aria-expanded={open}
            aria-label={rest["aria-label"]}
            data-value={current}
            disabled={disabled}
            className={cn(
              "inline-flex items-center justify-between gap-1.5 text-left",
              !unstyled && inputVariants({inputSize}),
              !unstyled && "font-normal",
              "cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
              className,
            )}
          >
            <span className={cn("min-w-0 truncate", !selected && "text-muted-foreground")}>
              {selected ? selected.node : placeholder}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
          </button>
        </PopoverPrimitive.Trigger>
      </div>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={listRef}
          role="listbox"
          align={align}
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            focusSelected()
          }}
          // Don't yank focus back on close — when this Select sits inside
          // another popover (view options, property config), forcing focus
          // fights the parent's focus scope and flickers it shut on reopen.
          onCloseAutoFocus={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
          className={cn(
            "z-50 max-h-[var(--radix-popover-content-available-height)] min-w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-1rem)]",
            "overflow-y-auto overflow-x-hidden overscroll-contain rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-hidden",
            // Entrance only — no exit animation, so the content (and its dismissable
            // layer) unmounts immediately on close rather than lingering and
            // interfering with an enclosing popover.
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          {items.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">No options</div>}
          {items.map((it, i) => {
            const header = it.group && it.group !== items[i - 1]?.group
            return (
              <React.Fragment key={`${it.group ?? ""}:${it.value}:${i}`}>
                {header && (
                  <div className="px-2 pb-0.5 pt-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                    {it.group}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  data-value={it.value}
                  data-label={it.label}
                  aria-selected={it.value === current}
                  aria-disabled={it.disabled || undefined}
                  disabled={it.disabled}
                  tabIndex={-1}
                  onClick={() => pick(it.value)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden",
                    it.value === current ? "bg-hover font-medium" : "hover:bg-hover focus:bg-hover",
                    it.disabled && "pointer-events-none opacity-50",
                  )}
                >
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {it.value === current && <Check className="h-3.5 w-3.5" aria-hidden />}
                  </span>
                  <span className="min-w-0 truncate">{it.node}</span>
                </button>
              </React.Fragment>
            )
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
})
Select.displayName = "Select"

export {Select}
