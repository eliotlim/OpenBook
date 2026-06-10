import React, {useEffect, useState} from 'react';
import {useNavigation, useWorkspace} from '@/providers';
import {readPageIcon, subscribePageIcon} from '@/lib/pageIcon';

export default function BreadcrumbCluster() {
  const {workspace} = useWorkspace();
  const {pages, currentPageId, pageLabel, selectPage} = useNavigation();
  // Icons live in localStorage; re-render when one changes so the crumb
  // updates the moment the user picks a new page icon.
  const [, setIconVersion] = useState(0);
  useEffect(() => subscribePageIcon(() => setIconVersion((v) => v + 1)), []);

  // Walk parent links up from the current page to build the ancestor path.
  const chain: string[] = [];
  if (currentPageId) {
    const byId = new Map(pages.map((p) => [p.id, p] as const));
    let id: string | null = currentPageId;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      chain.unshift(id);
      id = byId.get(id)?.parentId ?? null;
    }
  }

  return (
    <nav className="flex min-w-0 items-center text-sm" aria-label="Breadcrumb">
      <span className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-foreground/75">
        <span className="text-[0.95em] leading-none">{workspace?.icon ?? '🗂️'}</span>
        <span className="truncate">{workspace?.name ?? 'Workspace'}</span>
      </span>
      {chain.map((id, index) => {
        const last = index === chain.length - 1;
        return (
          <React.Fragment key={id}>
            <span className="mx-0.5 shrink-0 text-muted-foreground/40">/</span>
            <button
              type="button"
              onClick={() => selectPage(id)}
              className={cnCrumb(last)}
              title={pageLabel(id)}
            >
              <span className="text-[0.95em] leading-none">{readPageIcon(id)}</span>
              <span className="truncate">{pageLabel(id)}</span>
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
}

const cnCrumb = (last: boolean): string =>
  `flex min-w-0 max-w-[200px] items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors hover:bg-accent ${
    last ? 'text-foreground' : 'text-foreground/60'
  }`;
