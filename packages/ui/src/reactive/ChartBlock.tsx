import React, {useEffect, useRef, useState} from 'react';
import type {ReactElement} from 'react';
import type {ToolboxConfig} from '@editorjs/editorjs';
import * as Plot from '@observablehq/plot';
import {effect} from '@preact/signals-core';
import {ReactBlockTool, type ReactiveBlockData} from './editorJsReactAdapter';
import {store} from './ReactiveStore';
import {normalizeChartInput, type NormalizedSeries} from './chartNormalize';
import {Skeleton} from '@/components/ui/skeleton';
import {Select} from '@/components/ui/select';
import {ReactiveCard} from './blockChrome';
import {t} from '@/i18n';

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
  // Render phase drives the skeleton vs chart vs message, so the block reserves
  // its height up front and never jumps as data (re)computes. Starts 'pending'
  // when there are cells to plot (skeleton shows immediately, before the first
  // effect run), 'idle' (a short note) when there's nothing to plot yet.
  const [phase, setPhase] = useState<'idle' | 'pending' | 'ready'>(initialIds.length > 0 ? 'pending' : 'idle');
  const [note, setNote] = useState<string>(t('blocks.chartPick'));
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const nextKeyRef = useRef<number>(rows.length);

  // Build the dropdown of available cell names by subscribing to namesVersion.
  useEffect(() => {
    return effect(() => {
      // Read namesVersion to subscribe to name changes.
      void store.namesVersion.value;
      setAvailableCells(store.snapshot().names.slice());
    });
  }, []);

  // Reactive chart rendering: re-render whenever ANY referenced cell value changes.
  // Reading each cellId inside the effect auto-subscribes via Signals tracking.
  useEffect(() => {
    const activeIds = rows.map((r) => r.cellId).filter(Boolean);
    if (activeIds.length === 0) {
      setPhase('idle');
      setNote(t('blocks.chartPick'));
      if (chartContainerRef.current) chartContainerRef.current.innerHTML = '';
      return;
    }
    return effect(() => {
      const allSeries: NormalizedSeries[] = [];
      let anyPending = false;
      for (const cellId of activeIds) {
        const value = store.getByCellId(cellId);
        if (value === undefined) anyPending = true;
        const fallback = store.getName(cellId) ?? cellId;
        allSeries.push(...normalizeChartInput(value, fallback));
      }
      const usableSeries = allSeries.filter((s) => s.data.length > 0);
      if (usableSeries.length === 0) {
        // A referenced cell hasn't produced a value yet → keep the skeleton
        // (reserve height, no jump). Genuinely non-numeric data → a short note.
        if (anyPending) {
          setPhase('pending');
        } else {
          setPhase('idle');
          setNote(t('blocks.chartNoData'));
        }
        if (chartContainerRef.current) chartContainerRef.current.innerHTML = '';
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
      if (!chartContainerRef.current) return;
      try {
        // Measure the container so the chart fills the document column and
        // stays responsive instead of a fixed 480px. Fall back to 640 before
        // first layout. Cap so it never overflows a wide full-width page. (The
        // container keeps full width even while the skeleton reserves height,
        // so this measures correctly on the pending → ready transition.)
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
        chartContainerRef.current.innerHTML = '';
        chartContainerRef.current.appendChild(chart);
        setPhase('ready');
      } catch (e) {
        setPhase('idle');
        setNote(`Plot error: ${(e as Error).message}`);
        chartContainerRef.current.innerHTML = '';
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
    <ReactiveCard className="group/chart">
      <div className="mb-3 flex flex-col gap-1.5 text-xs text-muted-foreground">
        {rows.map((row, idx) => (
          <div key={row.rowKey} className="flex items-center gap-2">
            <span className="w-9 select-none text-muted-foreground/60">{idx === 0 ? t('blocks.chartPlot') : t('blocks.chartAnd')}</span>
            <Select
              inputSize="sm"
              wrapperClassName="max-w-[16rem] flex-1"
              value={row.cellId}
              onChange={(e) => setCellAt(idx, e.target.value)}
            >
              <option value="">{t('blocks.chartPickCell')}</option>
              {availableCells.map(([name, cellId]) => (
                <option key={cellId} value={cellId}>
                  {name}
                </option>
              ))}
            </Select>
            {rows.length > 1 && (
              <button
                type="button"
                onClick={() => removeRow(idx)}
                title={t('blocks.chartRemoveSeries')}
                aria-label={t('blocks.chartRemoveSeries')}
                className="flex h-7 w-7 items-center justify-center rounded-md text-base text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                ×
              </button>
            )}
          </div>
        ))}
        {/* Quiet until the block is hovered or focused — like the expr hint,
            it's configuration chrome, not content. */}
        <button
          type="button"
          onClick={addRow}
          className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-focus-within/chart:opacity-100 group-hover/chart:opacity-100"
        >
          {`+ ${t('blocks.chartAddSeries')}`}
        </button>
      </div>
      <div className="overflow-hidden rounded-md bg-background/60">
        {/* The chart mounts here. While not ready it's collapsed to height 0 but
            keeps full width (so the effect can still measure it); the skeleton
            below reserves the chart's eventual height (~2:1) so nothing jumps. */}
        <div ref={chartContainerRef} className={phase === 'ready' ? '' : 'h-0 overflow-hidden'} />
        {phase === 'pending' && <Skeleton className="aspect-[2/1] w-full" />}
        {phase === 'idle' && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground/70">{note}</div>
        )}
      </div>
    </ReactiveCard>
  );
};

export class ChartBlock extends ReactBlockTool {
  static get toolbox(): ToolboxConfig {
    return {
      title: t('blocks.chart'),
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
