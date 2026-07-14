import {createRef} from 'react';
import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, act} from '@testing-library/react';
import type {DatabaseProperty} from '@book.dev/sdk';
import {PropertyMenu} from '../databaseMenus';
import type {PropertyMenuHandle} from '../databaseMenus';
import type {UseDatabase} from '../useDatabase';

// PropertyMenu itself pulls no provider hooks, but its module does — stub the
// provider surface so the component mounts without the full app tree.
vi.mock('@/providers', () => ({
  useNavigation: () => ({pages: [], pageLabel: () => ''}),
  useTranslation: () => ({t: (k: string) => k}),
}));

afterEach(cleanup);

const property: DatabaseProperty = {id: 'p1', name: 'Priority', type: 'text'};

const makeDb = (): UseDatabase =>
  ({
    activeView: {id: 'v1'},
    database: {schema: {properties: [property]}},
    updateProperty: vi.fn().mockResolvedValue(undefined),
    deleteProperty: vi.fn().mockResolvedValue(undefined),
  }) as unknown as UseDatabase;

describe('PropertyMenu openAtPointer handle (CM-4 rework)', () => {
  // The header right-click now opens ColumnContextMenu (quick actions); its
  // "Edit property…" item drives PropertyMenu.openAtPointer to reach the full
  // editor. These cover that handle directly (the form still opens at a pointer).
  it('opens the full property menu when driven at a pointer ("Edit property…")', () => {
    const ref = createRef<PropertyMenuHandle>();
    render(<PropertyMenu ref={ref} property={property} db={makeDb()} index={0} count={1} />);
    // Closed by default: the editor body is not mounted.
    expect(screen.queryByText('Delete property')).toBeNull();

    act(() => ref.current!.openAtPointer({clientX: 120, clientY: 40}));

    // Same items as the "…" click — name field + type editor + delete action.
    expect((screen.getByLabelText('Property name') as HTMLInputElement).value).toBe('Priority');
    expect(screen.getByText('Delete property')).toBeTruthy();
  });

  it('still opens on a left-click of the "…" trigger', () => {
    render(<PropertyMenu property={property} db={makeDb()} index={0} count={1} />);
    expect(screen.queryByText('Delete property')).toBeNull();
    fireEvent.click(screen.getByLabelText('Property options'));
    expect(screen.getByText('Delete property')).toBeTruthy();
  });

  it('routes a menu action through the database (delete)', () => {
    const db = makeDb();
    const ref = createRef<PropertyMenuHandle>();
    render(<PropertyMenu ref={ref} property={property} db={db} index={0} count={1} />);
    act(() => ref.current!.openAtPointer({clientX: 0, clientY: 0}));
    fireEvent.click(screen.getByText('Delete property'));
    expect(db.deleteProperty).toHaveBeenCalledWith('p1');
  });
});
