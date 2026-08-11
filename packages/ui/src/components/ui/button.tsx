import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // Motion: transition colour + shadow only — the press treatment is colour-only
  // (no geometry shift), on the global ease-out tempo. Two-rule press model: opaque
  // fills (default/destructive/secondary) darken on :active via --press-ink; the
  // transparent controls (outline/ghost) deepen to --hover-strong (link stays text-
  // only). Focus: a crisp 2px-offset keyboard ring (--ring-control) that only shows
  // for keyboard nav — the native-app focus look.
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow] focus-visible:outline-hidden focus-visible:shadow-[var(--ring-control)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:bg-[color-mix(in_srgb,hsl(var(--primary)),var(--press-ink)_8%)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 active:bg-[color-mix(in_srgb,hsl(var(--destructive)),var(--press-ink)_8%)]",
        outline:
          "border border-input bg-transparent shadow-xs hover:bg-hover hover:text-accent-foreground active:bg-hover-strong",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 active:bg-[color-mix(in_srgb,hsl(var(--secondary)),var(--press-ink)_8%)]",
        ghost: "hover:bg-hover hover:text-accent-foreground active:bg-hover-strong active:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline active:text-primary/70",
      },
      size: {
        default: "h-9 gap-2 px-4 py-2",
        /** Pairs with dense inputs (28px); IconButton md is its icon-only sibling. */
        xs: "h-control-sm gap-1.5 rounded-md px-2.5 text-xs",
        sm: "h-8 gap-1.5 rounded-md px-3 text-xs",
        lg: "h-10 gap-2 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
