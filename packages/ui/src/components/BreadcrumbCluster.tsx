import React from 'react';
import {useNavigation, useWorkspace} from '@/providers';

export default function BreadcrumbCluster() {
  const {workspace} = useWorkspace();
  const {pages, currentPageId} = useNavigation();
  const current = pages.find((p) => p.id === currentPageId);
  const pageTitle = current?.name && current.name.trim().length > 0 ? current.name : 'Untitled';

  const items = [
    {emoji: workspace?.icon ?? '🗂️', title: workspace?.name ?? 'Workspace'},
    {emoji: '📄', title: pageTitle},
  ];

  return (
    <nav className="flex items-center text-sm" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <React.Fragment key={index}>
          {index > 0 && <span className="mx-0.5 text-muted-foreground/40">/</span>}
          <span className="flex max-w-[220px] items-center gap-1.5 rounded px-1.5 py-0.5 text-foreground/75 transition-colors hover:bg-accent">
            <span className="text-[0.95em] leading-none">{item.emoji}</span>
            <span className="truncate">{item.title}</span>
          </span>
        </React.Fragment>
      ))}
    </nav>
  );
}
