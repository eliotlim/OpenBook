import React from 'react';
import {AccountName, SideAmount, SrOnly, TableRegion, mutedStyle, numericHeadStyle, numericStyle, tableStyle, tdStyle, thStyle} from './reportShell';
import {directPostingsLabel, type HierarchyRow} from './statements';

/**
 * The chrome the two STATEMENT blocks share (LGR-9): the hierarchy table, its
 * disclosure control, and the collapsed-path prop codec.
 *
 * A sibling of `./reportShell` rather than more of it — the shell holds what
 * EVERY ledger report needs (the live-data hook, the notice tones, the money
 * notation), and this holds the one structure only the statements have: a
 * section of colon-hierarchy rows with subtotals. Both files' styles come from
 * the shell, so the four report blocks still look like one family.
 *
 * NO ARITHMETIC lives here. Every amount is handed in already folded by
 * `./statements`; this file only decides indentation and which rows are on
 * screen.
 */

// ── Collapsed-path persistence ────────────────────────────────────────────────

/**
 * Collapsed paths are stored as a JSON ARRAY — no separator character at all.
 *
 * Every delimiter is a bet that the delimiter cannot occur in an account name,
 * and the bet keeps losing: a comma is legal (`Expenses:Meals, Entertainment`),
 * and so is a NEWLINE — the server's `isValidLedgerAccountName` only requires
 * non-blank colon-segments. A newline-joined `"Cloud\nHosting"` splits into two
 * paths that match nothing, silently re-expanding a subtree the reader closed.
 * JSON does the escaping, so there is nothing left to guess about.
 *
 * Sorted on write, so the persisted value does not churn with click order.
 */
export function serializeCollapsed(paths: ReadonlySet<string>): string {
  return JSON.stringify([...paths].sort());
}

/**
 * Anything unreadable reads as "nothing collapsed" — the safe direction: an
 * unexpectedly OPEN tree shows the reader more than they asked for, while an
 * unexpectedly closed one hides rows and, with them, the arithmetic of the
 * subtotals above.
 */
export function parseCollapsed(raw: string): Set<string> {
  if (raw.trim() === '') return new Set<string>();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((path): path is string => typeof path === 'string' && path !== ''));
  } catch {
    return new Set<string>();
  }
}

// ── Statement table ───────────────────────────────────────────────────────────

/** One block of a statement: a hierarchy section, or a single summary line. */
export type StatementLine =
  | {kind: 'section'; key: string; title: string; rows: readonly HierarchyRow[]; emptyText: string}
  | {kind: 'line'; key: string; label: string; minor: number; note?: string; strong?: boolean; rule?: boolean};

const sectionHeadStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: 'left',
  fontWeight: 600,
  fontSize: '0.8rem',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  paddingTop: '0.6rem',
};

const toggleStyle: React.CSSProperties = {
  display: 'inline-block',
  width: '1.1em',
  marginRight: '0.15rem',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  lineHeight: 1,
  textAlign: 'left',
  cursor: 'pointer',
};

/**
 * The disclosure control on a parent row.
 *
 * A real `<button>` with `aria-expanded`, not a clickable span: the platform
 * gives it the focus ring, the Enter/Space handling and the announced state for
 * free, and every one of those is a thing a re-implementation forgets. Rows with
 * no children still render the same-width box (aria-hidden, empty) so the whole
 * column of account names starts on one vertical line — otherwise every leaf
 * would sit 1.1em left of its siblings.
 */
const Twisty = ({row, onToggle}: {row: HierarchyRow; onToggle: (path: string) => void}) =>
  row.hasChildren ? (
    <button type="button" data-ledger-toggle={row.path} aria-expanded={!row.collapsed} style={toggleStyle} onClick={() => onToggle(row.path)}>
      <span aria-hidden="true">{row.collapsed ? '▸' : '▾'}</span>
      <SrOnly>
        {row.collapsed ? 'Expand' : 'Collapse'} {row.path} ({row.accountCount === 1 ? '1 account' : `${row.accountCount} accounts`})
      </SrOnly>
    </button>
  ) : (
    <span aria-hidden="true" style={{...toggleStyle, cursor: 'default'}} />
  );

/**
 * One hierarchy row. Indentation is padding on the row header, so the amount
 * column never moves with depth — a statement is read by scanning that column,
 * and a subtotal that shifted horizontally with its nesting would defeat it.
 */
const HierarchyLine = ({row, onToggle}: {row: HierarchyRow; onToggle: (path: string) => void}) => (
  <tr data-ledger-statement-row={row.path} data-ledger-row-kind={row.kind} {...(row.hasChildren ? {'data-ledger-parent': row.collapsed ? 'collapsed' : 'expanded'} : {})}>
    <th
      scope="row"
      // EXPLICIT accessible name, overriding name-from-content. Without it the
      // header absorbs the twisty's own `SrOnly` text and the collapsed count,
      // so a parent row announced as "Expand Assets:Bank (2 accounts) Bank
      // (2 accounts)" — with the count twice — and `scope="row"` then repeated
      // that whole string on the amount cell beside it.
      //
      // The direct row's name is the VISIBLE sentence (see `directPostingsLabel`)
      // re-stated on the full path, which the leaf label lacks. It is deliberately
      // not "Direct postings to …": that is the plan-file idiom the visible label
      // dropped, and leaving it here made screen-reader users the only readers
      // still getting it — the mirror image of the defect that removed it.
      aria-label={row.kind === 'direct' ? directPostingsLabel(row.path) : row.label}
      style={{
        ...tdStyle,
        overflowWrap: 'break-word',
        textAlign: 'left',
        fontWeight: row.hasChildren ? 600 : 400,
        paddingLeft: `${0.5 + row.depth * 1.1}rem`,
      }}
    >
      <Twisty row={row} onToggle={onToggle} />
      {/* The direct row's label is already the explanation (see
          `directPostingsLabel`), so there is no gloss left to hide in SrOnly. */}
      {row.kind === 'direct' ? <span style={mutedStyle}>{row.label}</span> : <AccountName name={row.label} />}
      {row.collapsed && (
        <span style={{...mutedStyle, marginLeft: '0.4rem'}}>
          ({row.accountCount === 1 ? '1 account' : `${row.accountCount} accounts`})
        </span>
      )}
    </th>
    <td data-ledger-statement-amount style={{...numericStyle, fontWeight: row.hasChildren ? 600 : 400}}>
      <SideAmount minor={row.minor} />
    </td>
  </tr>
);

/**
 * A statement as a real `<table>`: one `<tbody>` per section so each heading is
 * a `scope="rowgroup"` header rather than a styled row a screen reader reads as
 * an orphan cell, and every account row is a `<th scope="row">`.
 */
export const StatementTable = ({
  label,
  caption,
  lines,
  onToggle,
}: {
  label: string;
  caption: React.ReactNode;
  lines: readonly StatementLine[];
  onToggle: (path: string) => void;
}) => (
  <TableRegion label={label}>
    <table style={tableStyle}>
      <caption style={{...mutedStyle, textAlign: 'left', paddingBottom: '0.25rem'}}>{caption}</caption>
      <thead>
        <tr>
          <th scope="col" style={thStyle}>
            Account
          </th>
          <th scope="col" style={numericHeadStyle}>
            Amount
          </th>
        </tr>
      </thead>
      {/* Keys are namespaced by KIND: a section and the total line that follows
          it name the same thing (`assets`), and an un-namespaced key made them
          collide — React then treats two sibling `<tbody>`s as one element and
          may omit or duplicate either. */}
      {lines.map((line) =>
        line.kind === 'section' ? (
          <tbody key={`section:${line.key}`} data-ledger-section={line.key}>
            <tr>
              <th scope="rowgroup" colSpan={2} style={sectionHeadStyle}>
                {line.title}
              </th>
            </tr>
            {line.rows.length === 0 ? (
              <tr>
                <td colSpan={2} style={{...tdStyle, ...mutedStyle}}>
                  {line.emptyText}
                </td>
              </tr>
            ) : (
              line.rows.map((row) => <HierarchyLine key={row.key} row={row} onToggle={onToggle} />)
            )}
          </tbody>
        ) : (
          <tbody key={`line:${line.key}`}>
            <tr data-ledger-statement-total={line.key}>
              <th
                scope="row"
                style={{
                  ...tdStyle,
                  textAlign: 'left',
                  fontWeight: line.strong === true ? 700 : 600,
                  ...(line.rule === true ? {borderTop: '2px solid hsl(var(--border))'} : {}),
                }}
              >
                {line.label}
                {line.note !== undefined && <div style={{...mutedStyle, fontWeight: 400}}>{line.note}</div>}
              </th>
              <td
                data-ledger-statement-amount
                style={{
                  ...numericStyle,
                  fontWeight: line.strong === true ? 700 : 600,
                  ...(line.rule === true ? {borderTop: '2px solid hsl(var(--border))'} : {}),
                }}
              >
                <SideAmount minor={line.minor} />
              </td>
            </tr>
          </tbody>
        ),
      )}
    </table>
  </TableRegion>
);

const linkButtonStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  font: 'inherit',
  fontSize: '0.75rem',
  color: 'hsl(var(--foreground))',
  textDecoration: 'underline',
  cursor: 'pointer',
};

/**
 * The shape/scope controls both statements carry: roll the hierarchy up or list
 * every account flat, and (when rolled) open or close every parent at once.
 *
 * "Collapse all"/"Expand all" are rendered as a pair rather than one toggling
 * button because the tree can be PARTIALLY open, and a single button would have
 * to guess which way a mixed state should go — guessing wrong is a click that
 * does the opposite of what it says.
 */
export const ShapeControls = ({
  rolled,
  onRolled,
  onCollapseAll,
  onExpandAll,
  parentCount,
}: {
  rolled: boolean;
  onRolled: (next: boolean) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  parentCount: number;
}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap'}}>
    <label style={{...mutedStyle, display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer'}}>
      <input type="checkbox" data-ledger-rolled checked={rolled} onChange={(e) => onRolled(e.target.checked)} />
      Roll up sub-accounts
    </label>
    {rolled && parentCount > 0 && (
      <>
        <button type="button" data-ledger-collapse-all style={linkButtonStyle} onClick={onCollapseAll}>
          Collapse all
        </button>
        <button type="button" data-ledger-expand-all style={linkButtonStyle} onClick={onExpandAll}>
          Expand all
        </button>
      </>
    )}
  </div>
);
