import type {PageSnapshot} from '@book.dev/sdk';
import {
  createDoc,
  decodeSnapshot,
  docToJSON,
  encodeSnapshot,
  type BlockDocSnapshot,
  type BlockJSON,
} from '../blockeditor/model';

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;

/** Clone a form payload while removing the write capability at every depth. */
function stripSubmissionKey(value: unknown): {value: unknown; stripped: boolean} {
  if (Array.isArray(value)) {
    let stripped = false;
    const next = value.map((entry) => {
      const result = stripSubmissionKey(entry);
      stripped ||= result.stripped;
      return result.value;
    });
    return stripped ? {value: next, stripped} : {value, stripped};
  }
  const source = record(value);
  if (!source) return {value, stripped: false};
  let stripped = false;
  const next: JsonRecord = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === 'submissionKey') {
      stripped = true;
      continue;
    }
    const result = stripSubmissionKey(entry);
    stripped ||= result.stripped;
    next[key] = result.value;
  }
  return stripped ? {value: next, stripped} : {value, stripped};
}

function stripBlockSubmissionKeys(blocks: BlockJSON[]): {blocks: BlockJSON[]; stripped: boolean} {
  let stripped = false;
  const next = blocks.map((block) => {
    let result = block;
    if (block.type === 'form' && block.props) {
      const props = stripSubmissionKey(block.props);
      if (props.stripped) {
        stripped = true;
        result = {...result, props: props.value as JsonRecord};
      }
    }
    if (block.children) {
      const children = stripBlockSubmissionKeys(block.children);
      if (children.stripped) {
        stripped = true;
        result = {...result, children: children.blocks};
      }
    }
    return result;
  });
  return stripped ? {blocks: next, stripped} : {blocks, stripped};
}

function sanitizeEditorJsAlias(editorjs: unknown): {editorjs: unknown; stripped: boolean} {
  const source = record(editorjs);
  if (!source || !Array.isArray(source.blocks)) return {editorjs, stripped: false};
  let stripped = false;
  const blocks = source.blocks.map((value) => {
    const block = record(value);
    if (!block || block.type !== 'form') return value;
    const data = stripSubmissionKey(block.data);
    if (!data.stripped) return value;
    stripped = true;
    return {...block, data: data.value};
  });
  return stripped
    ? {editorjs: {...source, blocks}, stripped}
    : {editorjs, stripped};
}

/**
 * Remove form submission capabilities from a snapshot destined for a circulated
 * export. This is deliberately an export-only clone: the live page keeps its
 * key. A sanitized copy mints its own key on island import (see formBlock.ts),
 * so importing an export never reconnects it to the source form's write gate.
 */
export function sanitizeSnapshotForExport(snapshot: PageSnapshot): PageSnapshot {
  const alias = sanitizeEditorJsAlias(snapshot.editorjs);
  let blockdoc = snapshot.blockdoc;
  let blockdocStripped = false;
  if (record(blockdoc)) {
    // Rebuild both projections of the CRDT snapshot. Editing only `.blocks`
    // would leave the plaintext capability recoverable from the Yjs update.
    const json = docToJSON(decodeSnapshot(blockdoc as BlockDocSnapshot));
    const sanitized = stripBlockSubmissionKeys(json);
    if (sanitized.stripped) {
      blockdoc = encodeSnapshot(createDoc(sanitized.blocks));
      blockdocStripped = true;
    }
  }
  if (!alias.stripped && !blockdocStripped) return snapshot;
  return {
    ...snapshot,
    ...(alias.stripped ? {editorjs: alias.editorjs as PageSnapshot['editorjs']} : {}),
    ...(blockdocStripped ? {blockdoc} : {}),
  };
}
