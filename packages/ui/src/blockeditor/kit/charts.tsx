import React, {useState} from 'react';
import {blockProp, setBlockProp, type BlockMap} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import type {CustomBlockProps} from '../registry';
import {evalExpr, inputScope} from './scope';
import {extent, funnelRows, linePoints, PALETTE, pieArcs, scale, ticks, toLabelled, toPoints, toSeries} from './chartMath';

/**
 * The kit's chart block: one block, many kinds (line, area, bar, pie, donut,
 * scatter, funnel). Data comes from an expression over the document's named
 * inputs, so a stepper click or radio pick redraws every chart that reads it
 * — that's the artifact loop. Rendering is plain SVG: no chart library, both
 * themes, and identical markup in the interactive HTML export.
 */

export const CHART_KINDS = ['line', 'area', 'bar', 'pie', 'donut', 'scatter', 'funnel'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

const W = 640;
const H = 240;
const PAD = 28;

const setProp = (editor: BlockEditorController, block: BlockMap, key: string, value: unknown): void =>
  editor.doc.transact(() => setBlockProp(block, key, value), 'local');

const splitLabels = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Light horizontal grid + tick labels shared by the XY kinds. */
const Grid: React.FC<{d: ReturnType<typeof extent>}> = ({d}) => (
  <g className="obe-chart-grid">
    {ticks(d).map((t) => {
      const y = scale(t, d, H - PAD, PAD);
      return (
        <g key={t}>
          <line x1={PAD} x2={W - PAD} y1={y} y2={y} />
          <text x={PAD - 6} y={y + 3}>
            {t}
          </text>
        </g>
      );
    })}
  </g>
);

const LineArea: React.FC<{value: unknown; area: boolean}> = ({value, area}) => {
  const series = toSeries(value);
  if (series.length === 0) return null;
  const d = extent(series.flatMap((s) => s.values));
  return (
    <>
      <Grid d={d} />
      {series.map((s, i) => {
        const pts = linePoints(s.values, d, W, H, PAD);
        const base = scale(Math.max(d.min, 0), d, H - PAD, PAD);
        const coords = pts.split(' ');
        const first = coords[0]?.split(',')[0];
        const last = coords[coords.length - 1]?.split(',')[0];
        return (
          <g key={i}>
            {area && <polygon points={`${first},${base} ${pts} ${last},${base}`} fill={PALETTE[i % PALETTE.length]} opacity={0.15} />}
            <polyline points={pts} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} strokeLinejoin="round" />
          </g>
        );
      })}
    </>
  );
};

const Bars: React.FC<{value: unknown; labels: string[]}> = ({value, labels}) => {
  const series = toSeries(value);
  if (series.length === 0) return null;
  const d = extent(series.flatMap((s) => s.values));
  const n = Math.max(...series.map((s) => s.values.length));
  const groupW = (W - PAD * 2) / n;
  const barW = Math.max((groupW * 0.7) / series.length, 2);
  const zero = scale(Math.max(d.min, 0), d, H - PAD, PAD);
  return (
    <>
      <Grid d={d} />
      {series.map((s, si) =>
        s.values.map((v, i) => {
          const y = scale(v, d, H - PAD, PAD);
          const x = PAD + i * groupW + groupW * 0.15 + si * barW;
          return <rect key={`${si}-${i}`} x={x} y={Math.min(y, zero)} width={barW - 1} height={Math.max(Math.abs(zero - y), 1)} rx={2} fill={PALETTE[si % PALETTE.length]} />;
        }),
      )}
      {labels.length > 0 && (
        <g className="obe-chart-xlabels">
          {labels.slice(0, n).map((l, i) => (
            <text key={i} x={PAD + i * groupW + groupW / 2} y={H - 8}>
              {l}
            </text>
          ))}
        </g>
      )}
    </>
  );
};

const PieDonut: React.FC<{value: unknown; labels: string[]; donut: boolean}> = ({value, labels, donut}) => {
  const slices = toLabelled(value, labels).filter((s) => s.value > 0);
  if (slices.length === 0) return null;
  const r = H / 2 - 16;
  const arcs = pieArcs(slices.map((s) => s.value), H / 2, H / 2, r, donut ? r * 0.55 : 0);
  return (
    <>
      {arcs.map((a, i) => (
        <path key={i} d={a.path} fill={PALETTE[i % PALETTE.length]} stroke="hsl(var(--background, 0 0% 100%))" strokeWidth={1.5} />
      ))}
      <g className="obe-chart-legend">
        {slices.map((s, i) => (
          <g key={i} transform={`translate(${H + 24}, ${28 + i * 20})`}>
            <rect width={10} height={10} rx={2} fill={PALETTE[i % PALETTE.length]} />
            <text x={16} y={9}>
              {s.label} · {Math.round((arcs[i]?.fraction ?? 0) * 100)}%
            </text>
          </g>
        ))}
      </g>
    </>
  );
};

const Scatter: React.FC<{value: unknown}> = ({value}) => {
  const pts = toPoints(value);
  if (pts.length === 0) return null;
  const dx = extent(pts.map((p) => p.x));
  const dy = extent(pts.map((p) => p.y));
  return (
    <>
      <Grid d={dy} />
      {pts.map((p, i) => (
        <circle key={i} cx={scale(p.x, dx, PAD, W - PAD)} cy={scale(p.y, dy, H - PAD, PAD)} r={4} fill={PALETTE[0]} opacity={0.75} />
      ))}
    </>
  );
};

const Funnel: React.FC<{value: unknown; labels: string[]}> = ({value, labels}) => {
  const stages = toLabelled(value, labels);
  if (stages.length === 0) return null;
  const rows = funnelRows(stages.map((s) => s.value), W - PAD * 2, H - PAD);
  return (
    <>
      {rows.map((r, i) => (
        <g key={i}>
          <rect x={PAD + r.x} y={12 + r.y} width={r.width} height={r.height} rx={4} fill={PALETTE[i % PALETTE.length]} opacity={0.85} />
          <text className="obe-chart-funnel-label" x={W / 2} y={12 + r.y + r.height / 2 + 4}>
            {stages[i].label} · {stages[i].value}
          </text>
        </g>
      ))}
    </>
  );
};

const ChartBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const [config, setConfig] = useState(false);
  const kind = (blockProp<string>(block, 'kind') as ChartKind) ?? 'line';
  const source = blockProp<string>(block, 'source') ?? '';
  const labels = splitLabels(blockProp<string>(block, 'labels') ?? '');
  const title = blockProp<string>(block, 'title') ?? '';
  const {value, error} = evalExpr(source, inputScope(editor.doc));

  const body = (() => {
    if (error) return <text className="obe-chart-msg" x={W / 2} y={H / 2}>⚠ {error}</text>;
    if (value === undefined || (kind !== 'scatter' && toSeries(value).length === 0 && toLabelled(value, labels).length === 0)) {
      return (
        <text className="obe-chart-msg" x={W / 2} y={H / 2}>
          {source.trim() ? 'no plottable data' : 'configure data ⚙ — e.g. [3, 1, 4, 1, 5] or {a: [1,2], b: [3,4]}'}
        </text>
      );
    }
    switch (kind) {
    case 'area':
      return <LineArea value={value} area />;
    case 'bar':
      return <Bars value={value} labels={labels} />;
    case 'pie':
      return <PieDonut value={value} labels={labels} donut={false} />;
    case 'donut':
      return <PieDonut value={value} labels={labels} donut />;
    case 'scatter':
      return <Scatter value={value} />;
    case 'funnel':
      return <Funnel value={value} labels={labels} />;
    default:
      return <LineArea value={value} area={false} />;
    }
  })();

  return (
    <figure className="obe-kit obe-kit-chart" contentEditable={false} data-chart-kind={kind}>
      <div className="obe-kit-chart-head">
        {title && <figcaption className="obe-kit-chart-title">{title}</figcaption>}
        <span className="obe-kit-spacer" />
        <ConfigGear open={config} onClick={() => setConfig(!config)} />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title || `${kind} chart`} className="obe-chart-svg">
        {body}
      </svg>
      {config && (
        <div className="obe-kit-config">
          <label className="obe-kit-field">
            <span>kind</span>
            <select className="obe-kit-select" value={kind} disabled={editor.readOnly} aria-label="Chart kind" onChange={(e) => setProp(editor, block, 'kind', e.target.value)}>
              {CHART_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="obe-kit-field obe-kit-field-grow">
            <span>data</span>
            <input
              className="obe-kit-options obe-kit-mono"
              value={source}
              readOnly={editor.readOnly}
              spellCheck={false}
              aria-label="Chart data expression"
              placeholder="[x, x*2, x*3]  ·  {a: [1,2,3], b: [2,4,6]}"
              onChange={(e) => setProp(editor, block, 'source', e.target.value)}
            />
          </label>
          <label className="obe-kit-field">
            <span>labels</span>
            <input className="obe-kit-name" value={blockProp<string>(block, 'labels') ?? ''} readOnly={editor.readOnly} aria-label="Labels (comma-separated)" placeholder="A, B, C" onChange={(e) => setProp(editor, block, 'labels', e.target.value)} />
          </label>
          <label className="obe-kit-field">
            <span>title</span>
            <input className="obe-kit-name" value={title} readOnly={editor.readOnly} aria-label="Chart title" onChange={(e) => setProp(editor, block, 'title', e.target.value)} />
          </label>
        </div>
      )}
    </figure>
  );
};

/** Same gear as the inputs use — duplicated locally to keep modules acyclic. */
const ConfigGear: React.FC<{open: boolean; onClick: () => void}> = ({open, onClick}) => (
  <button type="button" className={`obe-kit-gear${open ? ' obe-kit-gear-on' : ''}`} aria-label="Configure block" aria-expanded={open} onClick={onClick}>
    ⚙
  </button>
);

export const CHART_BLOCKS = [
  {
    type: 'kitchart',
    render: ChartBlock,
    slash: {
      label: 'Chart',
      hint: 'Line, bar, pie, scatter, funnel — live over inputs',
      keywords: 'chart graph plot line bar pie donut scatter funnel visualization',
      make: () => ({type: 'kitchart', props: {kind: 'line', source: '[3, 1, 4, 1, 5, 9, 2, 6]'}}),
    },
  },
] as const;
