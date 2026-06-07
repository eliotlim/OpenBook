import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { inputVariants } from "@/components/ui/input"

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  inputSize?: "default" | "sm"
  /** Class for the wrapper (e.g. width/flex); the chevron is positioned within. */
  wrapperClassName?: string
}

/**
 * A styled native `<select>` — shares {@link inputVariants} with {@link Input}
 * so dropdowns and text fields match. Native (not a Radix popup) keeps it light
 * and reliably clickable in the desktop WKWebView.
 */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, inputSize = "default", wrapperClassName, children, ...props }, ref) => (
    <div className={cn("relative", wrapperClassName)}>
      <select
        ref={ref}
        className={cn(inputVariants({inputSize}), "cursor-pointer appearance-none pr-8", className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
)
Select.displayName = "Select"

export { Select }
