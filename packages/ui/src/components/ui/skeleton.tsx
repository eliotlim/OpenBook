import {cn} from "@/lib/utils"

/** A shimmering placeholder that reserves space while content is (re)computing,
 *  so a block can fill in without shifting the surrounding layout. The shimmer
 *  (a soft highlight sweep, see `.ob-skeleton` in index.css) reads calmer than
 *  an opacity pulse and freezes gracefully under reduced motion. */
function Skeleton({className, ...props}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ob-skeleton rounded-md", className)} {...props} />
}

export {Skeleton}
