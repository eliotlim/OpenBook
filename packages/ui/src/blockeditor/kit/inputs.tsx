import React, {useState} from 'react';
import {blockProp, setBlockProp} from '../model';
import type {CustomBlockProps} from '../registry';
import {setNamedNumber} from './scope';
import {resolveOptions} from './options';
import {ConfigField, ConfigInput, KitFrame, kitSet, kitWide} from './KitFrame';
import {OptionsEditor} from './OptionsEditor';

/**
 * The artifact kit's input blocks: named, CRDT-synced values the whole document
 * can compute over (formulas, charts, status lights). Each renders a clean
 * control; the configuration (reactive symbol, display name, description,
 * options, layout) lives behind a quiet ⚙ that opens a settings popover and
 * expands into a side panel — so artifacts read like artifacts, not forms about
 * forms. See {@link KitFrame} for the shared chrome.
 */

// ── Number stepper ───────────────────────────────────────────────────────────

const NumberBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'n';
  const value = Number(blockProp<number>(block, 'value') ?? 0);
  const step = Number(blockProp<number>(block, 'step') ?? 1);
  const min = blockProp<number>(block, 'min');
  const max = blockProp<number>(block, 'max');
  const clamp = (v: number): number => {
    if (typeof min === 'number') v = Math.max(min, v);
    if (typeof max === 'number') v = Math.min(max, v);
    return Math.round(v * 1e9) / 1e9;
  };

  const control = (
    <div className="obe-kit-stepper" role="group" aria-label={`${name} stepper`}>
      <button type="button" aria-label="Decrease" disabled={editor.readOnly} onClick={() => kitSet(editor, block, 'value', clamp(value - step))}>
        −
      </button>
      <input
        inputMode="decimal"
        value={String(value)}
        aria-label={`${name} value`}
        readOnly={editor.readOnly}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) kitSet(editor, block, 'value', clamp(v));
        }}
      />
      <button type="button" aria-label="Increase" disabled={editor.readOnly} onClick={() => kitSet(editor, block, 'value', clamp(value + step))}>
        +
      </button>
    </div>
  );

  const config = (
    <div className="flex gap-2">
      {(['min', 'max', 'step'] as const).map((key) => (
        <ConfigField key={key} label={key}>
          <ConfigInput
            inputMode="decimal"
            value={blockProp<number>(block, key) ?? ''}
            readOnly={editor.readOnly}
            aria-label={key}
            onChange={(e) => {
              const v = e.target.value.trim();
              kitSet(editor, block, key, v === '' ? undefined : Number(v));
            }}
          />
        </ConfigField>
      ))}
    </div>
  );

  return <KitFrame block={block} editor={editor} kind="number" defaultName="n" control={control} config={config} />;
};

// ── Text field ───────────────────────────────────────────────────────────────

const TextFieldBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'text';

  const control = (
    <input
      className="obe-kit-textinput"
      value={blockProp<string>(block, 'value') ?? ''}
      placeholder={blockProp<string>(block, 'placeholder') ?? 'Type here…'}
      aria-label={`${name} value`}
      readOnly={editor.readOnly}
      onChange={(e) => kitSet(editor, block, 'value', e.target.value)}
    />
  );

  const config = (
    <ConfigField label="Placeholder">
      <ConfigInput
        value={blockProp<string>(block, 'placeholder') ?? ''}
        readOnly={editor.readOnly}
        aria-label="Placeholder"
        onChange={(e) => kitSet(editor, block, 'placeholder', e.target.value)}
      />
    </ConfigField>
  );

  return <KitFrame block={block} editor={editor} kind="text" defaultName="text" control={control} config={config} />;
};

// ── Radio group ──────────────────────────────────────────────────────────────

const RadioBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'choice';
  const options = resolveOptions(block);
  const value = blockProp<string>(block, 'value') ?? null;
  const wide = kitWide(block);

  const control = (
    <div
      role="radiogroup"
      aria-label={name}
      className="obe-kit-pills"
      onKeyDown={(e) => {
        // Standard radiogroup keyboard: arrows move AND select, wrapping.
        if (editor.readOnly || options.length === 0) return;
        const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!delta) return;
        e.preventDefault();
        const at = Math.max(0, options.findIndex((o) => o.value === value));
        const nextIdx = (at + delta + options.length) % options.length;
        kitSet(editor, block, 'value', options[nextIdx].value);
        (e.currentTarget.querySelectorAll('[role="radio"]')[nextIdx] as HTMLElement)?.focus();
      }}
    >
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          tabIndex={value === opt.value || (!value && i === 0) ? 0 : -1}
          className={`obe-kit-pill${value === opt.value ? ' obe-kit-pill-on' : ''}`}
          disabled={editor.readOnly}
          onClick={() => kitSet(editor, block, 'value', opt.value)}
        >
          {wide && <span className="obe-kit-pill-dot" aria-hidden />}
          {opt.label}
        </button>
      ))}
      {options.length === 0 && <span className="obe-kit-empty">add options ⚙</span>}
    </div>
  );

  return (
    <KitFrame block={block} editor={editor} kind="radio" defaultName="choice" supportsWide control={control} config={<OptionsEditor block={block} editor={editor} />} />
  );
};

// ── Checklist (multi-select that publishes its selection) ───────────────────

const ChecklistBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'checks';
  const options = resolveOptions(block);
  const selectedRaw = blockProp<string[]>(block, 'selected');
  const selected = new Set(Array.isArray(selectedRaw) ? selectedRaw : []);

  const toggle = (val: string): void => {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    kitSet(editor, block, 'selected', options.filter((o) => next.has(o.value)).map((o) => o.value));
  };

  const control = (
    <div className="obe-kit-checks" role="group" aria-label={name}>
      {options.map((opt) => (
        <label key={opt.value} className="obe-kit-check">
          <input type="checkbox" checked={selected.has(opt.value)} disabled={editor.readOnly} onChange={() => toggle(opt.value)} />
          <span>{opt.label}</span>
        </label>
      ))}
      {options.length === 0 && <span className="obe-kit-empty">add options ⚙</span>}
    </div>
  );

  return (
    <KitFrame block={block} editor={editor} kind="checklist" defaultName="checks" supportsWide control={control} config={<OptionsEditor block={block} editor={editor} />} />
  );
};

// ── Dropdown (single pick from a select) ─────────────────────────────────────

const DropdownBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'pick';
  const options = resolveOptions(block);
  const value = blockProp<string>(block, 'value') ?? '';
  const known = options.some((o) => o.value === value);

  const control = (
    <select
      className="obe-kit-select obe-kit-dropdown-select"
      value={known ? value : ''}
      aria-label={`${name} value`}
      disabled={editor.readOnly}
      onChange={(e) => kitSet(editor, block, 'value', e.target.value)}
    >
      {!known && <option value="">—</option>}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );

  return (
    <KitFrame block={block} editor={editor} kind="dropdown" defaultName="pick" supportsWide control={control} config={<OptionsEditor block={block} editor={editor} />} />
  );
};

// ── Toggle switch ────────────────────────────────────────────────────────────

const ToggleBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'on';
  const value = Boolean(blockProp<boolean>(block, 'value') ?? false);

  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={`${name} toggle`}
      className={`obe-kit-switch${value ? ' obe-kit-switch-on' : ''}`}
      disabled={editor.readOnly}
      onClick={() => kitSet(editor, block, 'value', !value)}
    >
      <span className="obe-kit-knob" />
    </button>
  );

  return <KitFrame block={block} editor={editor} kind="toggle" defaultName="on" control={control} />;
};

// ── Location input ───────────────────────────────────────────────────────────

const LocationBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [locating, setLocating] = useState(false);
  const name = blockProp<string>(block, 'name') ?? 'place';
  const lat = blockProp<number>(block, 'lat');
  const lng = blockProp<number>(block, 'lng');
  const hasCoords = typeof lat === 'number' && typeof lng === 'number';

  const setCoord = (key: 'lat' | 'lng', raw: string): void => {
    const v = raw.trim() === '' ? undefined : Number(raw);
    if (v === undefined || Number.isFinite(v)) kitSet(editor, block, key, v);
  };

  const locate = (): void => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        editor.doc.transact(() => {
          setBlockProp(block, 'lat', Math.round(pos.coords.latitude * 1e5) / 1e5);
          setBlockProp(block, 'lng', Math.round(pos.coords.longitude * 1e5) / 1e5);
        }, 'local');
        setLocating(false);
      },
      () => setLocating(false),
      {timeout: 8000},
    );
  };

  const control = (
    <>
      <input
        className="obe-kit-textinput"
        value={blockProp<string>(block, 'labeltext') ?? ''}
        placeholder="Place name…"
        aria-label={`${name} place`}
        readOnly={editor.readOnly}
        onChange={(e) => kitSet(editor, block, 'labeltext', e.target.value)}
      />
      <input className="obe-kit-num" inputMode="decimal" value={lat ?? ''} placeholder="lat" aria-label="Latitude" readOnly={editor.readOnly} onChange={(e) => setCoord('lat', e.target.value)} />
      <input className="obe-kit-num" inputMode="decimal" value={lng ?? ''} placeholder="lng" aria-label="Longitude" readOnly={editor.readOnly} onChange={(e) => setCoord('lng', e.target.value)} />
      {!editor.readOnly && (
        <button type="button" className="obe-kit-mini" onClick={locate} disabled={locating} aria-label="Use my location" title="Use my location">
          {locating ? '…' : '◎'}
        </button>
      )}
      {hasCoords && (
        <a className="obe-kit-mini" href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`} target="_blank" rel="noreferrer" aria-label="Open map" title="Open map">
          ↗
        </a>
      )}
    </>
  );

  return <KitFrame block={block} editor={editor} kind="location" defaultName="place" control={control} />;
};

// ── Action button ────────────────────────────────────────────────────────────

const ButtonBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const label = blockProp<string>(block, 'btnlabel') ?? 'Click me';
  const action = blockProp<string>(block, 'action') ?? 'increment';
  const target = blockProp<string>(block, 'target') ?? '';
  const amount = Number(blockProp<number>(block, 'amount') ?? 1);
  const url = blockProp<string>(block, 'url') ?? '';

  const fire = (): void => {
    if (action === 'link') {
      if (url) window.open(/^https?:\/\//.test(url) ? url : `https://${url}`, '_blank', 'noopener');
    } else if (action === 'set') {
      setNamedNumber(editor.doc, target, () => amount);
    } else if (action === 'toggle') {
      setNamedNumber(editor.doc, target, (v) => v);
    } else {
      setNamedNumber(editor.doc, target, (v) => v + amount);
    }
  };

  const control = (
    <button type="button" className="obe-kit-action" onClick={fire} disabled={editor.readOnly && action !== 'link'}>
      {label}
    </button>
  );

  const config = (
    <>
      <ConfigField label="Button label">
        <ConfigInput value={label} readOnly={editor.readOnly} aria-label="Button label" onChange={(e) => kitSet(editor, block, 'btnlabel', e.target.value)} />
      </ConfigField>
      <ConfigField label="Action">
        <select
          className="obe-kit-select w-full rounded-md border border-border bg-card px-2 py-1 text-sm"
          value={action}
          disabled={editor.readOnly}
          aria-label="Button action"
          onChange={(e) => kitSet(editor, block, 'action', e.target.value)}
        >
          <option value="increment">increment input</option>
          <option value="set">set input</option>
          <option value="toggle">flip toggle</option>
          <option value="link">open link</option>
        </select>
      </ConfigField>
      {action === 'link' ? (
        <ConfigField label="URL">
          <ConfigInput value={url} readOnly={editor.readOnly} aria-label="URL" placeholder="https://…" onChange={(e) => kitSet(editor, block, 'url', e.target.value)} />
        </ConfigField>
      ) : (
        <div className="flex gap-2">
          <ConfigField label="Input">
            <ConfigInput mono value={target} readOnly={editor.readOnly} aria-label="Target input name" placeholder="x" onChange={(e) => kitSet(editor, block, 'target', e.target.value.trim())} />
          </ConfigField>
          {action !== 'toggle' && (
            <ConfigField label={action === 'set' ? 'value' : 'by'}>
              <ConfigInput
                inputMode="decimal"
                value={blockProp<number>(block, 'amount') ?? 1}
                readOnly={editor.readOnly}
                aria-label="Amount"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) kitSet(editor, block, 'amount', v);
                }}
              />
            </ConfigField>
          )}
        </div>
      )}
    </>
  );

  return <KitFrame block={block} editor={editor} kind="button" defaultName="" control={control} config={config} symbol={false} hideHeader />;
};

/** Definitions consumed by kit/index.ts (type + renderer + slash entry). */
export const INPUT_BLOCKS = [
  {
    type: 'number',
    render: NumberBlock,
    slash: {
      label: 'Number stepper',
      hint: 'A named number with − / + buttons',
      keywords: 'number stepper counter input increment buttons',
      make: () => ({type: 'number', props: {name: 'n', value: 0, step: 1}}),
    },
  },
  {
    type: 'textfield',
    render: TextFieldBlock,
    slash: {
      label: 'Text field',
      hint: 'A named text input',
      keywords: 'text field input string form',
      make: () => ({type: 'textfield', props: {name: 'text', value: ''}}),
    },
  },
  {
    type: 'radio',
    render: RadioBlock,
    slash: {
      label: 'Radio group',
      hint: 'Pick one of several options',
      keywords: 'radio choice select option pick one form',
      make: () => ({
        type: 'radio',
        props: {name: 'choice', opts: [{label: 'One'}, {label: 'Two'}, {label: 'Three'}], value: 'one'},
      }),
    },
  },
  {
    type: 'checklist',
    render: ChecklistBlock,
    slash: {
      label: 'Choice checklist',
      hint: 'Pick any of several options',
      keywords: 'checklist checkbox multi select options form',
      make: () => ({
        type: 'checklist',
        props: {name: 'checks', opts: [{label: 'Alpha'}, {label: 'Beta'}, {label: 'Gamma'}], selected: []},
      }),
    },
  },
  {
    type: 'dropdown',
    render: DropdownBlock,
    slash: {
      label: 'Dropdown',
      hint: 'Pick one option from a select',
      keywords: 'dropdown select choose option pick form menu',
      make: () => ({
        type: 'dropdown',
        props: {name: 'pick', opts: [{label: 'One'}, {label: 'Two'}, {label: 'Three'}], value: 'one'},
      }),
    },
  },
  {
    type: 'toggle',
    render: ToggleBlock,
    slash: {
      label: 'Toggle switch',
      hint: 'A named on/off switch',
      keywords: 'toggle switch boolean on off flag',
      make: () => ({type: 'toggle', props: {name: 'on', value: false}}),
    },
  },
  {
    type: 'location',
    render: LocationBlock,
    slash: {
      label: 'Location',
      hint: 'A place with coordinates',
      keywords: 'location place map coordinates gps geo',
      make: () => ({type: 'location', props: {name: 'place'}}),
    },
  },
  {
    type: 'actionbutton',
    render: ButtonBlock,
    slash: {
      label: 'Button',
      hint: 'Set, step, or toggle an input — or open a link',
      keywords: 'button action click increment set link trigger',
      make: () => ({type: 'actionbutton', props: {btnlabel: 'Click me', action: 'increment', target: 'n', amount: 1}}),
    },
  },
] as const;
