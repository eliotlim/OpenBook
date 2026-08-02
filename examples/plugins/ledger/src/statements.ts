import {formatAmount, negateAmount, sumAmounts} from '@book.dev/plugin-sdk';
import {
  accountBalances,
  countDrafts,
  describeCulprits,
  findUnbalancedEntries,
  formatWithSide,
  isReported,
  type ReportAccount,
  type ReportAccountType,
  type ReportTransaction,
  type UnbalancedEntry,
} from './reports';

/**
 * Pure statement folds (LGR-9) — the balance sheet and the income statement,
 * plus the colon-hierarchy rollup both of them are drawn on. No React, no IO,
 * no host calls; a sibling of `./reports` and held to exactly its rules.
 *
 * MONEY DISCIPLINE (unchanged from LGR-8): amounts are SIGNED INTEGER MINOR
 * UNITS, every one of them added with `sumAmounts` / flipped with
 * `negateAmount` / rendered with `formatAmount`. No `Number()`, no
 * `parseFloat`, no `Math.*`, no `+`/`-` on an amount — here or in the view.
 *
 * SIGN CONVENTION (unchanged): every `*Minor` in this module is DEBIT-POSITIVE,
 * the ledger's own convention, even where the statement's customary
 * presentation is credit-positive. Liabilities, equity and revenue therefore
 * come out NEGATIVE on a healthy book, and the blocks render them with the same
 * `formatWithSide` grammar the trial balance and register already speak
 * (`1,250.00 Cr`). Re-signing per section would have produced a second notation
 * for the same fact, and — worse — would have hidden a contra item: a negative
 * asset inside an "assets, positive" column reads as a rendering bug, whereas
 * `50.00 Cr` in a column of `Dr`s is instantly legible as the anomaly it is.
 *
 * DATES ARE INCLUSIVE at both ends and compared as ISO `YYYY-MM-DD` STRINGS.
 * Lexicographic order on a zero-padded ISO date is calendar order, so no `Date`
 * object (and no timezone) is ever involved in deciding what is in a period —
 * a report whose contents shifted with the reader's timezone would be a bug the
 * reader could never reproduce.
 */

// ── Colon hierarchy ───────────────────────────────────────────────────────────

/** The separator that makes `Expenses:Hosting` a child of `Expenses`. */
export const HIERARCHY_SEPARATOR = ':';

/**
 * The label a parent's own postings get when it is ALSO a real account.
 *
 * A SENTENCE, not a term of art. "Direct postings" is plan-file idiom, and this
 * row is the one place a reader has to understand that a parent can hold money
 * of its own — the plain-English gloss used to exist but was routed exclusively
 * to `SrOnly`, i.e. the readers who could SEE the row were the only ones who
 * could not read the explanation.
 */
export function directPostingsLabel(label: string): string {
  return `Posted to ${label} itself`;
}

/** One account to place in the tree, with the balance it contributes. */
export interface HierarchyItem {
  accountId: string;
  /** The account's full hierarchical name, e.g. `Expenses:Hosting`. */
  name: string;
  /** Signed, debit-positive. */
  minor: number;
}

export interface HierarchyNode {
  /** The full colon path to this node, e.g. `Expenses:Hosting`. */
  path: string;
  /** This node's own segment, e.g. `Hosting`. */
  label: string;
  /** 0 at the root of a section. */
  depth: number;
  /** The account whose name is EXACTLY this path — `null` for a pure grouping node. */
  accountId: string | null;
  /**
   * The balance of the account at exactly this path, `0` when there is none.
   * This is the LEAF-ONLY figure: it counts nothing from the children.
   */
  ownMinor: number;
  /** `ownMinor` plus every descendant's `ownMinor` — what a collapsed parent shows. */
  rolledMinor: number;
  children: HierarchyNode[];
  /** How many real accounts sit at or below this node. */
  accountCount: number;
  /**
   * This path is a real account AND has children — see the rule in
   * {@link buildHierarchy}. The blocks render an explicit `Direct postings` row
   * for these so the parent's own money is never confused with the subtotal.
   */
  parentIsAccount: boolean;
}

/**
 * Split a hierarchical account name into its segments.
 *
 * Segments are trimmed and empty ones dropped, so `Assets: Bank` and
 * `Assets:Bank` are the same place in the tree and a stray trailing colon does
 * not create an unnamed child. A name that is nothing BUT separators keeps its
 * raw text as a single segment rather than vanishing from the statement — an
 * account whose balance disappeared because its name was odd is exactly the
 * silent data loss these reports exist to prevent.
 */
export function splitAccountPath(name: string): string[] {
  const segments = name
    .split(HIERARCHY_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  if (segments.length > 0) return segments;
  const raw = name.trim();
  return [raw === '' ? '(unnamed account)' : raw];
}

interface MutableNode extends Omit<HierarchyNode, 'children'> {
  children: Map<string, MutableNode>;
  /** Every amount posted at exactly this path, summed once at the end. */
  ownAmounts: number[];
}

/**
 * Fold a flat list of accounts-with-balances into the colon tree.
 *
 * THE PARENT-IS-ALSO-AN-ACCOUNT RULE (the case that has to be decided, not
 * discovered): when both `Expenses` and `Expenses:Hosting` exist as real
 * accounts, `Expenses` is ONE node that is both a group and an account. Its
 * `ownMinor` is what was posted to `Expenses` itself and its `rolledMinor` adds
 * the children on top, so the account is counted EXACTLY ONCE — never dropped
 * (which would lose money from the statement) and never double-counted (which
 * would inflate the section and break the accounting identity). The node is
 * flagged `parentIsAccount`, and {@link flattenHierarchy} emits a separate
 * `Direct postings` row for its `ownMinor` when it is expanded, because a
 * parent row showing a rolled subtotal and a parent row showing its own balance
 * are two different numbers that must not share one line.
 *
 * INVARIANT, and the reason the rule above is the only safe one:
 *   Σ roots.rolledMinor === Σ items.minor
 * — proved by {@link hierarchyRolledTotal} vs {@link hierarchyLeafTotal}.
 *
 * DUPLICATE NAMES: two accounts may legally share a name. They collapse into
 * one node whose `ownMinor` sums both (money is preserved — the invariant above
 * holds); `accountId` names the lowest id, deterministically.
 */
export function buildHierarchy(items: readonly HierarchyItem[]): HierarchyNode[] {
  const roots = new Map<string, MutableNode>();

  const ensure = (siblings: Map<string, MutableNode>, label: string, path: string, depth: number): MutableNode => {
    const existing = siblings.get(label);
    if (existing) return existing;
    const created: MutableNode = {
      path,
      label,
      depth,
      accountId: null,
      ownMinor: 0,
      rolledMinor: 0,
      children: new Map(),
      accountCount: 0,
      parentIsAccount: false,
      ownAmounts: [],
    };
    siblings.set(label, created);
    return created;
  };

  for (const item of items) {
    const segments = splitAccountPath(item.name);
    let siblings = roots;
    let path = '';
    let node: MutableNode | null = null;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const label = segments[depth];
      path = depth === 0 ? label : `${path}${HIERARCHY_SEPARATOR}${label}`;
      node = ensure(siblings, label, path, depth);
      siblings = node.children;
    }
    if (node === null) continue;
    node.ownAmounts.push(item.minor);
    node.accountId = node.accountId === null || item.accountId < node.accountId ? item.accountId : node.accountId;
  }

  const freeze = (node: MutableNode): HierarchyNode => {
    const children = [...node.children.values()].map(freeze).sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
    const ownMinor = sumAmounts(node.ownAmounts);
    return {
      path: node.path,
      label: node.label,
      depth: node.depth,
      accountId: node.accountId,
      ownMinor,
      rolledMinor: sumAmounts([ownMinor, ...children.map((child) => child.rolledMinor)]),
      children,
      accountCount: (node.accountId === null ? 0 : node.ownAmounts.length) + children.reduce((n, child) => n + child.accountCount, 0),
      parentIsAccount: node.accountId !== null && children.length > 0,
    };
  };

  return [...roots.values()].map(freeze).sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
}

/** Σ of the roots' rolled totals — the section total, counted through the tree. */
export function hierarchyRolledTotal(nodes: readonly HierarchyNode[]): number {
  return sumAmounts(nodes.map((node) => node.rolledMinor));
}

/** Every real account in the tree, in path order — the LEAF-ONLY view. */
export function hierarchyLeaves(nodes: readonly HierarchyNode[]): Array<{path: string; accountId: string; ownMinor: number; accountCount: number}> {
  const out: Array<{path: string; accountId: string; ownMinor: number; accountCount: number}> = [];
  const walk = (node: HierarchyNode): void => {
    if (node.accountId !== null) out.push({path: node.path, accountId: node.accountId, ownMinor: node.ownMinor, accountCount: 1});
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

/**
 * Σ of the real accounts' own balances — the same section total, counted
 * WITHOUT the tree. Equal to {@link hierarchyRolledTotal} by construction; the
 * two are computed by different routes precisely so a test can pin the rollup.
 */
export function hierarchyLeafTotal(nodes: readonly HierarchyNode[]): number {
  return sumAmounts(hierarchyLeaves(nodes).map((leaf) => leaf.ownMinor));
}

/** Every path in the tree that has children — the set a "collapse all" needs. */
export function hierarchyParentPaths(nodes: readonly HierarchyNode[]): string[] {
  const out: string[] = [];
  const walk = (node: HierarchyNode): void => {
    if (node.children.length > 0) out.push(node.path);
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

/** One rendered line of a statement section. */
export interface HierarchyRow {
  /** Stable React key — a `direct` row shares its node's path, so it needs its own. */
  key: string;
  path: string;
  label: string;
  depth: number;
  /** The amount this line shows: a node's ROLLED subtotal, or a direct row's own balance. */
  minor: number;
  /** `direct` is the parent's own postings, split out from its subtotal. */
  kind: 'node' | 'direct';
  hasChildren: boolean;
  /** Children exist and are hidden — the row is a closed disclosure. */
  collapsed: boolean;
  accountId: string | null;
  accountCount: number;
  parentIsAccount: boolean;
}

/**
 * The tree as display rows, depth-first, with collapsed subtrees omitted.
 *
 * A parent ALWAYS shows its rolled subtotal, collapsed or not: expanding is a
 * disclosure of the breakdown, never a change of the figure — a subtotal that
 * moved when you opened a twisty would make the report untrustworthy.
 *
 * A `parentIsAccount` node emits a `Direct postings` child row whenever it is
 * expanded, INCLUDING when that balance is zero: the account exists, and a
 * reader who cannot see it would conclude the parent is a pure grouping node
 * and that its subtotal is entirely its children's.
 */
export function flattenHierarchy(nodes: readonly HierarchyNode[], collapsed: ReadonlySet<string> = new Set<string>()): HierarchyRow[] {
  const out: HierarchyRow[] = [];
  const walk = (node: HierarchyNode): void => {
    const hasChildren = node.children.length > 0;
    const isCollapsed = hasChildren && collapsed.has(node.path);
    out.push({
      // Namespaced by KIND, so the key never has to encode a separator that an
      // account name might legally contain. The server's name rule only forbids
      // blank colon-segments — a name may hold a newline — so an account called
      // `X\ndirect` would have collided with node `X`'s direct row under any
      // separator scheme. There is now no separator to collide on.
      key: `node:${node.path}`,
      path: node.path,
      label: node.label,
      depth: node.depth,
      minor: node.rolledMinor,
      kind: 'node',
      hasChildren,
      collapsed: isCollapsed,
      accountId: node.accountId,
      accountCount: node.accountCount,
      parentIsAccount: node.parentIsAccount,
    });
    if (!hasChildren || isCollapsed) return;
    if (node.parentIsAccount) {
      out.push({
        key: `direct:${node.path}`,
        path: node.path,
        label: directPostingsLabel(node.label),
        depth: node.depth + 1,
        minor: node.ownMinor,
        kind: 'direct',
        hasChildren: false,
        collapsed: false,
        accountId: node.accountId,
        accountCount: 1,
        parentIsAccount: false,
      });
    }
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

/** The flat, accounts-only view — the same money with no grouping nodes at all. */
export function leafRows(nodes: readonly HierarchyNode[]): HierarchyRow[] {
  return hierarchyLeaves(nodes).map((leaf) => ({
    key: `node:${leaf.path}`,
    path: leaf.path,
    label: leaf.path,
    depth: 0,
    minor: leaf.ownMinor,
    kind: 'node' as const,
    hasChildren: false,
    collapsed: false,
    accountId: leaf.accountId,
    accountCount: 1,
    parentIsAccount: false,
  }));
}

// ── Date scoping ──────────────────────────────────────────────────────────────

/** ISO `YYYY-MM-DD`, or `null`/`''` for "no bound". */
export type DateBound = string | null | undefined;

const bound = (value: DateBound): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Transactions dated ON OR BEFORE `asOf` — the balance sheet's scope.
 * INCLUSIVE: a posting made on the as-of date is part of that day's position,
 * which is what "as of 31 December" means to everyone who reads one.
 */
export function transactionsAsOf(transactions: readonly ReportTransaction[], asOf: DateBound): ReportTransaction[] {
  const at = bound(asOf);
  return at === null ? [...transactions] : transactions.filter((tx) => tx.date <= at);
}

/** Transactions inside `[from, to]` — the income statement's scope. Both ends inclusive. */
export function transactionsInRange(transactions: readonly ReportTransaction[], from: DateBound, to: DateBound): ReportTransaction[] {
  const start = bound(from);
  const end = bound(to);
  return transactions.filter((tx) => (start === null || tx.date >= start) && (end === null || tx.date <= end));
}

/** Transactions STRICTLY BEFORE `from` — the opening position a period opens on. */
export function transactionsBefore(transactions: readonly ReportTransaction[], from: DateBound): ReportTransaction[] {
  const start = bound(from);
  return start === null ? [] : transactions.filter((tx) => tx.date < start);
}

/** The latest date any reported (non-draft) entry carries — `null` on an empty book. */
export function latestReportedDate(transactions: readonly ReportTransaction[]): string | null {
  let latest: string | null = null;
  for (const tx of transactions) {
    if (!isReported(tx)) continue;
    if (latest === null || tx.date > latest) latest = tx.date;
  }
  return latest;
}

/** January 1st of `date`'s year — the "year to date" the income statement opens on. */
export function startOfYear(date: string): string {
  return `${date.slice(0, 4)}-01-01`;
}

/**
 * The year-to-date period ending at the book's latest POSTED entry, or `null` on
 * a book with nothing on it.
 *
 * Not a default (both blocks default to the wall clock — see `defaultAsOf` /
 * `defaultPeriod`): this is the RECOVERY the empty state offers when the
 * defaulted window turns out to hold nothing, so that looking at a stale or
 * future-dated position is an explicit, recorded choice rather than something
 * the report did on the reader's behalf.
 */
export function latestPeriod(transactions: readonly ReportTransaction[]): {from: string; to: string} | null {
  const latest = latestReportedDate(transactions);
  return latest === null ? null : {from: startOfYear(latest), to: latest};
}

/**
 * A CREDIT-POSITIVE quantity (net income, total equity) in the reports' one
 * Dr/Cr grammar. `formatWithSide` is debit-positive, so a credit-positive figure
 * must be flipped before it is spoken or a profit would print as `Dr` — which is
 * the exact opposite of what a profit does to equity. The flip goes through
 * `negateAmount`, never a unary minus.
 */
export function formatCredit(minor: number): string {
  return formatWithSide(negateAmount(minor));
}

// ── Sections ──────────────────────────────────────────────────────────────────

export type SectionKey = 'assets' | 'liabilities' | 'equity' | 'revenue' | 'expenses' | 'unclassified';

export interface StatementSection {
  key: SectionKey;
  title: string;
  /** The section's accounts as a colon tree. */
  nodes: HierarchyNode[];
  /** Signed, debit-positive Σ of the section — equal to `hierarchyRolledTotal(nodes)`. */
  totalMinor: number;
  accountCount: number;
}

const SECTION_TITLE: Record<SectionKey, string> = {
  assets: 'Assets',
  liabilities: 'Liabilities',
  equity: 'Equity',
  revenue: 'Revenue',
  expenses: 'Expenses',
  unclassified: 'Unclassified',
};

/**
 * The balances of every account of these types, as a section.
 *
 * An account with no postings still gets a node (at `0`): a chart of accounts is
 * something you read to check nothing is missing, and an account that silently
 * vanished from a statement because it was quiet is indistinguishable from one
 * that was deleted.
 */
function section(key: SectionKey, accounts: readonly ReportAccount[], balances: ReadonlyMap<string, number>, types: readonly ReportAccountType[]): StatementSection {
  const items: HierarchyItem[] = [];
  for (const account of accounts) {
    if (!types.includes(account.type)) continue;
    items.push({accountId: account.id, name: account.name, minor: balances.get(account.id) ?? 0});
  }
  const nodes = buildHierarchy(items);
  return {key, title: SECTION_TITLE[key], nodes, totalMinor: hierarchyRolledTotal(nodes), accountCount: items.length};
}

/**
 * Balances that belong to no account in the chart — a posting whose account was
 * deleted underneath it. These cannot be classified as an asset, a liability or
 * anything else, so they are disclosed in their OWN section and left OUT of the
 * accounting identity, which is then reported as failing (see
 * {@link describeBalanceSheetAssertion}). Folding them into a side we cannot
 * know would make a damaged book present a satisfied identity.
 */
function unclassifiedSection(accounts: readonly ReportAccount[], balances: ReadonlyMap<string, number>): {section: StatementSection; unknownAccountIds: string[]} {
  const known = new Set(accounts.map((account) => account.id));
  const unknownAccountIds: string[] = [];
  balances.forEach((_balance, accountId) => {
    if (!known.has(accountId)) unknownAccountIds.push(accountId);
  });
  unknownAccountIds.sort();
  const items: HierarchyItem[] = unknownAccountIds.map((accountId) => ({accountId, name: `Deleted account (${accountId})`, minor: balances.get(accountId) ?? 0}));
  const nodes = buildHierarchy(items);
  return {
    section: {key: 'unclassified', title: SECTION_TITLE.unclassified, nodes, totalMinor: hierarchyRolledTotal(nodes), accountCount: items.length},
    unknownAccountIds,
  };
}

// ── Balance sheet ─────────────────────────────────────────────────────────────

/**
 * The synthetic equity line that closes the identity.
 *
 * Revenue and expenses are equity movements that have not been closed out to a
 * capital account yet, so a balance sheet that listed only the equity ACCOUNTS
 * would be out by exactly the period's earnings on every real book. It is
 * deliberately NOT called "retained earnings": the starter chart ships an
 * `Equity:RetainedEarnings` ACCOUNT, and two lines with one name — one real, one
 * computed — is precisely the ambiguity a balance sheet cannot afford.
 */
export const CURRENT_EARNINGS_LABEL = 'Current earnings (revenue less expenses)';

export interface BalanceSheet {
  /** The as-of date the position is stated at (`''` means the whole book). */
  asOf: string;
  assets: StatementSection;
  liabilities: StatementSection;
  /** The equity ACCOUNTS only — `currentEarningsMinor` is separate and not an account. */
  equity: StatementSection;
  unclassified: StatementSection;
  /** Revenue + expenses to `asOf`, signed debit-positive. Negative = a profit. */
  currentEarningsMinor: number;
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  /** Equity accounts + current earnings, signed debit-positive. */
  totalEquityMinor: number;
  /** Liabilities + total equity, signed debit-positive (normally negative). */
  liabilitiesAndEquityMinor: number;
  /** Assets − (liabilities + equity). The whole point of the report is that this is `0`. */
  differenceMinor: number;
  balanced: boolean;
  /** Balances on accounts that no longer exist — why an identity can fail without a broken entry. */
  unclassifiedMinor: number;
  unknownAccountIds: string[];
  /** In-scope entries whose own postings no longer sum to zero. */
  unbalancedEntries: UnbalancedEntry[];
  draftCount: number;
  postedCount: number;
  voidCount: number;
  postingCount: number;
  /** Reported entries dated AFTER `asOf` — excluded by the date, not by state. */
  afterCount: number;
  accountCount: number;
}

export interface BalanceSheetOptions {
  /** Inclusive ISO `YYYY-MM-DD` upper bound. Empty/omitted means the whole book. */
  asOf?: string;
}

/**
 * Fold accounts + transactions into a balance sheet as of a date.
 *
 * The identity it asserts — ASSETS = LIABILITIES + EQUITY — is not a
 * presentation flourish: with `currentEarningsMinor` folded into equity it is
 * algebraically the statement that every in-scope entry sums to zero and every
 * posting still has an account. So a nonzero `differenceMinor` has exactly two
 * possible causes, both of which mean the DATA is damaged, and both of which
 * this fold can name — see {@link describeBalanceSheetAssertion}.
 */
export function buildBalanceSheet(accounts: readonly ReportAccount[], transactions: readonly ReportTransaction[], opts: BalanceSheetOptions = {}): BalanceSheet {
  const asOf = typeof opts.asOf === 'string' ? opts.asOf : '';
  const scoped = transactionsAsOf(transactions, asOf);
  const balances = accountBalances(scoped);

  const assets = section('assets', accounts, balances, ['asset']);
  const liabilities = section('liabilities', accounts, balances, ['liability']);
  const equity = section('equity', accounts, balances, ['equity']);
  const revenue = section('revenue', accounts, balances, ['revenue']);
  const expenses = section('expenses', accounts, balances, ['expense']);
  const {section: unclassified, unknownAccountIds} = unclassifiedSection(accounts, balances);

  const currentEarningsMinor = sumAmounts([revenue.totalMinor, expenses.totalMinor]);
  const totalEquityMinor = sumAmounts([equity.totalMinor, currentEarningsMinor]);
  const liabilitiesAndEquityMinor = sumAmounts([liabilities.totalMinor, totalEquityMinor]);
  const differenceMinor = sumAmounts([assets.totalMinor, liabilitiesAndEquityMinor]);

  const reported = scoped.filter(isReported);
  return {
    asOf,
    assets,
    liabilities,
    equity,
    unclassified,
    currentEarningsMinor,
    totalAssetsMinor: assets.totalMinor,
    totalLiabilitiesMinor: liabilities.totalMinor,
    totalEquityMinor,
    liabilitiesAndEquityMinor,
    differenceMinor,
    balanced: differenceMinor === 0,
    unclassifiedMinor: unclassified.totalMinor,
    unknownAccountIds,
    unbalancedEntries: findUnbalancedEntries(scoped),
    // Drafts are counted IN SCOPE, not across the whole book: this label exists
    // so a reader can reconcile THIS position against what they typed, and a
    // draft dated after the as-of date is not part of this position at all —
    // counting it would put a number on the screen that nothing on the screen
    // could account for. (The register's per-account draft count scopes the same
    // way, for the same reason.)
    draftCount: countDrafts(scoped),
    postedCount: scoped.filter((tx) => tx.state === 'posted').length,
    voidCount: scoped.filter((tx) => tx.state === 'void').length,
    postingCount: reported.reduce((n, tx) => n + tx.postings.length, 0),
    afterCount: asOf === '' ? 0 : transactions.filter((tx) => isReported(tx) && tx.date > asOf).length,
    accountCount: assets.accountCount + liabilities.accountCount + equity.accountCount + unclassified.accountCount,
  };
}

/** The verdict of {@link describeBalanceSheetAssertion}. */
export interface BalanceSheetAssertion {
  ok: boolean;
  /** The sentence to render (loud and specific when `ok` is false). */
  text: string;
  /** The in-scope entries responsible, named — `null` when balanced or unattributable. */
  culprits?: string | null;
  /** The deleted-account cause, named separately — it is a different repair. */
  unclassified?: string | null;
}

/**
 * The assertion the balance sheet exists to make: ASSETS = LIABILITIES + EQUITY.
 *
 * Same reasoning as the trial balance's zero total, and the same refusal to
 * apologise for the UI: every posted entry is balance-enforced by the server, so
 * a nonzero difference means ledger DATA is missing or damaged. The two causes
 * the fold can distinguish are named separately because they are different
 * repairs — an entry that lost a posting is fixed in the entry, a posting on a
 * deleted account is fixed in the chart of accounts.
 *
 * TRUNCATION changes what a ✓ is worth, so it is an input here and not only to
 * the caption: ANY subset of balanced entries balances, which is exactly what
 * makes a ✓ over a partial read uninformative — and this is the line a reader
 * screenshots as proof the books are sound.
 *
 * ZERO POSTINGS is the degenerate limit of that same argument, and the one the
 * today-default (see `defaultAsOf`) turned from a rare state into the OPENING
 * state of every future-dated book: no entries balance VACUOUSLY, so the ✓ would
 * be certifying a read of nothing at all. It is not an alarm either — an empty
 * position is empty, not damaged — so `ok` stays true and only the CLAIM goes.
 */
export function describeBalanceSheetAssertion(sheet: BalanceSheet, opts: {truncated?: boolean} = {}): BalanceSheetAssertion {
  const truncated = opts.truncated === true;
  if (sheet.postingCount === 0) {
    return {
      ok: true,
      text: sheet.asOf === '' ? 'Nothing to balance — no posted entries in this book.' : `Nothing to balance — no posted entries on or before ${sheet.asOf}.`,
      culprits: null,
      // Unreachable while nothing is posted (a stranded balance needs a posting
      // to strand), but gated the same way as every other branch so the chart
      // damage can never be the one thing this function forgets to mention.
      unclassified: describeUnclassified(sheet),
    };
  }
  if (sheet.balanced) {
    const headline = `Balances — assets ${formatWithSide(sheet.totalAssetsMinor)} = liabilities + equity ${formatWithSide(sheet.liabilitiesAndEquityMinor)} ✓`;
    return {
      ok: true,
      text: truncated
        ? `${headline} — across the PARTIAL READ ONLY. Any subset of balanced entries balances, so this ✓ is not evidence that the whole book does.`
        : headline,
      culprits: null,
      // A balanced book can still have a damaged CHART: postings stranded on
      // deleted accounts that happen to net to zero leave the identity intact
      // (see {@link describeUnclassified}), and saying nothing there would put a
      // green ✓ over a book that needs repair.
      unclassified: describeUnclassified(sheet),
    };
  }
  const side = sheet.differenceMinor > 0 ? 'assets exceed liabilities + equity' : 'liabilities + equity exceed assets';
  const magnitude = formatAmount(sheet.differenceMinor > 0 ? sheet.differenceMinor : negateAmount(sheet.differenceMinor));
  const partial = truncated ? ' These figures cover only part of the book, so the difference may be larger still.' : '';
  return {
    ok: false,
    text: `THE BALANCE SHEET DOES NOT BALANCE — ${side} by ${magnitude}. Every posted entry is balance-enforced, so a nonzero difference means ledger data is missing or damaged.${partial}`,
    culprits: describeCulprits(sheet.unbalancedEntries),
    unclassified: describeUnclassified(sheet),
  };
}

/**
 * The deleted-account cause, in words. `null` only when the chart is intact.
 *
 * Gated on whether any account is MISSING, not on whether the stranded money is
 * nonzero: one compound entry posting `+50.00` and `−50.00` across two deleted
 * accounts nets to zero, leaves the identity satisfied, and would otherwise
 * print a green ✓ over a chart of accounts that has lost two rows.
 *
 * When there are ALSO unbalanced entries, this explains why the named figures do
 * not add up to the headline — the excluded balance moves the difference the
 * other way. A reader who tries that sum and fails concludes the report cannot
 * add, which is the one thing it must never look like.
 */
export function describeUnclassified(sheet: BalanceSheet): string | null {
  const count = sheet.unknownAccountIds.length;
  if (count === 0) return null;
  const accounts = count === 1 ? '1 account was deleted' : `${count} accounts were deleted`;
  const it = count === 1 ? 'it' : 'them';
  if (sheet.unclassifiedMinor === 0) {
    return `${accounts} while postings still referenced ${it}. Those postings net to ${formatAmount(0)}, so the identity above is unaffected — but the chart of accounts is damaged and the money has nowhere to sit.`;
  }
  const carried = `${accounts} while postings still referenced ${it}, carrying ${formatWithSide(sheet.unclassifiedMinor)} that belongs to no asset, liability or equity line. That balance is listed under “Unclassified” and is NOT in the identity above.`;
  const entriesDelta = sumAmounts(sheet.unbalancedEntries.map((entry) => entry.deltaMinor));
  if (entriesDelta === 0) return carried;
  return `${carried} These figures are not meant to add up: the entries named are out by ${formatWithSide(entriesDelta)}, and leaving this balance out moves the difference the other way, to ${formatWithSide(sheet.differenceMinor)}.`;
}

/**
 * The balance sheet's caption. A function of the as-of date AND the truncation
 * state, and never a claim of completeness the truncation notice just denied.
 */
export function describeBalanceSheetScope(sheet: BalanceSheet, opts: {truncated: boolean; rolled: boolean}): string {
  const at = sheet.asOf === '' ? 'across the whole book' : `as at ${sheet.asOf}`;
  // "Every account NAME": two accounts may legally share a name and the rollup
  // sums them into one row (documented in `buildHierarchy`), so "every account"
  // would promise one row per account and quietly deliver fewer.
  const shape = opts.rolled ? 'Rolled up by account hierarchy' : 'Every account name, ungrouped';
  const source = opts.truncated
    ? `from the ${sheet.postingCount} postings in the partial read below — NOT the whole book`
    : sheet.asOf === ''
      ? `from all ${sheet.postingCount} posted postings in the book`
      : `from all ${sheet.postingCount} posted postings on or before that date`;
  return `${shape} ${at}, ${source}.`;
}

/**
 * The note under the computed equity line, stating the SPAN it actually covers.
 *
 * "Current earnings" is a period word and, on a never-closed book, this figure
 * has no period: it sums from the first posted entry with no fiscal reset, so
 * on a third-year book it is three years of accumulated earnings. Once a
 * period close exists (LGR-12) the closing entry IS the fiscal reset — the
 * figure starts where the last close ended, and the sentence says which close
 * that was (`closedThrough`). An accountant reading "current" there would mis-state
 * the equity roll-forward at exactly the Beancount/Fava handoff this epic exists
 * to survive, so the note says the span out loud rather than leaving the row's
 * name to imply one.
 *
 * TRUNCATION is an input for the same reason it is one to
 * {@link describeBalanceSheetAssertion}, and it bites HARDER here: the entries a
 * truncated read drops are precisely the OLDEST ones, so "from the first posted
 * entry" is the single claim about this span that a partial read cannot make.
 */
export function describeCurrentEarnings(sheet: BalanceSheet, opts: {truncated?: boolean; closedThrough?: string | null} = {}): string {
  const through = sheet.asOf === '' ? 'through the last posted entry' : `through ${sheet.asOf}`;
  // LGR-12: once a period close (dated at or before the as-of) exists, "from
  // the first posted entry" and "nothing has been closed" both become false —
  // the closing entry zeroed the flow accounts through its date, so THIS
  // figure genuinely starts where the last close ended, and the earlier
  // earnings sit in retained earnings above. `closedThrough` is the latest
  // such close date (`latestCloseThrough` in ./periods); null keeps the
  // never-closed sentence.
  if (opts.closedThrough != null && opts.closedThrough !== '') {
    const from = opts.truncated === true ? 'from the earliest entry in this partial read' : `since the ${opts.closedThrough} period close`;
    return `Revenue less expenses ${from} ${through} — not an account; earnings through ${opts.closedThrough} were closed to retained earnings.`;
  }
  const from = opts.truncated === true ? 'from the earliest entry in this partial read' : 'from the first posted entry';
  return `Revenue less expenses ${from} ${through} — not an account; nothing has been closed to retained earnings.`;
}

/** How many reported entries the as-of date is holding back, in words. */
export function describeAsOfExclusion(sheet: BalanceSheet): string | null {
  if (sheet.afterCount <= 0) return null;
  const entries = sheet.afterCount === 1 ? '1 posted entry is' : `${sheet.afterCount} posted entries are`;
  return `${entries} dated after ${sheet.asOf} and excluded from this position.`;
}

// ── Income statement ──────────────────────────────────────────────────────────

export interface IncomeStatement {
  /** Inclusive ISO bounds (`''` means open at that end). */
  from: string;
  to: string;
  revenue: StatementSection;
  expenses: StatementSection;
  /** Revenue over the period, signed debit-positive (normally negative). */
  totalRevenueMinor: number;
  /** Expenses over the period, signed debit-positive (normally positive). */
  totalExpensesMinor: number;
  /**
   * CREDIT-POSITIVE profit: revenue less expenses. Positive is a profit,
   * negative is a loss. The one figure in this module that is stated on the
   * credit side, because "net income" IS the credit-side number everywhere it is
   * quoted — and it is the number the balance sheet's equity moves BY.
   */
  netIncomeMinor: number;
  /**
   * The same bottom line, DEBIT-POSITIVE (a profit is negative), for the shared
   * `SideAmount`/`formatWithSide` renderer. It exists so the VIEW never re-signs
   * an amount to draw it: a profit is a credit to equity, and the fold is the
   * only place that flip is allowed to happen.
   */
  netIncomeDebitMinor: number;
  profit: boolean;
  /** In-period balances on accounts that no longer exist — neither revenue nor expense. */
  unclassifiedMinor: number;
  unknownAccountIds: string[];
  draftCount: number;
  /** Reported entries inside the period. */
  transactionCount: number;
  /** Postings on revenue/expense accounts inside the period. */
  postingCount: number;
  /** Reported entries the date range excluded. */
  outsideCount: number;
  accountCount: number;
  /**
   * Period-close entries (and reversals of them) dated inside the range and
   * EXCLUDED from every figure above (LGR-12) — disclosed via
   * {@link describeClosingExclusion}, never silently dropped.
   */
  closingCount: number;
}

export interface IncomeStatementOptions {
  /** Inclusive ISO `YYYY-MM-DD` lower bound. */
  from?: string;
  /** Inclusive ISO `YYYY-MM-DD` upper bound. */
  to?: string;
}

/**
 * Split CLOSING ENTRIES (LGR-12) — a period-close's `kind: 'closing'` entry and
 * any reversal pointing at one (the entry a reopen posts) — out of a
 * transaction list. ONE predicate for every earnings fold: a closing entry
 * moves accumulated earnings to equity, it does not earn or spend, so counting
 * it makes every closed period report a net income of exactly zero and every
 * period-close read as a "contribution or draw". The closing set is identified
 * from the SAME list being filtered (a reopen's reversal carries the closing
 * entry's own date, so the pair enters and leaves a range together).
 */
export function excludeClosingEntries(transactions: readonly ReportTransaction[]): {kept: ReportTransaction[]; closingCount: number} {
  const closingIds = new Set(transactions.filter((tx) => tx.kind === 'closing').map((tx) => tx.id));
  if (closingIds.size === 0) return {kept: [...transactions], closingCount: 0};
  const kept = transactions.filter((tx) => !(closingIds.has(tx.id) || (tx.reverses != null && closingIds.has(tx.reverses))));
  return {kept, closingCount: transactions.length - kept.length};
}

/** The exclusion, in words — `null` when the period holds no closing entry. */
export function describeClosingExclusion(closingCount: number): string | null {
  if (closingCount <= 0) return null;
  const entries = closingCount === 1 ? '1 period-close entry' : `${closingCount} period-close entries`;
  return `${entries} dated in this period (reversals of them included) are excluded from these figures: a closing entry moves earnings to equity, it does not earn or spend.`;
}

/**
 * Fold accounts + transactions into an income statement over a date range.
 *
 * CLOSING ENTRIES ARE EXCLUDED (LGR-12 — {@link excludeClosingEntries}): the
 * entry that closes a period zeroes every revenue and expense account by
 * posting their balances to equity, and it is dated INSIDE the period it
 * closes, so counting it would report a net income of exactly `0` for every
 * closed period. The exclusion is DISCLOSED (`closingCount` +
 * {@link describeClosingExclusion}), never silent.
 */
export function buildIncomeStatement(accounts: readonly ReportAccount[], transactions: readonly ReportTransaction[], opts: IncomeStatementOptions = {}): IncomeStatement {
  const from = typeof opts.from === 'string' ? opts.from : '';
  const to = typeof opts.to === 'string' ? opts.to : '';
  const {kept: scoped, closingCount} = excludeClosingEntries(transactionsInRange(transactions, from, to));
  const balances = accountBalances(scoped);

  const revenue = section('revenue', accounts, balances, ['revenue']);
  const expenses = section('expenses', accounts, balances, ['expense']);
  const {section: unclassified, unknownAccountIds} = unclassifiedSection(accounts, balances);

  const netIncomeDebitMinor = sumAmounts([revenue.totalMinor, expenses.totalMinor]);
  const netIncomeMinor = negateAmount(netIncomeDebitMinor);
  const profitAndLossIds = new Set(accounts.filter((a) => a.type === 'revenue' || a.type === 'expense').map((a) => a.id));
  const reported = scoped.filter(isReported);

  return {
    from,
    to,
    revenue,
    expenses,
    totalRevenueMinor: revenue.totalMinor,
    totalExpensesMinor: expenses.totalMinor,
    netIncomeMinor,
    netIncomeDebitMinor,
    profit: netIncomeMinor >= 0,
    unclassifiedMinor: unclassified.totalMinor,
    unknownAccountIds,
    draftCount: countDrafts(scoped),
    transactionCount: reported.length,
    postingCount: reported.reduce((n, tx) => n + tx.postings.filter((p) => profitAndLossIds.has(p.accountId)).length, 0),
    outsideCount: transactions.filter((tx) => isReported(tx) && ((from !== '' && tx.date < from) || (to !== '' && tx.date > to))).length,
    accountCount: revenue.accountCount + expenses.accountCount,
    closingCount,
  };
}

/** The bottom line, in words — profit or loss, never a bare signed number. */
export function describeNetIncome(statement: IncomeStatement): string {
  const period = describePeriod(statement.from, statement.to);
  if (statement.netIncomeMinor === 0) {
    return `Broke even ${period} — revenue ${formatWithSide(statement.totalRevenueMinor)} exactly covered expenses ${formatWithSide(statement.totalExpensesMinor)}.`;
  }
  const magnitude = formatAmount(statement.netIncomeMinor > 0 ? statement.netIncomeMinor : negateAmount(statement.netIncomeMinor));
  return `${statement.profit ? 'Net profit' : 'NET LOSS'} of ${magnitude} ${period}.`;
}

/** The period, as a phrase that reads inside a sentence. */
export function describePeriod(from: string, to: string): string {
  if (from === '' && to === '') return 'across the whole book';
  if (from === '') return `up to ${to}`;
  if (to === '') return `from ${from} onwards`;
  return `from ${from} to ${to}`;
}

/**
 * The income statement's caption — same rule as the balance sheet's: it must
 * never assert a completeness some other line on screen denies.
 *
 * `unclassified` is an input for exactly that reason. `postingCount` counts only
 * postings on accounts that still EXIST, so money on a deleted revenue or
 * expense account is out of Total revenue, out of Total expenses AND out of net
 * income — "all N postings in the period" would be a claim of completeness over
 * figures that are short. (The balance sheet already handles the identical
 * condition, with its own Unclassified section.)
 */
export function describeIncomeScope(statement: IncomeStatement, opts: {truncated: boolean; rolled: boolean; unclassified?: boolean}): string {
  const shape = opts.rolled ? 'Revenue and expenses rolled up by account hierarchy' : 'Every revenue and expense account name, ungrouped';
  const source = opts.truncated
    ? `from the ${statement.postingCount} postings in the partial read below — NOT the whole book`
    : opts.unclassified === true
      ? `from the ${statement.postingCount} postings that still have an account — NOT every posting in the period`
      : `from all ${statement.postingCount} posted revenue and expense postings in the period`;
  return `${shape} ${describePeriod(statement.from, statement.to)}, ${source}.`;
}

/**
 * What the deleted-account balances cost THIS statement, in words — `null` when
 * the chart is intact.
 *
 * The reconciliation footer already mentioned them, but only to say the TIE was
 * approximate. The stronger fact, and the one a reader acts on, is that the
 * revenue, expense and net-income figures above are themselves short.
 */
export function describeIncomeUnclassified(statement: IncomeStatement): string | null {
  const count = statement.unknownAccountIds.length;
  if (count === 0) return null;
  const accounts = count === 1 ? '1 deleted account' : `${count} deleted accounts`;
  if (statement.unclassifiedMinor === 0) {
    return `${accounts} still carry postings in this period. They net to ${formatAmount(0)}, so the totals above are unmoved — but the chart of accounts is damaged.`;
  }
  return `${formatWithSide(statement.unclassifiedMinor)} posted in this period sits on ${accounts} and is excluded from Total revenue, Total expenses AND net income. Repair the chart of accounts to bring it back in.`;
}

// ── Net income ⇄ equity reconciliation ────────────────────────────────────────

/**
 * The relationship that ties the two statements together:
 *
 *   equity(to) − equity(before from) = net income + direct equity postings
 *
 * This is an IDENTITY, not an approximation — total equity as of a date is
 * (equity accounts to date) + (revenue + expenses to date), so its movement over
 * a period is exactly the period's equity postings plus the period's earnings.
 * When nothing was contributed or drawn in the period (`cleanPeriod`), the
 * equity movement IS net income, which is the sentence a reader can check the
 * two statements against each other with.
 */
export interface NetIncomeReconciliation {
  from: string;
  to: string;
  /** Credit-positive profit for the period (the income statement's bottom line). */
  netIncomeMinor: number;
  /** Total equity, credit-positive, immediately BEFORE `from`. */
  openingEquityMinor: number;
  /** Total equity, credit-positive, as of `to`. */
  closingEquityMinor: number;
  /** Closing − opening, credit-positive. */
  equityDeltaMinor: number;
  /** Postings made DIRECTLY to equity accounts in the period, credit-positive. */
  otherEquityMovementsMinor: number;
  /** `equityDelta === netIncome + otherEquityMovements` — true on any sound read. */
  reconciles: boolean;
  /** No direct equity postings in the period: the equity movement IS net income. */
  cleanPeriod: boolean;
  /** Deleted-account balances in the period break the tie — disclosed, never hidden. */
  unclassifiedMinor: number;
}

/**
 * CLOSING ENTRIES ARE EXCLUDED FROM BOTH SIDES (LGR-12 —
 * {@link excludeClosingEntries}): from net income (via
 * {@link buildIncomeStatement}) and from the direct-equity movements below. A
 * closing entry moves accumulated earnings from the flow accounts into
 * retained earnings — both INSIDE total equity as this module computes it
 * (equity accounts + current earnings) — so it moves total equity by exactly
 * zero, and excluding it from both sides preserves the identity to the cent
 * while keeping `cleanPeriod` (and the "contribution or draw" sentence in
 * {@link describeReconciliation}) truthful across a period close.
 */
export function reconcileNetIncome(
  accounts: readonly ReportAccount[],
  transactions: readonly ReportTransaction[],
  opts: IncomeStatementOptions = {},
): NetIncomeReconciliation {
  const from = typeof opts.from === 'string' ? opts.from : '';
  const to = typeof opts.to === 'string' ? opts.to : '';
  const statement = buildIncomeStatement(accounts, transactions, {from, to});

  // Credit-positive equity, at both ends of the period. `transactionsBefore`
  // with an empty `from` is an EMPTY book, which is the right opening position
  // for "the whole book" — not the closing one.
  const opening = buildBalanceSheet(accounts, transactionsBefore(transactions, from), {});
  const closing = buildBalanceSheet(accounts, transactions, {asOf: to});
  const openingEquityMinor = negateAmount(opening.totalEquityMinor);
  const closingEquityMinor = negateAmount(closing.totalEquityMinor);
  const equityDeltaMinor = sumAmounts([closingEquityMinor, negateAmount(openingEquityMinor)]);

  const {kept: scoped} = excludeClosingEntries(transactionsInRange(transactions, from, to));
  const equityIds = new Set(accounts.filter((account) => account.type === 'equity').map((account) => account.id));
  const balances = accountBalances(scoped);
  const equityAmounts: number[] = [];
  balances.forEach((balance, accountId) => {
    if (equityIds.has(accountId)) equityAmounts.push(balance);
  });
  const otherEquityMovementsMinor = negateAmount(sumAmounts(equityAmounts));

  return {
    from,
    to,
    netIncomeMinor: statement.netIncomeMinor,
    openingEquityMinor,
    closingEquityMinor,
    equityDeltaMinor,
    otherEquityMovementsMinor,
    reconciles: equityDeltaMinor === sumAmounts([statement.netIncomeMinor, otherEquityMovementsMinor]),
    cleanPeriod: otherEquityMovementsMinor === 0,
    unclassifiedMinor: statement.unclassifiedMinor,
  };
}

/**
 * The reconciliation as a sentence for the income statement's footer — the place
 * a reader is most likely to want to tie the bottom line to the balance sheet.
 */
export function describeReconciliation(rec: NetIncomeReconciliation): string {
  const period = describePeriod(rec.from, rec.to);
  if (rec.cleanPeriod) {
    return `Ties to the balance sheet: equity moved ${formatCredit(rec.equityDeltaMinor)} ${period}, which is this net income exactly — nothing was contributed or drawn.`;
  }
  return `Ties to the balance sheet: equity moved ${formatCredit(rec.equityDeltaMinor)} ${period} — this net income plus ${formatCredit(rec.otherEquityMovementsMinor)} posted directly to equity accounts (contributions or draws).`;
}
