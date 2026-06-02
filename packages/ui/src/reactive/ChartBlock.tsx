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
          '<div class="px-3 py-6 text-center text-xs text-muted-foreground/70">Pick at least one cell to plot</div>';
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
        note.className = 'px-3 py-6 text-center text-xs text-muted-foreground/70';
        note.textContent = 'No numeric array data in the selected cells';
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
        // Measure the container so the chart fills the document column and
        // stays responsive instead of a fixed 480px. Fall back to 640 before
        // first layout. Cap so it never overflows a wide full-width page.
        const measured = chartContainerRef.current.clientWidth || 640;
        const width = Math.max(280, Math.min(measured, 720));
        const chart = Plot.plot({
          marks: [Plot.lineY(longData, {x: 'i', y: 'y', stroke: 'series'})],
          width,
          height: Math.round(width * 0.5),
          marginTop: 16,
          marginRight: 16,
          marginBottom: 32,
          marginLeft: 40,
          // Inherit the document's theme: transparent surface, current text
          // color for axes/labels (so it reads correctly in light and dark).
          style: {background: 'transparent', color: 'currentColor', fontSize: '12px'},
          grid: true,
          color: {legend: usableSeries.length > 1},
        });
        chartContainerRef.current.appendChild(chart);
      } catch (e) {
        const errDiv = document.createElement('div');
        errDiv.className = 'px-3 py-2 text-xs font-medium text-destructive';
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
    <div className="reactive-block rounded-lg border border-border bg-muted/30 px-3.5 py-3 transition-colors focus-within:border-ring/60">
      <div className="mb-3 flex flex-col gap-1.5 text-xs text-muted-foreground">
        {rows.map((row, idx) => (
          <div key={row.rowKey} className="flex items-center gap-2">
            <span className="w-9 select-none text-muted-foreground/60">{idx === 0 ? 'plot' : 'and'}</span>
            <select
              value={row.cellId}
              onChange={(e) => setCellAt(idx, e.target.value)}
              className="h-8 max-w-[16rem] flex-1 rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring"
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
                title="Remove series"
                aria-label="Remove series"
                className="flex h-7 w-7 items-center justify-center rounded-md text-base text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addRow}
          className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          + add series
        </button>
      </div>
      <div ref={chartContainerRef} className="min-h-[2.5rem] overflow-hidden rounded-md bg-background/60" />
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
