/**
 * Fractional order keys — re-exported from `@book.dev/sdk` (API-3).
 *
 * The algebra itself moved to `packages/sdk/src/orderKeys.ts` so the editor's
 * CRDT table ops (`model.ts`) and the SERVER-SIDE snapshot table ops
 * (`packages/sdk/src/tableSnapshot.ts`, driven by the MCP tools) mint IDENTICAL
 * keys for the same structural edit. Two implementations of the same fraction
 * arithmetic would let the two paths drift apart silently — a table migrated by
 * MCP would order differently from one migrated by the editor.
 *
 * This module stays as the editor's import site (nothing under `blockeditor/`
 * changes its imports) and re-exports the shared implementation verbatim.
 */
export {ORDER_KEY_REBALANCE_LENGTH, isOrderKey, compareOrderKeys, keyBetween, keysBetween} from '@book.dev/sdk';
