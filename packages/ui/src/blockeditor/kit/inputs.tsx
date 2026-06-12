import React, {useState} from 'react';
import {blockProp, setBlockProp, type BlockMap} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import type {CustomBlockProps} from '../registry';
import {setNamedNumber} from './scope';

/**
 * The artifact kit's input blocks: named, CRDT-synced values that the whole
 * document can compute over (formulas, charts, status lights). Each renders
 * a clean control surface; the name and options live behind a quiet ⚙
 * toggle so artifacts read like artifacts, not like forms about forms.
 */

const set = (editor: BlockEditorController, block: BlockMap, key: string, value: unknown): void =>
  editor.doc.transact(() => setBlockProp(block, key, value), 'local');

/** The hover-revealed config affordance every kit input shares. */
const ConfigButton: React.FC<{open: boolean; onClick: () => void}> = ({open, onClick}) => (
  <button
    type="button"
    className={`obe-kit-gear${open ? ' obe-kit-gear-on' : ''}`}
    aria-label="Configure block"
    aria-expanded={open}
    onClick={onClick}
    contentEditable={false}
  >
    ⚙
  </button>
);

const NameField: React.FC<{block: BlockMap; editor: BlockEditorController}> = ({block, editor}) => (
  <label className="obe-kit-field">
    <span>name</span>
    <input
      className="obe-kit-name"
      value={blockProp<string>(block, 'name') ?? ''}
      readOnly={editor.readOnly}
      spellCheck={false}
      aria-label="Input name"
      onChange={(e) => set(editor, block, 'name', e.target.value.trim())}
    />
  </label>
);

const splitOptions = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Config checkbox: lay the options out as full-width interactive rows. */
const WideField: React.FC<{block: BlockMap; editor: BlockEditorController}> = ({block, editor}) => (
  <label className="obe-kit-field">
    <span>full width</span>
    <input
      type="checkbox"
      checked={Boolean(blockProp<boolean>(block, 'wide'))}
      disabled={editor.readOnly}
      aria-label="Full width"
      onChange={(e) => set(editor, block, 'wide', e.target.checked)}
    />
  </label>
);

const OptionsField: React.FC<{block: BlockMap; editor: BlockEditorController}> = ({block, editor}) => (
  <label className="obe-kit-field obe-kit-field-grow">
    <span>options</span>
    <input
      className="obe-kit-options"
      value={blockProp<string>(block, 'options') ?? ''}
      readOnly={editor.readOnly}
      spellCheck={false}
      aria-label="Options (comma-separated)"
      placeholder="One, Two, Three"
      onChange={(e) => set(editor, block, 'options', e.target.value)}
    />
  </label>
);

// ── Number stepper ───────────────────────────────────────────────────────────

const NumberBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
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

  return (
    <div className="obe-kit obe-kit-number" contentEditable={false} data-kit-name={name}>
      <span className="obe-kit-label">{blockProp<string>(block, 'label') || name}</span>
      <div className="obe-kit-stepper" role="group" aria-label={`${name} stepper`}>
        <button type="button" aria-label="Decrease" disabled={editor.readOnly} onClick={() => set(editor, block, 'value', clamp(value - step))}>
          −
        </button>
        <input
          inputMode="decimal"
          value={String(value)}
          aria-label={`${name} value`}
          readOnly={editor.readOnly}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) set(editor, block, 'value', clamp(v));
          }}
        />
        <button type="button" aria-label="Increase" disabled={editor.readOnly} onClick={() => set(editor, block, 'value', clamp(value + step))}>
          +
        </button>
      </div>
      <ConfigButton open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <NameField block={block} editor={editor} />
          <label className="obe-kit-field">
            <span>label</span>
            <input className="obe-kit-name" value={blockProp<string>(block, 'label') ?? ''} readOnly={editor.readOnly} aria-label="Display label" onChange={(e) => set(editor, block, 'label', e.target.value)} />
          </label>
          {(['min', 'max', 'step'] as const).map((key) => (
            <label key={key} className="obe-kit-field">
              <span>{key}</span>
              <input
                className="obe-kit-num"
                inputMode="decimal"
                value={blockProp<number>(block, key) ?? ''}
                readOnly={editor.readOnly}
                aria-label={key}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  set(editor, block, key, v === '' ? undefined : Number(v));
                }}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Text field ───────────────────────────────────────────────────────────────

const TextFieldBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
  const name = blockProp<string>(block, 'name') ?? 'text';

  return (
    <div className="obe-kit obe-kit-text" contentEditable={false} data-kit-name={name}>
      <span className="obe-kit-label">{blockProp<string>(block, 'label') || name}</span>
      <input
        className="obe-kit-textinput"
        value={blockProp<string>(block, 'value') ?? ''}
        placeholder={blockProp<string>(block, 'placeholder') ?? 'Type here…'}
        aria-label={`${name} value`}
        readOnly={editor.readOnly}
        onChange={(e) => set(editor, block, 'value', e.target.value)}
      />
      <ConfigButton open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <NameField block={block} editor={editor} />
          <label className="obe-kit-field">
            <span>label</span>
            <input className="obe-kit-name" value={blockProp<string>(block, 'label') ?? ''} readOnly={editor.readOnly} aria-label="Display label" onChange={(e) => set(editor, block, 'label', e.target.value)} />
          </label>
          <label className="obe-kit-field obe-kit-field-grow">
            <span>placeholder</span>
            <input className="obe-kit-options" value={blockProp<string>(block, 'placeholder') ?? ''} readOnly={editor.readOnly} aria-label="Placeholder" onChange={(e) => set(editor, block, 'placeholder', e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );
};

// ── Radio group ──────────────────────────────────────────────────────────────

const RadioBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
  const name = blockProp<string>(block, 'name') ?? 'choice';
  const options = splitOptions(blockProp<string>(block, 'options') ?? '');
  const value = blockProp<string>(block, 'value') ?? null;
  const wide = Boolean(blockProp<boolean>(block, 'wide'));

  return (
    <div className={`obe-kit obe-kit-radio${wide ? ' obe-kit-wide' : ''}`} contentEditable={false} data-kit-name={name}>
      <span className="obe-kit-label">{blockProp<string>(block, 'label') || name}</span>
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
          const at = Math.max(0, options.indexOf(value ?? ''));
          const next = options[(at + delta + options.length) % options.length];
          set(editor, block, 'value', next);
          (e.currentTarget.querySelectorAll('[role="radio"]')[(at + delta + options.length) % options.length] as HTMLElement)?.focus();
        }}
      >
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={value === opt}
            tabIndex={value === opt || (!value && opt === options[0]) ? 0 : -1}
            className={`obe-kit-pill${value === opt ? ' obe-kit-pill-on' : ''}`}
            disabled={editor.readOnly}
            onClick={() => set(editor, block, 'value', opt)}
          >
            {wide && <span className="obe-kit-pill-dot" aria-hidden />}
            {opt}
          </button>
        ))}
        {options.length === 0 && <span className="obe-kit-empty">add options ⚙</span>}
      </div>
      <ConfigButton open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <NameField block={block} editor={editor} />
          <OptionsField block={block} editor={editor} />
          <WideField block={block} editor={editor} />
        </div>
      )}
    </div>
  );
};

// ── Checklist (multi-select that publishes its selection) ───────────────────

const ChecklistBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
  const name = blockProp<string>(block, 'name') ?? 'checks';
  const options = splitOptions(blockProp<string>(block, 'options') ?? '');
  const selectedRaw = blockProp<string[]>(block, 'selected');
  const selected = new Set(Array.isArray(selectedRaw) ? selectedRaw : []);
  const wide = Boolean(blockProp<boolean>(block, 'wide'));

  const toggle = (opt: string): void => {
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    set(editor, block, 'selected', options.filter((o) => next.has(o)));
  };

  return (
    <div className={`obe-kit obe-kit-checklist${wide ? ' obe-kit-wide' : ''}`} contentEditable={false} data-kit-name={name}>
      <span className="obe-kit-label">{blockProp<string>(block, 'label') || name}</span>
      <div className="obe-kit-checks" role="group" aria-label={name}>
        {options.map((opt) => (
          <label key={opt} className="obe-kit-check">
            <input type="checkbox" checked={selected.has(opt)} disabled={editor.readOnly} onChange={() => toggle(opt)} />
            <span>{opt}</span>
          </label>
        ))}
        {options.length === 0 && <span className="obe-kit-empty">add options ⚙</span>}
      </div>
      <ConfigButton open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <NameField block={block} editor={editor} />
          <OptionsField block={block} editor={editor} />
          <WideField block={block} editor={editor} />
        </div>
      )}
    </div>
  );
};

// ── Dropdown (single pick from a select) ─────────────────────────────────────

const DropdownBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
  const name = blockProp<string>(block, 'name') ?? 'pick';
  const options = splitOptions(blockProp<string>(block, 'options') ?? '');
  const value = blockProp<string>(block, 'value') ?? '';
  const wide = Boolean(blockProp<boolean>(block, 'wide'));

  return (
    <div className={`obe-kit obe-kit-dropdown${wide ? ' obe-kit-wide' : ''}`} contentEditable={false} data-kit-name={name}>
      <span className="obe-kit-label">{blockProp<string>(block, 'label') || name}</span>
      <select
        className="obe-kit-select obe-kit-dropdown-select"
        value={options.includes(value) ? value : ''}
        aria-label={`${name} value`}
        disabled={editor.readOnly}
        onChange={(e) => set(editor, block, 'value', e.target.value)}
      >
        {!options.includes(value) && <option value="">—</option>}
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      <ConfigButton open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <NameField block={block} editor={editor} />
          <OptionsField block={block} editor={editor} />
          <WideField block={block} editor={editor} />
        </div>
      )}
    </div>
  );
};

// ── Toggle switch ────────────────────────────────────────────────────────────

const ToggleBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
  const name = blockProp<string>(block, 'name') ?? 'on';
  const value = Boolean(blockProp<boolean>(block, 'value') ?? false);

  return (
    <div className="obe-kit obe-kit-toggle" contentEditable={false} data-kit-name={name}>
      <span className="obe-kit-label">{blockProp<string>(block, 'label') || name}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={`${name} toggle`}
        className={`obe-kit-switch${value ? ' obe-kit-switch-on' : ''}`}
        disabled={editor.readOnly}
        onClick={() => set(editor, block, 'value', !value)}
      >
        <span className="obe-kit-knob" />
      </button>
      <ConfigButton open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <NameField block={block} editor={editor} />
          <label className="obe-kit-field">
            <span>label</span>
            <input className="obe-kit-name" value={blockProp<string>(block, 'label') ?? ''} readOnly={editor.readOnly} aria-label="Display label" onChange={(e) => set(editor, block, 'label', e.target.value)} />
          </label>
        </div>
      )}
    </div>
  );
};

// ── Location input ───────────────────────────────────────────────────────────

const LocationBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
  const [locating, setLocating] = useState(false);
  const name = blockProp<string>(block, 'name') ?? 'place';
  const lat = blockProp<number>(block, 'lat');
  const lng = blockProp<number>(block, 'lng');
  const hasCoords = typeof lat === 'number' && typeof lng === 'number';

  const setCoord = (key: 'lat' | 'lng', raw: string): void => {
    const v = raw.trim() === '' ? undefined : Number(raw);
    if (v === undefined || Number.isFinite(v)) set(editor, block, key, v);
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

  return (
    <div className="obe-kit obe-kit-location" contentEditable={false} data-kit-name={name}>
      <span className="obe-kit-label">{blockProp<string>(block, 'label') || name}</span>
      <input
        className="obe-kit-textinput"
        value={blockProp<string>(block, 'labeltext') ?? ''}
        placeholder="Place name…"
        aria-label={`${name} place`}
        readOnly={editor.readOnly}
        onChange={(e) => set(editor, block, 'labeltext', e.target.value)}
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
      <ConfigButton open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <NameField block={block} editor={editor} />
        </div>
      )}
    </div>
  );
};

// ── Action button ────────────────────────────────────────────────────────────

const ButtonBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
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

  return (
    <div className="obe-kit obe-kit-button" contentEditable={false}>
      <button type="button" className="obe-kit-action" onClick={fire} disabled={editor.readOnly && action !== 'link'}>
        {label}
      </button>
      <ConfigButton open={config} onClick={() => setConfig(!config)} />
      {config && (
        <div className="obe-kit-config">
          <label className="obe-kit-field">
            <span>label</span>
            <input className="obe-kit-name" value={label} readOnly={editor.readOnly} aria-label="Button label" onChange={(e) => set(editor, block, 'btnlabel', e.target.value)} />
          </label>
          <label className="obe-kit-field">
            <span>action</span>
            <select className="obe-kit-select" value={action} disabled={editor.readOnly} aria-label="Button action" onChange={(e) => set(editor, block, 'action', e.target.value)}>
              <option value="increment">increment input</option>
              <option value="set">set input</option>
              <option value="toggle">flip toggle</option>
              <option value="link">open link</option>
            </select>
          </label>
          {action === 'link' ? (
            <label className="obe-kit-field obe-kit-field-grow">
              <span>url</span>
              <input className="obe-kit-options" value={url} readOnly={editor.readOnly} aria-label="URL" placeholder="https://…" onChange={(e) => set(editor, block, 'url', e.target.value)} />
            </label>
          ) : (
            <>
              <label className="obe-kit-field">
                <span>input</span>
                <input className="obe-kit-name" value={target} readOnly={editor.readOnly} aria-label="Target input name" placeholder="x" onChange={(e) => set(editor, block, 'target', e.target.value.trim())} />
              </label>
              {action !== 'toggle' && (
                <label className="obe-kit-field">
                  <span>{action === 'set' ? 'value' : 'by'}</span>
                  <input
                    className="obe-kit-num"
                    inputMode="decimal"
                    value={blockProp<number>(block, 'amount') ?? 1}
                    readOnly={editor.readOnly}
                    aria-label="Amount"
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) set(editor, block, 'amount', v);
                    }}
                  />
                </label>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
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
      make: () => ({type: 'radio', props: {name: 'choice', options: 'One, Two, Three', value: 'One'}}),
    },
  },
  {
    type: 'checklist',
    render: ChecklistBlock,
    slash: {
      label: 'Choice checklist',
      hint: 'Pick any of several options',
      keywords: 'checklist checkbox multi select options form',
      make: () => ({type: 'checklist', props: {name: 'checks', options: 'Alpha, Beta, Gamma', selected: []}}),
    },
  },
  {
    type: 'dropdown',
    render: DropdownBlock,
    slash: {
      label: 'Dropdown',
      hint: 'Pick one option from a select',
      keywords: 'dropdown select choose option pick form menu',
      make: () => ({type: 'dropdown', props: {name: 'pick', options: 'One, Two, Three', value: 'One'}}),
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
