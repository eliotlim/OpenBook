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
    <div style={{padding: '8px', border: '1px solid #ddd', borderRadius: '4px', background: '#fafafa'}}>
      <div style={{display: 'flex', gap: '8px', marginBottom: '6px', fontSize: '12px', color: '#666'}}>
        <label>
          name:{' '}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{width: '120px'}}
          />
        </label>
        <label>
          min:{' '}
          <input
            type="number"
            value={min}
            onChange={(e) => setMin(Number(e.target.value))}
            style={{width: '80px'}}
          />
        </label>
        <label>
          max:{' '}
          <input
            type="number"
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
            style={{width: '80px'}}
          />
        </label>
        <label>
          step:{' '}
          <input
            type="number"
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
            style={{width: '80px'}}
          />
        </label>
      </div>
      <div style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          style={{flex: 1}}
        />
        <code style={{minWidth: '80px', textAlign: 'right'}}>{value}</code>
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
