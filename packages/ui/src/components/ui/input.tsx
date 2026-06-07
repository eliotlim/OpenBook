import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const inputVariants = cva(
  "w-full rounded-md border border-input bg-transparent text-sm text-foreground transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      // `inputSize` (not `size`, which is a native numeric input attribute).
      inputSize: {
        default: "flex h-9 px-3 py-1 shadow-xs",
        sm: "h-8 px-2.5 py-1", // compact, no shadow — for dense inline controls
      },
    },
    defaultVariants: {inputSize: "default"},
  }
)

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, inputSize, ...props }, ref) => (
    <input type={type} className={cn(inputVariants({inputSize}), className)} ref={ref} {...props} />
  )
)
Input.displayName = "Input"

export { Input, inputVariants }
