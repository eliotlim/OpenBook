import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * The muted ghost icon button used throughout the chrome (sidebar, toolbars,
 * page actions, pane controls). One definition so every small icon control has
 * the same hover, radius, focus ring, and muted-by-default color — instead of
 * the `rounded p-1 … hover:bg-accent` snippet copy-pasted per call site.
 */
const iconButtonVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      size: {
        sm: "p-1",     // ~24px — sidebar / inline toolbars
        md: "p-1.5",   // ~28px — page actions / headers
      },
    },
    defaultVariants: {size: "md"},
  }
)

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {
  asChild?: boolean
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? "button")}
        className={cn(iconButtonVariants({size}), className)}
        {...props}
      />
    )
  }
)
IconButton.displayName = "IconButton"

export { IconButton, iconButtonVariants }
