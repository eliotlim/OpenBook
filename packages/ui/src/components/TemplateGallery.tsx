import React from 'react';
import {PAGE_TEMPLATES, instantiateTemplate, type PageTemplate} from '@book.dev/sdk';
import {Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {useData} from '@/data';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {writePageIcon} from '@/lib/pageIcon';
import type {TKey} from '@/i18n';

/** Template ids are kebab-case; i18n keys are camelCase under `templates.`. */
const keyOf = (id: PageTemplate['id'], field: 'name' | 'description'): TKey =>
  `templates.${id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}.${field}` as TKey;

/** i18n key for a template tag chip label (`templates.tag.<tag>`). */
const tagKey = (tag: PageTemplate['tags'][number]): TKey => `templates.tag.${tag}` as TKey;

/**
 * Gallery sections, derived from a template's tags: anything not backed by a
 * database (the block-doc artifacts) groups under "Interactive documents"; the
 * database templates group under "Databases". Order here is the render order.
 */
const SECTIONS: {key: 'documents' | 'databases'; isMember: (template: PageTemplate) => boolean}[] = [
  {key: 'documents', isMember: (template) => !template.tags.includes('database')},
  {key: 'databases', isMember: (template) => template.tags.includes('database')},
];

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
        {/* -mx-1 px-1 keeps the focus ring from clipping against the scrollport. */}
        <div className="-mx-1 max-h-[65vh] space-y-4 overflow-y-auto px-1">
          {SECTIONS.map(({key, isMember}) => {
            const members = PAGE_TEMPLATES.filter(isMember);
            if (members.length === 0) return null;
            return (
              <section key={key} className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">{t(`templates.section.${key}` as TKey)}</h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {members.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      data-template={template.id}
                      disabled={busyId !== null}
                      onClick={() => void pick(template)}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-[background-color,border-color,box-shadow] hover:border-foreground/20 hover:shadow-lift active:shadow-none disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-hidden focus-visible:shadow-[var(--ring-control)]"
                    >
                      <span aria-hidden className="text-2xl leading-none">
                        {template.icon}
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm font-medium">{t(keyOf(template.id, 'name'))}</span>
                        <span className="text-xs text-muted-foreground">
                          {busyId === template.id ? t('templates.creating') : t(keyOf(template.id, 'description'))}
                        </span>
                        {template.tags.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {template.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
                              >
                                {t(tagKey(tag))}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default TemplateGallery;
