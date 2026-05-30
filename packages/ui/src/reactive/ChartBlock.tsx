import React, {useEffect, useRef, useState} from 'react';
import type {ReactElement} from 'react';
import type {ToolboxConfig} from '@editorjs/editorjs';
import * as Plot from '@observablehq/plot';
import {effect} from '@preact/signals-core';
import {ReactBlockTool, type ReactiveBlockData} from './editorJsReactAdapter';
import {store} from './ReactiveStore';
import {normalizeChartInput, type NormalizedSeries} from './chartNormalize';

interface ChartBlockData extends ReactiveBlockData {
  // Multi-series: one cellId per series row in the picker UI.
  refCellIds?: string[];
  // Legacy single-cell form. If present and refCellIds is absent, treated as [refCellId].
  refCellId?: string;
}

interface PickerRow {
  rowKey: string;
  cellId: string;
}

interface ChartComponentProps {
  initialData: ChartBlockData;
  onChange: (data: ChartBlockData) => void;
}

const ChartComponent: React.FC<ChartComponentProps> = ({initialData, onChange}) => {
  // Hydrate from legacy single-cell shape if needed.
  const initialIds: string[] =
    initialData.refCellIds ?? (initialData.refCellId ? [initialData.refCellId] : []);
  const [rows, setRows] = useState<PickerRow[]>(
    initialIds.length > 0
      ? initialIds.map((cellId, i) => ({rowKey: `row-${i}-${Math.random().toString(36).slice(2, 6)}`, cellId}))
      : [{rowKey: 'row-0', cellId: ''}],
  );
  const [availableCells, setAvailableCells] = useState<Array<[string, string]>>([]);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const nextKeyRef = useRef<number>(rows.length);

  // Build the dropdown of available cell names by subscribing to namesVersion.
  useEffect(() => {
    return effect(() => {
      store.namesVersion.value;
      setAvailableCells(store.snapshot().names.slice());
    });
  }, []);

  // Reactive chart rendering: re-render whenever ANY referenced cell value changes.
  // Reading each cellId inside the effect auto-subscribes via Signals tracking.
  useEffect(() => {
    const activeIds = rows.map((r) => r.cellId).filter(Boolean);
    if (activeIds.length === 0) {
      if (chartContainerRef.current) {
        chartContainerRef.current.innerHTML =
          '<div style="color:#999;font-size:12px;padding:8px">pick at least one cell</div>';
      }
      return;
    }
    return effect(() => {
      const allSeries: NormalizedSeries[] = [];
      for (const cellId of activeIds) {
        const value = store.getByCellId(cellId);
        const fallback = store.getName(cellId) ?? cellId;
        allSeries.push(...normalizeChartInput(value, fallback));
      }
      if (!chartContainerRef.current) return;
      chartContainerRef.current.innerHTML = '';
      const usableSeries = allSeries.filter((s) => s.data.length > 0);
      if (usableSeries.length === 0) {
        const note = document.createElement('div');
        note.style.cssText = 'color:#999;font-size:12px;padding:8px';
        note.textContent = 'no numeric array data in selected cells';
        chartContainerRef.current.appendChild(note);
        return;
      }
      // Long format: one row per (series, index, value). Plot handles
      // unequal series lengths by leaving short series short.
      const longData: Array<{i: number; y: number; series: string}> = [];
      for (const s of usableSeries) {
        for (let i = 0; i < s.data.length; i++) {
          longData.push({i, y: s.data[i], series: s.name});
        }
      }
      try {
        const chart = Plot.plot({
          marks: [Plot.lineY(longData, {x: 'i', y: 'y', stroke: 'series'})],
          width: 480,
          height: 240,
          margin: 36,
          color: {legend: true},
        });
        chartContainerRef.current.appendChild(chart);
      } catch (e) {
        const errDiv = document.createElement('div');
        errDiv.style.cssText = 'color:#b00020;font-size:12px;padding:8px';
        errDiv.textContent = `Plot error: ${(e as Error).message}`;
        chartContainerRef.current.appendChild(errDiv);
      }
    });
    // Re-run the effect whenever the picker rows change.
  }, [rows]);

  // Persist data changes back to the block (cellIds only; row keys are UI-only).
  useEffect(() => {
    onChange({refCellIds: rows.map((r) => r.cellId).filter(Boolean)});
  }, [rows, onChange]);

  const setCellAt = (idx: number, cellId: string) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? {...r, cellId} : r)));
  const addRow = () => {
    nextKeyRef.current += 1;
    setRows((prev) => [...prev, {rowKey: `row-${nextKeyRef.current}`, cellId: ''}]);
  };
  const removeRow = (idx: number) => setRows((prev) => prev.filter((_, i) => i !== idx));

  return (
    <div style={{padding: '8px', border: '1px solid #ddd', borderRadius: '4px', background: '#fafafa'}}>
      <div style={{display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px', fontSize: '12px', color: '#666'}}>
        {rows.map((row, idx) => (
          <div key={row.rowKey} style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
            <span style={{minWidth: '48px'}}>{idx === 0 ? 'plot:' : 'and:'}</span>
            <select
              value={row.cellId}
              onChange={(e) => setCellAt(idx, e.target.value)}
              style={{flex: 1, maxWidth: '200px'}}
            >
              <option value="">— pick a cell —</option>
              {availableCells.map(([name, cellId]) => (
                <option key={cellId} value={cellId}>
                  {name}
                </option>
              ))}
            </select>
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => removeRow(idx)}
                title="remove series"
                style={{
                  padding: '0 6px',
                  background: 'transparent',
                  border: '1px solid #ccc',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  color: '#666',
                  fontSize: '13px',
                  lineHeight: '18px',
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addRow}
          style={{
            alignSelf: 'flex-start',
            marginTop: '2px',
            padding: '2px 8px',
            background: 'transparent',
            border: '1px dashed #bbb',
            borderRadius: '3px',
            cursor: 'pointer',
            color: '#666',
            fontSize: '11px',
          }}
        >
          + add series
        </button>
      </div>
      <div ref={chartContainerRef} style={{minHeight: '40px', background: 'white'}} />
    </div>
  );
};

export class ChartBlock extends ReactBlockTool {
  static get toolbox(): ToolboxConfig {
    return {
      title: 'Chart',
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 17 9 11 13 15 21 7"/></svg>',
    };
  }

  static get pasteConfig(): false {
    return false;
  }

  protected toolName(): string {
    return 'reactive-chart';
  }

  protected renderComponent(): ReactElement {
    return (
      <ChartComponent
        initialData={this.data as ChartBlockData}
        onChange={(data) => {
          this.data = data;
        }}
      />
    );
  }

  save(): ChartBlockData {
    return this.data as ChartBlockData;
  }
}
