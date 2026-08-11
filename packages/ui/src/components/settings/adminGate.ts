import {useEffect, useState} from 'react';
import type {InstanceInfo} from '@book.dev/sdk';
import {useOptionalData} from '@/data/DataProvider';

/**
 * Shared admin-gate helpers for the settings admin surfaces (MCP, AI usage,
 * agent tokens). These used to be triplicated verbatim across
 * `McpSettings` / `AiUsageSettings` / `AgentTokensSettings`; they now live here
 * so the panels AND the settings rail agree on who counts as an admin.
 */

/** `true` when the SDK's wrapped error reads as a 401/403 (an admin refusal). */
export function isForbidden(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e);
  return /\b40[13]\b|forbidden|unauthor/i.test(raw);
}

/** Strip the SDK transport wrapper while preserving useful server detail. */
export function cleanError(e: unknown, generic: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  const match = raw.match(/OpenBook request failed \([^)]*\)(?::\s*([\s\S]*))?$/);
  if (match) return match[1]?.trim() || generic;
  return raw.trim() || generic;
}

/** Best-effort: is the current principal an instance admin (owner/admin/local)? */
export function isAdminRole(info: InstanceInfo): boolean {
  const you = info.you;
  if (info.localOwner === true) return true;
  if (you.verifiedVia === 'local') return true;
  if (info.ownerSubject && you.verifiedVia === 'jws' && you.subject === info.ownerSubject) return true;
  return info.youRole === 'owner' || info.youRole === 'admin';
}

/**
 * Whether this principal may write owner-only instance policy.
 *
 * `claimed` is the decisive guest-safe signal: `ownerSubject` is redacted to
 * `null` for anonymous callers on a claimed instance, while an explicitly
 * unclaimed instance allows its first caller to write policy. A legacy response
 * without either signal keeps the old single-user allowance.
 */
export function isInstanceOwner(info: InstanceInfo): boolean {
  return (
    info.claimed === false ||
    (info.claimed === undefined && !info.ownerSubject) ||
    info.localOwner === true ||
    info.you.verifiedVia === 'local' ||
    info.youRole === 'owner' ||
    (info.ownerSubject != null && info.ownerSubject === info.you.subject)
  );
}

/**
 * Whether this principal may see the admin-only "Agents & AI admin" tab.
 *
 * `null` while the instance probe is in flight. Resolves `false` only for a
 * *claimed* instance where you are demonstrably not an admin (`ownerSubject`
 * set and {@link isAdminRole} false) — the one case we can decide client-side.
 * On an unclaimed (single-user) instance the writer is the admin-equivalent, and
 * an unreachable/legacy server is inconclusive, so both resolve `true` and let
 * the panels' own server-side gates (`requireInstanceAdmin`) stay authoritative.
 *
 * The rail shows the tab only on an explicit `true`, so a confirmed non-admin
 * never sees it; the individual panels still self-gate as defence in depth for a
 * deep-link straight to the tab.
 */
export function useIsSettingsAdmin(): boolean | null {
  // Read the data context optionally so the settings rail still renders in reduced
  // harnesses (unit tests, previews) without a <DataProvider>; the real app always
  // supplies one. Without a client we can't probe, so the tab stays hidden.
  const client = useOptionalData();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client
      .getInstanceInfo()
      .then((info) => {
        if (cancelled) return;
        setIsAdmin(!info.ownerSubject || isAdminRole(info));
      })
      .catch(() => {
        // Inconclusive (legacy/unreachable server): assume admin-equivalent so the
        // real owner of a single-user instance isn't hidden from their own tab.
        if (!cancelled) setIsAdmin(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return isAdmin;
}
