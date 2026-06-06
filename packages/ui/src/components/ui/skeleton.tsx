import {cn} from "@/lib/utils"

/** A pulsing placeholder that reserves space while content is (re)computing,
 *  so a block can fill in without shifting the surrounding layout. */
function Skeleton({className, ...props}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />
}

export {Skeleton}
