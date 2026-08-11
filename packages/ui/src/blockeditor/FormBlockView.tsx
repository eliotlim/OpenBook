import React, {createContext, useContext, useEffect, useState} from 'react';
import {isSafeHref, type FormField, type FormFieldKind, type FormSchema} from '@book.dev/sdk';
import {useOptionalData} from '@/data';
import {t} from '@/i18n';
import {blockProp} from './model';
import {registerCustomBlock, type CustomBlockProps} from './registry';
import {ConfigField, KitFrame, NameDescriptionFields} from './kit/KitFrame';
import {useKitLock} from './kit/lock';
import {formSchemaFromProps, makeFormBlock} from './formBlock';
import {FormClosedView, FormSubmissionView} from './FormSubmissionView';

export {formOriginUrl} from './formBlock';

/** The live-page destination used by frozen form previews, when one is known. */
export const FormOriginContext = createContext<string | null>(null);

/** Page id carried by the safe live-page URL; absent for static/offline previews. */
export function formPageIdFromOrigin(originUrl: string | null | undefined): string | null {
  if (!originUrl || !isSafeHref(originUrl)) return null;
  try {
    const pageId = new URL(originUrl).searchParams.get('page');
    return pageId?.trim() || null;
  } catch {
    return null;
  }
}

function propsRecord(block: CustomBlockProps['block']): Record<string, unknown> {
  const schema = blockProp<unknown>(block, 'schema');
  return {
    formId: blockProp(block, 'formId'),
    submissionKey: blockProp(block, 'submissionKey'),
    enabled: blockProp(block, 'enabled'),
    databaseId: blockProp(block, 'databaseId'),
    schema: schema && typeof schema === 'object' && 'toJSON' in schema
      ? (schema as {toJSON(): unknown}).toJSON()
      : schema,
  };
}

export function formSchemaFromBlock(block: CustomBlockProps['block']): FormSchema {
  return formSchemaFromProps(propsRecord(block));
}

const FIELD_INPUT_TYPE: Partial<Record<FormFieldKind, React.HTMLInputTypeAttribute>> = {
  text: 'text',
  number: 'number',
  date: 'date',
  email: 'email',
  phone: 'tel',
  url: 'url',
};

/** One frozen field control; FORM-5 replaces this shell with submission state. */
export const FormFieldPreview: React.FC<{field: FormField}> = ({field}) => {
  const common = {
    disabled: true,
    'aria-label': field.label,
    placeholder: field.placeholder,
  };
  let control: React.ReactNode;
  switch (field.kind) {
  case 'longtext':
    control = <textarea {...common} rows={3} />;
    break;
  case 'select':
  case 'multiselect':
    control = (
      <select {...common} multiple={field.kind === 'multiselect'} defaultValue={field.kind === 'multiselect' ? [] : ''}>
        {field.kind === 'select' && <option value="">—</option>}
        {(field.options ?? []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    );
    break;
  case 'checkbox':
    control = <input type="checkbox" disabled aria-label={field.label} />;
    break;
  case 'rating':
    control = <input type="range" min={1} max={5} value={1} readOnly disabled aria-label={field.label} />;
    break;
  case 'files':
    control = <input type="file" disabled aria-label={field.label} />;
    break;
  default:
    control = <input {...common} type={FIELD_INPUT_TYPE[field.kind] ?? 'text'} />;
    break;
  }
  return (
    <label className="obe-form-field" data-form-field={field.id} data-form-field-kind={field.kind}>
      <span className="obe-form-field-label">
        {field.label || t('formBlock.untitledField')}
        {field.required && <span aria-hidden> *</span>}
      </span>
      {control}
    </label>
  );
};

const EmptyFields: React.FC = () => (
  <div className="obe-form-empty">{t('formBlock.noFields')}</div>
);

/** Authoring shell: definition summary only; FORM-4 owns the real builder. */
export const FormEditView: React.FC<{schema: FormSchema}> = ({schema}) => (
  <div className="obe-form-edit" data-form-mode="edit">
    {schema.fields.length === 0 ? <EmptyFields /> : (
      <ul className="obe-form-field-list">
        {schema.fields.map((field) => (
          <li key={field.id || `${field.kind}-${field.label}`}>
            <span>{field.label || t('formBlock.untitledField')}</span>
            <span className="obe-form-kind">{field.kind}</span>
          </li>
        ))}
      </ul>
    )}
    <button type="button" className="obe-form-builder" data-form-open-builder disabled>
      {t('formBlock.openBuilder')}
    </button>
  </div>
);

/** Reader/presenter/viewer shell: all controls are deliberately frozen. */
export const FormReadonlyView: React.FC<{schema: FormSchema; originUrl?: string | null}> = ({schema, originUrl}) => {
  const liveUrl = originUrl && isSafeHref(originUrl) ? originUrl : null;
  return (
    <div className="obe-form-preview" data-form-mode="readonly" data-ob-form>
      {schema.fields.length === 0 ? <EmptyFields /> : schema.fields.map((field) => <FormFieldPreview key={field.id || `${field.kind}-${field.label}`} field={field} />)}
      <button type="button" className="obe-kit-action" disabled>{schema.submitLabel || t('formBlock.submit')}</button>
      {liveUrl && <a className="obe-form-live-link" href={liveUrl}>{t('formBlock.liveLink')}</a>}
    </div>
  );
};

const BoundDatabaseSummary: React.FC<{databaseId?: string}> = ({databaseId}) => {
  const client = useOptionalData();
  const [summary, setSummary] = useState<{name: string; rows: number} | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!databaseId || !client) {
      setSummary(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void Promise.all([client.getDatabase(databaseId), client.listRows(databaseId)])
      .then(([database, rows]) => {
        if (!cancelled) setSummary({name: database?.name?.trim() || t('formBlock.database'), rows: rows.length});
      })
      .catch(() => {
        if (!cancelled) setSummary({name: t('formBlock.databaseUnavailable'), rows: 0});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, databaseId]);

  if (!databaseId) return <span>{t('formBlock.noDatabase')}</span>;
  if (!client) return <span>{t('formBlock.databaseId', {id: databaseId})}</span>;
  if (loading || !summary) return <span>{t('formBlock.loadingDatabase')}</span>;
  return <span>{t('formBlock.databaseSummary', {name: summary.name, count: summary.rows})}</span>;
};

/**
 * Form block boundary for FORM-4/FORM-5: the authoring summary and frozen
 * reader preview are separate components, with submission intentionally absent.
 */
export const FormBlockView: React.FC<CustomBlockProps> = ({block, editor, pageReadOnly}) => {
  const schema = formSchemaFromBlock(block);
  const client = useOptionalData();
  const groupLocked = useKitLock();
  const readonly = pageReadOnly || groupLocked;
  const originUrl = useContext(FormOriginContext);
  const pageId = formPageIdFromOrigin(originUrl);
  const submissionClient = client?.submitForm
    ? client as NonNullable<typeof client> & Required<Pick<NonNullable<typeof client>, 'submitForm'>>
    : null;
  const live = pageReadOnly && !editor.readOnly && pageId !== null && submissionClient !== null;
  const config = (
    <>
      <NameDescriptionFields block={block} editor={editor} namePlaceholder={t('formBlock.label')} />
      <ConfigField label={t('formBlock.formId')}>
        <code className="obe-form-id">{schema.formId || '—'}</code>
      </ConfigField>
      <ConfigField label={t('formBlock.destination')}>
        <BoundDatabaseSummary databaseId={schema.databaseId} />
      </ConfigField>
    </>
  );
  let control: React.ReactNode;
  if (!readonly) control = <FormEditView schema={schema} />;
  else if (live && (!schema.enabled || schema.maxSubmissions === 0)) control = <FormClosedView />;
  else if (live) control = <FormSubmissionView schema={schema} pageId={pageId} client={submissionClient} />;
  else control = <FormReadonlyView schema={schema} originUrl={originUrl} />;
  return <KitFrame block={block} editor={editor} kind="form" defaultName={t('formBlock.label')} symbol={false} control={control} config={config} />;
};

/** Register from provider-aware hosts (BlockPageDocument and the viewer). */
export function registerFormBlock(): void {
  registerCustomBlock({
    type: 'form',
    render: FormBlockView,
    slash: {
      label: 'Form',
      hint: 'Collect structured responses into a database',
      keywords: 'form survey questionnaire response submission fields database',
      group: 'interactive',
      make: makeFormBlock,
    },
  });
}
