import React from 'react';
import {PAGE_TEMPLATES, instantiateTemplate, type PageTemplate} from '@open-book/sdk';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {useData} from '@/data';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {writePageIcon} from '@/lib/pageIcon';
import type {TKey} from '@/i18n';

/** Template ids are kebab-case; i18n keys are camelCase under `templates.`. */
const keyOf = (id: PageTemplate['id'], field: 'name' | 'description'): TKey =>
  `templates.${id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}.${field}` as TKey;

/**
 * The template gallery: ready-made pages (documents and databases with sample
 * rows) created client-side through the data APIs. Opened from the sidebar's
 * Templates button or the command palette; picking a card creates the page,
 * stamps its icon, navigates to it, and closes the dialog.
 */
export function TemplateGallery() {
  const {hud, setHud} = useHud();
  const {t} = useTranslation();
  const client = useData();
  const {selectPage} = useNavigation();
  const [busyId, setBusyId] = React.useState<PageTemplate['id'] | null>(null);

  const setOpen = (open: boolean) =>
    setHud((draft) => {
      draft.templates.open = open;
      return draft;
    });

  const pick = async (template: PageTemplate) => {
    if (busyId) return;
    setBusyId(template.id);
    try {
      const page = await instantiateTemplate(client, template);
      writePageIcon(page.id, template.icon);
      selectPage(page.id);
      setOpen(false);
    } catch (e) {
      console.error('TemplateGallery: instantiation failed:', e);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={hud.templates.open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t('templates.title')}</DialogTitle>
          <DialogDescription>{t('templates.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PAGE_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              data-template={template.id}
              disabled={busyId !== null}
              onClick={() => void pick(template)}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-[background-color,border-color,box-shadow] hover:border-foreground/20 hover:shadow-lift active:shadow-none disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <span aria-hidden className="text-2xl leading-none">
                {template.icon}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{t(keyOf(template.id, 'name'))}</span>
                <span className="text-xs text-muted-foreground">
                  {busyId === template.id ? t('templates.creating') : t(keyOf(template.id, 'description'))}
                </span>
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default TemplateGallery;
