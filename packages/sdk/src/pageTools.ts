import {
  BACKLINKS_PROPERTY_ID,
  COVER_PROPERTY_ID,
  FULLWIDTH_PROPERTY_ID,
  ICON_PROPERTY_ID,
  OWNER_PROPERTY_ID,
  THEME_PROPERTY_ID,
  VERIFICATION_PROPERTY_ID,
  type VerificationValue,
} from './pageProperties';
import type {PageMeta, StoredPage} from './types';

export const PAGE_THEME_IDS = [
  'default', 'amber', 'forest', 'graphite', 'ocean', 'rose', 'sandstone', 'slate', 'sunset', 'teal', 'violet',
] as const;
export const PAGE_BACKGROUND_TOKENS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'] as const;
export const PAGE_COVER_GRADIENT_IDS = ['dawn', 'ocean', 'dusk', 'forest', 'ember', 'slate', 'citrus', 'mint', 'grape', 'sand', 'rose', 'night'] as const;

export type PageToolErrorCode = 'page_not_found' | 'parent_not_found' | 'invalid_input' | 'invalid_move' | 'permission_denied';
export class PageToolError extends Error {
  constructor(readonly code: PageToolErrorCode, message: string) {
    super(message);
    this.name = 'PageToolError';
  }
}

export interface PageToolStore {
  listPages(): Promise<PageMeta[]>;
  getPage(id: string): Promise<StoredPage | null>;
  setPageProperties(id: string, properties: Record<string, unknown>): Promise<StoredPage | null>;
  movePage(id: string, move: {parentId: string | null; orderedIds: string[]}): Promise<StoredPage | null>;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const oneOf = (value: unknown, values: readonly string[]): value is string => typeof value === 'string' && values.includes(value);

export interface PageAppearanceInput {
  icon?: string | null;
  cover?: {kind: 'gradient'; css: string} | {kind: 'image'; url: string; position?: number} | null;
  theme?: {themeId?: string; background?: string; controlIntensity?: number; interfaceIntensity?: number} | null;
  fullWidth?: boolean | null;
}

/** Validate and project the public appearance input onto reserved page-property ids. */
export function buildPageAppearancePatch(input: PageAppearanceInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.icon !== undefined) {
    if (input.icon !== null && (typeof input.icon !== 'string' || input.icon.length > 32)) throw new PageToolError('invalid_input', 'icon must be a string of at most 32 characters or null.');
    patch[ICON_PROPERTY_ID] = input.icon;
  }
  if (input.fullWidth !== undefined) {
    if (input.fullWidth !== null && typeof input.fullWidth !== 'boolean') throw new PageToolError('invalid_input', 'fullWidth must be a boolean or null.');
    patch[FULLWIDTH_PROPERTY_ID] = input.fullWidth;
  }
  if (input.theme !== undefined) {
    if (input.theme === null) patch[THEME_PROPERTY_ID] = null;
    else {
      const theme = record(input.theme);
      if (!theme) throw new PageToolError('invalid_input', 'theme must be an object or null.');
      const allowed = new Set(['themeId', 'background', 'controlIntensity', 'interfaceIntensity']);
      if (Object.keys(theme).some((key) => !allowed.has(key))) throw new PageToolError('invalid_input', 'theme contains an unknown setting.');
      if (theme.themeId !== undefined && !oneOf(theme.themeId, PAGE_THEME_IDS)) throw new PageToolError('invalid_input', `Unknown theme "${String(theme.themeId)}".`);
      if (theme.background !== undefined && !oneOf(theme.background, PAGE_BACKGROUND_TOKENS)) throw new PageToolError('invalid_input', `Unknown background "${String(theme.background)}".`);
      for (const key of ['controlIntensity', 'interfaceIntensity'] as const) {
        if (theme[key] !== undefined && (!Number.isInteger(theme[key]) || Number(theme[key]) < 0 || Number(theme[key]) > 3)) throw new PageToolError('invalid_input', `${key} must be an integer from 0 to 3.`);
      }
      patch[THEME_PROPERTY_ID] = theme;
    }
  }
  if (input.cover !== undefined) {
    if (input.cover === null) patch[COVER_PROPERTY_ID] = null;
    else {
      const cover = record(input.cover);
      if (!cover || (cover.kind !== 'gradient' && cover.kind !== 'image')) throw new PageToolError('invalid_input', 'cover must be a gradient or image cover.');
      if (cover.kind === 'gradient' && (typeof cover.css !== 'string' || !cover.css)) throw new PageToolError('invalid_input', 'A gradient cover requires css.');
      if (cover.kind === 'image' && (typeof cover.url !== 'string' || !cover.url)) throw new PageToolError('invalid_input', 'An image cover requires a url.');
      if (cover.position !== undefined && (typeof cover.position !== 'number' || cover.position < 0 || cover.position > 1)) throw new PageToolError('invalid_input', 'cover.position must be between 0 and 1.');
      patch[COVER_PROPERTY_ID] = cover;
    }
  }
  if (Object.keys(patch).length === 0) throw new PageToolError('invalid_input', 'Pass at least one appearance setting.');
  return patch;
}

export function validatePageProperties(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === BACKLINKS_PROPERTY_ID) throw new PageToolError('invalid_input', 'Backlinks are computed and cannot be set.');
    if (key === OWNER_PROPERTY_ID) {
      if (value !== null && typeof value !== 'string') throw new PageToolError('invalid_input', 'sys_owner must be a string or null.');
    } else if (key === VERIFICATION_PROPERTY_ID) {
      if (value !== null) {
        const v = record(value) as (Json & VerificationValue) | null;
        if (!v || typeof v.verified !== 'boolean' || ['by', 'at', 'expiresAt'].some((field) => v[field] !== undefined && v[field] !== null && typeof v[field] !== 'string')) {
          throw new PageToolError('invalid_input', 'sys_verification has an invalid value.');
        }
      }
    } else {
      throw new PageToolError('invalid_input', `Unknown page property "${key}".`);
    }
    out[key] = value;
  }
  if (Object.keys(out).length === 0) throw new PageToolError('invalid_input', 'Pass at least one page property.');
  return out;
}

const page = async (store: PageToolStore, pageId: string): Promise<StoredPage> => {
  const found = await store.getPage(pageId);
  if (!found) throw new PageToolError('page_not_found', 'Page not found.');
  return found;
};

export async function setPageAppearanceTool(store: PageToolStore, pageId: string, input: PageAppearanceInput): Promise<StoredPage> {
  await page(store, pageId);
  const updated = await store.setPageProperties(pageId, buildPageAppearancePatch(input));
  if (!updated) throw new PageToolError('page_not_found', 'Page not found.');
  return updated;
}

export async function getPagePropertiesTool(store: Pick<PageToolStore, 'getPage'>, pageId: string): Promise<Record<string, unknown>> {
  return (await page(store as PageToolStore, pageId)).properties ?? {};
}

export async function setPagePropertiesTool(store: PageToolStore, pageId: string, properties: Record<string, unknown>): Promise<StoredPage> {
  await page(store, pageId);
  const updated = await store.setPageProperties(pageId, validatePageProperties(properties));
  if (!updated) throw new PageToolError('page_not_found', 'Page not found.');
  return updated;
}

export async function movePageTool(store: PageToolStore, input: {pageId: string; parentId: string | null; position?: {index: number} | {afterId: string}}): Promise<StoredPage> {
  await page(store, input.pageId);
  const pages = await store.listPages();
  if (input.parentId === input.pageId) throw new PageToolError('invalid_move', 'A page cannot be its own parent.');
  if (input.parentId !== null && !pages.some((candidate) => candidate.id === input.parentId)) throw new PageToolError('parent_not_found', 'Parent page not found.');
  const byId = new Map(pages.map((candidate) => [candidate.id, candidate]));
  for (let ancestor = input.parentId; ancestor !== null; ancestor = byId.get(ancestor)?.parentId ?? null) {
    if (ancestor === input.pageId) throw new PageToolError('invalid_move', 'The move would create a cycle.');
  }
  const siblings = pages.filter((candidate) => candidate.id !== input.pageId && (candidate.parentId ?? null) === input.parentId).map(({id}) => id);
  if (input.position && 'afterId' in input.position) {
    const at = siblings.indexOf(input.position.afterId);
    if (at < 0) throw new PageToolError('invalid_input', 'afterId must name a sibling under the destination parent.');
    siblings.splice(at + 1, 0, input.pageId);
  } else {
    const index = input.position && 'index' in input.position ? input.position.index : siblings.length;
    if (!Number.isInteger(index) || index < 0 || index > siblings.length) throw new PageToolError('invalid_input', 'position.index is outside the destination sibling range.');
    siblings.splice(index, 0, input.pageId);
  }
  const moved = await store.movePage(input.pageId, {parentId: input.parentId, orderedIds: siblings});
  if (!moved) throw new PageToolError('invalid_move', 'The move was refused.');
  return moved;
}
