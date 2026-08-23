import * as React from "react"
import {cva, type VariantProps} from "class-variance-authority"

import {cn} from "@/lib/utils"

const emptyStateVariants = cva("flex flex-col gap-2", {
  variants: {
    variant: {
      overlay: "py-6 text-sm",
      panel: "items-center py-8 text-center",
    },
  },
  defaultVariants: {
    variant: "panel",
  },
})

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof emptyStateVariants> {
  icon?: React.ReactNode
  title: React.ReactNode
  hint?: React.ReactNode
  action?: React.ReactNode
}

const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  ({className, variant = "panel", icon, title, hint, action, ...props}, ref) => (
    <div
      ref={ref}
      role="status"
      className={cn(emptyStateVariants({variant}), className)}
      {...props}
    >
      {icon}
      <div className={cn("text-sm", variant === "panel" && "text-muted-foreground")}>{title}</div>
      {hint && <div className="max-w-sm text-xs text-muted-foreground/70">{hint}</div>}
      {action}
    </div>
  )
)
EmptyState.displayName = "EmptyState"

export {EmptyState, emptyStateVariants}
