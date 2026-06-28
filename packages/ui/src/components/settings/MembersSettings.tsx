import {useCallback, useEffect, useMemo, useState, type ReactNode} from 'react';
import {Loader2, Trash2, UserPlus} from 'lucide-react';
import type {InstanceInfo, Member, MemberRole, MemberStatus, Principal} from '@book.dev/sdk';
import {useData} from '@/data';
import {useConfirm, useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {IconButton} from '@/components/ui/icon-button';
import {Select} from '@/components/ui/select';
import {SettingsScreen, SettingsSection} from '@/components/settings/primitives';
import {cn} from '@/lib/utils';
import type {TKey} from '@/i18n';

/**
 * The instance member roster (OB-204). Lists who has a role on this workspace,
 * and — for a manager (loopback owner / admin / claimed owner, or any writer on a
 * still-unclaimed instance) — lets them invite by email or handle, change a
 * member's role, and remove access. All driven by the OB-191 roster API
 * (`listMembers`/`inviteMember`/`updateMember`/`removeMember`).
 *
 * The gate is the server's own: every roster route is `requireCreate`-gated
 * (write at the instance default), so a successful {@link DataClient.listMembers}
 * IS the manage signal. A non-manager 403s the list and sees a calm read-only
 * notice (hide-not-break); the server stays the source of truth and re-enforces
 * every mutation. A server that predates multi-user (no `/api/instance`) degrades
 * to an "unavailable" note rather than a broken tab.
 */

/** `true` when the SDK's wrapped error reads as a 401/403 (a manage refusal). */
function isForbidden(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e);
  return /\b40[13]\b|forbidden|unauthor/i.test(raw);
}

/**
 * The server's human-written detail out of the SDK's wrapper. `request()` throws
 * `Error("OpenBook request failed (<status> <text>): <detail>")`; for an invite
 * the `<detail>` is the resolver's actionable line (e.g. "Invite by email, or by
 * subject"), so we surface that rather than the noisy prefix.
 */
function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/OpenBook request failed \([^)]*\)(?::\s*([\s\S]*))?$/);
  return (m?.[1] ?? raw).trim();
}

/** Does this roster row describe the current principal (subject XOR persona email)? */
function isSelf(member: Member, you: Principal): boolean {
  if (member.subject && member.subject === you.subject) return true;
  return !!member.email && !!you.email && member.email === you.email.toLowerCase();
}

const STATUS_LABEL: Record<MemberStatus, TKey> = {
  active: 'members.statusActive',
  invited: 'members.statusInvited',
  suspended: 'members.statusSuspended',
};

const STATUS_TONE: Record<MemberStatus, string> = {
  active: 'text-emerald-600 dark:text-emerald-400',
  invited: 'text-amber-600 dark:text-amber-400',
  suspended: 'text-muted-foreground',
};

// A leading status dot, mirroring the connection panel's `● live` / `○ connecting`
// house pattern: filled when active, hollow while invited/suspended. The colour
// comes from STATUS_TONE on the wrapping label.
const STATUS_DOT: Record<MemberStatus, string> = {
  active: '●',
  invited: '○',
  suspended: '○',
};

/** A small role picker (admin/viewer) shared by the invite form and each row. */
function RoleSelect({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: MemberRole;
  onChange: (role: MemberRole) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const {t} = useTranslation();
  return (
    <Select
      value={value}
      aria-label={ariaLabel}
      inputSize="sm"
      wrapperClassName="w-[120px]"
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as MemberRole)}
    >
      <option value="admin">{t('members.roleAdmin')}</option>
      <option value="viewer">{t('members.roleViewer')}</option>
    </Select>
  );
}

/**
 * Wrap a disabled control so its guard `reason` surfaces as a hover tooltip. A
 * disabled `<button>` suppresses its own native `title` (and the icon button
 * sets `pointer-events: none`), so the tooltip has to live on an enabled
 * wrapper. With no `reason` (the control is actionable) the child renders
 * untouched, so the actionable rows keep their existing layout.
 */
function GuardTip({reason, children}: {reason?: string; children: ReactNode}) {
  if (!reason) return <>{children}</>;
  return (
    <span className="inline-flex" title={reason}>
      {children}
    </span>
  );
}

export default function MembersSettings() {
  const client = useData();
  const {t} = useTranslation();
  const confirm = useConfirm();

  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [invitee, setInvitee] = useState('');
  const [inviteRole, setInviteRole] = useState<MemberRole>('viewer');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Which row is mid-mutation (role change / remove), to disable just that row.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    let next: InstanceInfo;
    try {
      next = await client.getInstanceInfo();
    } catch {
      setUnavailable(true);
      setCanManage(false);
      return;
    }
    setInfo(next);
    setUnavailable(false);
    try {
      const list = await client.listMembers();
      setMembers(list);
      setCanManage(true);
    } catch (e) {
      // A 403 means "not a manager" — show the read-only notice, not an error.
      if (isForbidden(e)) {
        setCanManage(false);
        setMembers(null);
      } else {
        // A non-403 (500 / network) isn't a manage refusal — optimistically
        // assume manager so the surface stays usable; the server re-enforces on
        // submit, so a true non-manager is still blocked on every mutation.
        setCanManage(true);
        setLoadError(cleanError(e));
      }
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitInvite = useCallback(async () => {
    const value = invitee.trim();
    if (!value || inviting) return;
    setInviting(true);
    setInviteError(null);
    try {
      await client.inviteMember(value, {role: inviteRole});
      setInvitee('');
      await refresh();
    } catch (e) {
      // Surface the resolver's own message for a bare/unresolvable handle.
      setInviteError(cleanError(e));
    } finally {
      setInviting(false);
    }
  }, [client, invitee, inviteRole, inviting, refresh]);

  const changeRole = useCallback(
    async (member: Member, role: MemberRole) => {
      if (role === member.role) return;
      setBusyId(member.id);
      setActionError(null);
      try {
        await client.updateMember(member.id, {role});
        await refresh();
      } catch (e) {
        setActionError(cleanError(e));
      } finally {
        setBusyId(null);
      }
    },
    [client, refresh],
  );

  const removeMember = useCallback(
    async (member: Member, name: string) => {
      const ok = await confirm({
        title: t('members.removeTitle', {name}),
        description: t('members.removeBody'),
        confirmText: t('members.removeConfirm'),
        destructive: true,
      });
      if (!ok) return;
      setBusyId(member.id);
      setActionError(null);
      try {
        await client.removeMember(member.id);
        await refresh();
      } catch (e) {
        setActionError(cleanError(e));
      } finally {
        setBusyId(null);
      }
    },
    [client, confirm, refresh, t],
  );

  const youLine = useMemo(() => {
    if (!info) return null;
    const you = info.you;
    return you.kind === 'user' ? t('members.youUser', {name: you.name || you.subject}) : t('members.youGuest');
  }, [info, t]);

  return (
    <SettingsScreen title={t('members.title')} description={t('members.description')}>
      {unavailable ? (
        <p className="text-sm text-muted-foreground">{t('members.unavailable')}</p>
      ) : canManage === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('members.loading')}
        </p>
      ) : (
        <>
          {youLine && <p className="text-sm text-muted-foreground">{youLine}</p>}

          {canManage === false ? (
            <div className="rounded-md border border-border bg-muted/40 px-3.5 py-3">
              <p className="text-sm font-medium">{t('members.lockedTitle')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('members.locked')}</p>
            </div>
          ) : (
            <>
              {/* Invite */}
              <SettingsSection title={t('members.inviteLabel')} description={t('members.inviteHint')}>
                <div className="flex items-start gap-2">
                  <Input
                    id="member-invitee"
                    inputSize="sm"
                    className="flex-1"
                    placeholder={t('members.invitePlaceholder')}
                    value={invitee}
                    disabled={inviting}
                    aria-label={t('members.inviteLabel')}
                    onChange={(e) => setInvitee(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void submitInvite();
                      }
                    }}
                  />
                  <RoleSelect
                    value={inviteRole}
                    ariaLabel={t('members.inviteRole')}
                    disabled={inviting}
                    onChange={setInviteRole}
                  />
                  <Button size="sm" onClick={() => void submitInvite()} disabled={inviting || !invitee.trim()}>
                    {inviting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <UserPlus className="mr-1.5 h-4 w-4" />
                        {t('members.invite')}
                      </>
                    )}
                  </Button>
                </div>
                {inviteError && (
                  <p role="alert" aria-live="assertive" className="text-xs text-destructive">
                    {t('members.inviteError', {error: inviteError})}
                  </p>
                )}
              </SettingsSection>

              {/* Roster */}
              <SettingsSection title={t('members.listLabel')}>
                {loadError ? (
                  <div className="flex flex-col items-start gap-2">
                    <p className="text-sm text-destructive">{t('members.loadError', {error: loadError})}</p>
                    <Button variant="outline" size="sm" onClick={() => void refresh()}>
                      {t('members.retry')}
                    </Button>
                  </div>
                ) : members === null ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('members.loading')}
                  </p>
                ) : members.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('members.empty')}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {members.map((member) => {
                      const name = member.email || member.subject || member.id;
                      const isOwnerRow = !!info?.ownerSubject && member.subject === info.ownerSubject;
                      const self = !!info && isSelf(member, info.you);
                      // Don't let a manager lock themselves (or the owner) out from
                      // here — the server may also refuse, but guard the UI first.
                      const locked = isOwnerRow || self;
                      const rowBusy = busyId === member.id;
                      // When a control is guard-disabled, say *why* at the control
                      // (the owner reason wins when you are the owner).
                      const roleReason = locked
                        ? t(isOwnerRow ? 'members.lockedRoleOwner' : 'members.lockedRoleSelf')
                        : undefined;
                      const removeReason = locked
                        ? t(isOwnerRow ? 'members.lockedRemoveOwner' : 'members.lockedRemoveSelf')
                        : undefined;
                      return (
                        <li
                          key={member.id}
                          className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-sm" title={name}>
                                {name}
                              </span>
                              {isOwnerRow && (
                                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                  {t('members.owner')}
                                </span>
                              )}
                              {self && !isOwnerRow && (
                                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                  {t('members.you')}
                                </span>
                              )}
                            </span>
                            <span className={cn('flex items-center gap-1 text-xs', STATUS_TONE[member.status])}>
                              <span aria-hidden="true">{STATUS_DOT[member.status]}</span>
                              {t(STATUS_LABEL[member.status])}
                            </span>
                          </span>
                          <GuardTip reason={roleReason}>
                            <RoleSelect
                              value={member.role}
                              ariaLabel={t('members.changeRole', {name})}
                              disabled={locked || rowBusy}
                              onChange={(role) => void changeRole(member, role)}
                            />
                          </GuardTip>
                          <GuardTip reason={removeReason}>
                            <IconButton
                              size="sm"
                              aria-label={t('members.remove', {name})}
                              title={removeReason ?? t('members.remove', {name})}
                              disabled={locked || rowBusy}
                              onClick={() => void removeMember(member, name)}
                            >
                              {rowBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            </IconButton>
                          </GuardTip>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {actionError && (
                  <p role="alert" aria-live="assertive" className="text-xs text-destructive">
                    {t('members.actionError', {error: actionError})}
                  </p>
                )}
              </SettingsSection>
            </>
          )}
        </>
      )}
    </SettingsScreen>
  );
}
