import React, {useEffect, useState} from 'react';
import type {ReactElement} from 'react';
import type {ToolboxConfig} from '@editorjs/editorjs';
import {ReactBlockTool, type ReactiveBlockData} from './editorJsReactAdapter';
import {store} from './ReactiveStore';
import {useReactiveCell} from './useReactiveCell';

interface SliderBlockData extends ReactiveBlockData {
  name?: string;
  min?: number;
  max?: number;
  step?: number;
  initial?: number;
}

interface SliderComponentProps {
  cellId: string;
  initialData: SliderBlockData;
  onChange: (data: SliderBlockData) => void;
}

const SliderComponent: React.FC<SliderComponentProps> = ({cellId, initialData, onChange}) => {
  const [name, setName] = useState(initialData.name ?? 'slider');
  const [min, setMin] = useState(initialData.min ?? 0);
  const [max, setMax] = useState(initialData.max ?? 100);
  const [step, setStep] = useState(initialData.step ?? 1);
  const [value, setValue] = useState(() => {
    // Restore from store if hydrated; otherwise use initial.
    const v = store.getByCellId(cellId);
    return typeof v === 'number' ? v : (initialData.initial ?? min);
  });

  useReactiveCell(cellId, name);

  // Push initial value into the store on mount AND on any change.
  useEffect(() => {
    store.setByCellId(cellId, value);
  }, [cellId, value]);

  // Persist data changes back to the block (for EditorJS save()).
  useEffect(() => {
    onChange({name, min, max, step, initial: value});
  }, [name, min, max, step, value, onChange]);

  return (
    <div className="reactive-block group/block rounded-lg border border-border bg-muted/30 px-3.5 py-3 transition-colors focus-within:border-ring/60">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <label className="inline-flex items-center gap-1.5">
          <span className="select-none text-muted-foreground/70">name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-28 rounded-md border border-input bg-background px-2 py-1 font-mono text-[13px] text-foreground outline-hidden transition-colors focus:border-ring focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="inline-flex items-center gap-1.5">
          <span className="select-none text-muted-foreground/70">min</span>
          <input
            type="number"
            value={min}
            onChange={(e) => setMin(Number(e.target.value))}
            className="w-16 rounded-md border border-input bg-background px-2 py-1 text-[13px] tabular-nums text-foreground outline-hidden transition-colors focus:border-ring focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="inline-flex items-center gap-1.5">
          <span className="select-none text-muted-foreground/70">max</span>
          <input
            type="number"
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
            className="w-16 rounded-md border border-input bg-background px-2 py-1 text-[13px] tabular-nums text-foreground outline-hidden transition-colors focus:border-ring focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="inline-flex items-center gap-1.5">
          <span className="select-none text-muted-foreground/70">step</span>
          <input
            type="number"
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
            className="w-16 rounded-md border border-input bg-background px-2 py-1 text-[13px] tabular-nums text-foreground outline-hidden transition-colors focus:border-ring focus:ring-1 focus:ring-ring"
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer accent-brand"
          aria-label={name}
        />
        <code className="min-w-14 rounded-md bg-brand-subtle px-2 py-1 text-right text-[13px] font-semibold tabular-nums text-brand">
          {value}
        </code>
      </div>
    </div>
  );
};

export class SliderBlock extends ReactBlockTool {
  static get toolbox(): ToolboxConfig {
    return {
      title: 'Slider',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><circle cx="9" cy="12" r="3" fill="currentColor"/></svg>',
    };
  }

  static get pasteConfig(): false {
    return false;
  }

  protected toolName(): string {
    return 'reactive-slider';
  }

  protected renderComponent(): ReactElement {
    return (
      <SliderComponent
        cellId={this.cellId}
        initialData={this.data as SliderBlockData}
        onChange={(data) => {
          this.data = data;
        }}
      />
    );
  }

  save(): SliderBlockData {
    return this.data as SliderBlockData;
  }
}
