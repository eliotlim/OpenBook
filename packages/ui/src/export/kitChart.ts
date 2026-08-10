/**
 * Kind-faithful kit-chart drawing (line, area, bar, pie, donut, scatter, funnel,
 * kpi, heatmap, combo) as pure SVG — no charting library. The geometry mirrors the editor's
 * `chartMath`, so an exported chart looks like the one in the window.
 *
 * The drawing lives as a JS **source string** ({@link KIT_CHART_JS}) so it has a
 * single definition used two ways: inlined verbatim into the standalone HTML
 * runtime (where it redraws live as sliders move), and executed here via
 * `new Function` for the static PDF export ({@link kitChartSvg}). Keeping it as
 * one string avoids the two copies drifting apart.
 *
 * The chart series colours are NOT baked into the string: {@link kitChartRuntime}
 * prepends `const KIT_PALETTE=[…]` resolved from the canonical `SERIES_ORDER`
 * (OB-378), so the exported charts share one palette source with the in-app kit
 * charts and can never drift.
 */
import {DATA_PALETTE, DEFAULT_DATA_COLOR_SCHEME, SERIES_ORDER, type DataColorScheme} from '@book.dev/sdk';

export const KIT_CHART_JS = `
function kitEsc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function kitSeries(v){ if(v&&typeof v==="object"&&Array.isArray(v.series)) return v.series.filter(s=>Array.isArray(s.data)&&s.data.every(n=>typeof n==="number")&&s.data.length).map(s=>({name:String(s.name??""),values:s.data})); if(Array.isArray(v)&&v.every(n=>typeof n==="number")) return v.length?[{name:"",values:v}]:[]; if(Array.isArray(v)&&v.length&&v.every(p=>p&&typeof p==="object"&&isFinite(p.x)&&isFinite(p.y))) return [{name:"",values:v.map(p=>p.y)}]; if(Array.isArray(v)&&v.every(a=>Array.isArray(a)&&a.every(n=>typeof n==="number"))) return v.filter(a=>a.length).map((a,i)=>({name:"s"+(i+1),values:a})); if(v&&typeof v==="object"&&!Array.isArray(v)) return Object.entries(v).filter(([,a])=>Array.isArray(a)&&a.every(n=>typeof n==="number")&&a.length).map(([n,a])=>({name:n,values:a})); if(typeof v==="number"&&isFinite(v)) return [{name:"",values:[v]}]; return []; }
function kitLabelled(v,labels){ if(v&&typeof v==="object"&&!Array.isArray(v)){ const e=Object.entries(v).filter(([,n])=>typeof n==="number"&&isFinite(n)); if(e.length) return e.map(([label,value])=>({label,value})); } if(Array.isArray(v)&&v.every(n=>typeof n==="number")) return v.map((value,i)=>({label:labels[i]||("#"+(i+1)),value})); return []; }
function kitExtent(vals){ if(!vals.length) return {min:0,max:1}; let min=Math.min.apply(null,vals.concat([0])), max=Math.max.apply(null,vals); if(min===max){min-=1;max+=1;} return {min,max}; }
function kitScale(v,d,r0,r1){ return r0+((v-d.min)/(d.max-d.min))*(r1-r0); }
function kitTicks(d){ const span=d.max-d.min, step0=Math.pow(10,Math.floor(Math.log10(span/3))); const step=[step0,step0*2,step0*5,step0*10].find(s=>span/s<=4)||step0*10; const out=[]; for(let v=Math.ceil(d.min/step)*step; v<=d.max+1e-9; v+=step) out.push(Math.round(v*1e6)/1e6); return out; }
function kitFmt(n){ return Number.isInteger(n)? n.toLocaleString() : n.toLocaleString(undefined,{maximumFractionDigits:2}); }
function kitTick(n){ var t=function(x){return String(Math.round(x*10)/10);}, a=Math.abs(n); if(a>=1e6) return t(n/1e6)+"M"; if(a>=1e3) return t(n/1e3)+"k"; return t(n); }
function kitFin(x){ return typeof x==="number"&&isFinite(x)?x:undefined; }
function kitTrunc(s,m){ s=String(s); return s.length>m ? s.slice(0,Math.max(1,m-1))+"…" : s; }
function kitKpi(v){ var n=kitFin(v); if(n!==undefined) return {value:n};
  if(Array.isArray(v)&&v.every(function(x){return kitFin(x)!==undefined;})) return v.length?{value:v.reduce(function(a,b){return a+b;},0)}:null;
  if(v&&typeof v==="object"&&!Array.isArray(v)){ var t=kitFin(v.target); if(t===undefined) t=kitFin(v.goal); var m=kitFin(v.value); if(m===undefined) m=kitFin(v.current); if(m===undefined) m=kitFin(v.total);
    if(m!==undefined) return {value:m,target:t};
    var ks=Object.keys(v).filter(function(k){return kitFin(v[k])!==undefined&&k!=="target"&&k!=="goal";}); if(ks.length) return {value:ks.reduce(function(a,k){return a+v[k];},0),target:t}; }
  var s=kitSeries(v); if(s.length&&s[0].values.length) return {value:s[0].values.reduce(function(a,b){return a+b;},0)}; return null; }
function kitGrid(v,labels){ var series=kitSeries(v); var nCols=series.reduce(function(m,s){return Math.max(m,s.values.length);},0); var cols=[]; for(var c=0;c<nCols;c++) cols.push(labels[c]||("#"+(c+1))); var rows=series.map(function(s){return s.name;}); var cells=series.map(function(s){return cols.map(function(_,c){return s.values[c];});}); return {rows:rows,cols:cols,cells:cells}; }
function kitGridVals(g){ var out=[]; g.cells.forEach(function(row){row.forEach(function(x){if(typeof x==="number") out.push(x);});}); return out; }
function drawKit(v,kind,labels){
  labels = labels || [];
  const W=660,H=300,PAD=34,P=KIT_PALETTE;
  const grid=(d)=>kitTicks(d).map(t=>{const y=kitScale(t,d,H-PAD,PAD);return '<line x1="'+PAD+'" x2="'+(W-PAD)+'" y1="'+y+'" y2="'+y+'" stroke="currentColor" opacity="0.15" stroke-dasharray="2 4"/><text x="'+(PAD-6)+'" y="'+(y+3)+'" font-size="10" fill="currentColor" opacity="0.55" text-anchor="end">'+kitTick(t)+'</text>';}).join('');
  let body='';
  if(kind==='pie'||kind==='donut'){
    const slices=kitLabelled(v,labels).filter(s=>s.value>0); if(!slices.length) return '';
    const total=slices.reduce((a,s)=>a+s.value,0), r=H/2-16, r0=kind==='donut'?r*0.55:0, cx=H/2, cy=H/2; let ang=-Math.PI/2;
    body=slices.map((s,i)=>{ const sweep=s.value/total*Math.PI*2, a0=ang, a1=ang+sweep; ang=a1; const end=sweep>=Math.PI*2-1e-6?a1-1e-4:a1, large=sweep>Math.PI?1:0; const pt=(a,rad)=>(cx+Math.cos(a)*rad)+','+(cy+Math.sin(a)*rad);
      const path=r0>0?'M '+pt(a0,r)+' A '+r+' '+r+' 0 '+large+' 1 '+pt(end,r)+' L '+pt(end,r0)+' A '+r0+' '+r0+' 0 '+large+' 0 '+pt(a0,r0)+' Z':'M '+cx+','+cy+' L '+pt(a0,r)+' A '+r+' '+r+' 0 '+large+' 1 '+pt(end,r)+' Z';
      return '<path d="'+path+'" fill="'+P[i%P.length]+'"/>';
    }).join('')+slices.map((s,i)=>'<g transform="translate('+(H+24)+','+(28+i*20)+')"><rect width="10" height="10" rx="2" fill="'+P[i%P.length]+'"/><text x="16" y="9" font-size="11" fill="currentColor" opacity="0.7">'+kitEsc(s.label)+' · '+Math.round(s.value/total*100)+'%</text></g>').join('');
  } else if(kind==='funnel'){
    const stages=kitLabelled(v,labels); const max=Math.max.apply(null,stages.map(s=>Math.max(0,s.value)).concat([0])); if(!stages.length||max<=0) return '';
    const gap=3, rowH=(H-PAD-gap*(stages.length-1))/stages.length;
    body=stages.map((s,i)=>{ const w=Math.max(Math.max(0,s.value)/max*(W-PAD*2),2), x=PAD+((W-PAD*2)-w)/2, y=12+i*(rowH+gap);
      return '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+rowH+'" rx="4" fill="'+P[i%P.length]+'" opacity="0.85"/><text x="'+(W/2)+'" y="'+(y+rowH/2+4)+'" font-size="11" font-weight="600" text-anchor="middle" fill="#fff">'+kitEsc(s.label)+' · '+s.value+'</text>';
    }).join('');
  } else if(kind==='scatter'){
    const pts=Array.isArray(v)&&v.length&&v.every(p=>p&&typeof p==="object"&&isFinite(p.x)&&isFinite(p.y))?v:(Array.isArray(v)&&v.every(n=>typeof n==="number")?v.map((y,x)=>({x,y})):[]); if(!pts.length) return '';
    const dx=kitExtent(pts.map(p=>p.x)), dy=kitExtent(pts.map(p=>p.y));
    body=grid(dy)+pts.map(p=>'<circle cx="'+kitScale(p.x,dx,PAD,W-PAD)+'" cy="'+kitScale(p.y,dy,H-PAD,PAD)+'" r="4" fill="'+P[0]+'" opacity="0.75"/>').join('');
  } else if(kind==='bar'){
    const series=kitSeries(v); if(!series.length) return '';
    const d=kitExtent(series.flatMap(s=>s.values)), n=Math.max.apply(null,series.map(s=>s.values.length)), groupW=(W-PAD*2)/n, barW=Math.max(groupW*0.7/series.length,2), zero=kitScale(Math.max(d.min,0),d,H-PAD,PAD);
    const barBudget=Math.max(3,Math.floor(groupW/6));
    body=grid(d)+series.map((s,si)=>s.values.map((val,i)=>{ const y=kitScale(val,d,H-PAD,PAD), x=PAD+i*groupW+groupW*0.15+si*barW; return '<rect x="'+x+'" y="'+Math.min(y,zero)+'" width="'+(barW-1)+'" height="'+Math.max(Math.abs(zero-y),1)+'" rx="2" fill="'+P[si%P.length]+'"/>'; }).join('')).join('')+labels.slice(0,n).map((l,i)=>'<text x="'+(PAD+i*groupW+groupW/2)+'" y="'+(H-8)+'" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.55"><title>'+kitEsc(l)+'</title>'+kitEsc(kitTrunc(l,barBudget))+'</text>').join('');
  } else if(kind==='kpi'){
    const kpi=kitKpi(v); if(!kpi) return '';
    const pct=(kpi.target>0)?Math.max(0,Math.min(100,Math.round(kpi.value/kpi.target*100))):null;
    const cap=labels.length===1?labels[0]:''; let s='';
    if(cap) s+='<text x="'+(W/2)+'" y="76" text-anchor="middle" font-size="14" font-weight="600" letter-spacing="0.6" fill="currentColor" opacity="0.6">'+kitEsc(String(cap).toUpperCase())+'</text>';
    s+='<text x="'+(W/2)+'" y="'+(pct!==null?160:172)+'" text-anchor="middle" font-size="76" font-weight="650" fill="currentColor">'+kitFmt(kpi.value)+'</text>';
    if(pct!==null){ const bw=W*0.5, bx=(W-bw)/2, by=232;
      s+='<text x="'+(W/2)+'" y="208" text-anchor="middle" font-size="16" fill="currentColor" opacity="0.6">'+pct+'% of '+kitFmt(kpi.target)+'</text>';
      s+='<rect x="'+bx+'" y="'+by+'" width="'+bw+'" height="9" rx="4.5" fill="currentColor" opacity="0.14"/>';
      s+='<rect x="'+bx+'" y="'+by+'" width="'+(bw*pct/100)+'" height="9" rx="4.5" fill="'+P[0]+'"/>'; }
    body=s;
  } else if(kind==='heatmap'){
    const g=kitGrid(v,labels), flat=kitGridVals(g); if(!g.rows.length||!g.cols.length||!flat.length) return '';
    const mn=Math.min.apply(null,flat), mx=Math.max.apply(null,flat);
    const showRow=g.rows.some(function(r){return r!=="";});
    const gutter=showRow?70:PAD, gy=14, gx=gutter, gw=W-gutter-PAD, gh=H-gy-22, cw=gw/g.cols.length, ch=gh/g.rows.length;
    const intensity=function(x){return mx===mn?0.55:0.14+0.82*((x-mn)/(mx-mn));};
    let s='';
    g.rows.forEach(function(rn,r){ g.cols.forEach(function(cl,c){ const x=gx+c*cw, y=gy+r*ch, val=g.cells[r][c];
      if(typeof val!=="number"){ s+='<rect x="'+(x+1)+'" y="'+(y+1)+'" width="'+(cw-2)+'" height="'+(ch-2)+'" rx="3" fill="currentColor" opacity="0.06"/>'; return; }
      const iv=intensity(val);
      s+='<rect x="'+(x+1)+'" y="'+(y+1)+'" width="'+(cw-2)+'" height="'+(ch-2)+'" rx="3" fill="'+P[0]+'" fill-opacity="'+iv+'"/>';
      // Ink by intensity, not theme: a near-opaque pale cell washes out the
      // exported foreground in a dark-theme export, so pin a dark ink above 0.6.
      if(cw>34&&ch>18){ const ink=iv>0.6?'fill="#233246"':'fill="currentColor" opacity="0.85"'; s+='<text x="'+(x+cw/2)+'" y="'+(y+ch/2+4)+'" text-anchor="middle" font-size="11" '+ink+'>'+kitFmt(val)+'</text>'; } }); });
    if(showRow) g.rows.forEach(function(rn,r){ if(rn) s+='<text x="'+(gutter-8)+'" y="'+(gy+r*ch+ch/2+3)+'" text-anchor="end" font-size="11" fill="currentColor" opacity="0.6">'+kitEsc(rn)+'</text>'; });
    g.cols.forEach(function(cl,c){ s+='<text x="'+(gx+c*cw+cw/2)+'" y="'+(H-7)+'" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">'+kitEsc(cl)+'</text>'; });
    body=s;
  } else if(kind==='combo'){
    const g=kitGrid(v,labels), flat=kitGridVals(g); if(!g.rows.length||!g.cols.length||!flat.length) return '';
    const d=kitExtent(flat), n=g.cols.length, groupW=(W-PAD*2)/n, zero=kitScale(Math.max(d.min,0),d,H-PAD,PAD), barW=Math.max(groupW*0.5,2);
    const px=function(c){return PAD+c*groupW+groupW/2;};
    let s=grid(d);
    g.cells[0].forEach(function(val,c){ if(typeof val!=="number") return; const y=kitScale(val,d,H-PAD,PAD), x=PAD+c*groupW+(groupW-barW)/2; s+='<rect x="'+x+'" y="'+Math.min(y,zero)+'" width="'+barW+'" height="'+Math.max(Math.abs(zero-y),1)+'" rx="2" fill="'+P[0]+'"/>'; });
    for(let r=1;r<g.rows.length;r++){ const color=P[r%P.length]; const pts=g.cells[r].map(function(val,c){return typeof val==="number"?(px(c)+','+kitScale(val,d,H-PAD,PAD)):null;}).filter(Boolean).join(' '); if(pts) s+='<polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round"/>'; }
    s+=g.cols.map(function(l,c){return '<text x="'+px(c)+'" y="'+(H-8)+'" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.55">'+kitEsc(l)+'</text>';}).join('');
    body=s;
  } else { // line / area
    const series=kitSeries(v); if(!series.length) return '';
    const d=kitExtent(series.flatMap(s=>s.values)), base=kitScale(Math.max(d.min,0),d,H-PAD,PAD);
    const n=Math.max.apply(null,series.map(s=>s.values.length));
    body=grid(d)+series.map((s,i)=>{ const len=s.values.length; const pts=s.values.map((val,j)=>{ const x=len===1?W/2:PAD+(j/(len-1))*(W-PAD*2); return (Math.round(x*10)/10)+','+(Math.round(kitScale(val,d,H-PAD,PAD)*10)/10); }).join(' ');
      const first=pts.split(' ')[0].split(',')[0], parts=pts.split(' '), last=parts[parts.length-1].split(',')[0];
      return (kind==='area'?'<polygon points="'+first+','+base+' '+pts+' '+last+','+base+'" fill="'+P[i%P.length]+'" opacity="0.15"/>':'')+'<polyline points="'+pts+'" fill="none" stroke="'+P[i%P.length]+'" stroke-width="2" stroke-linejoin="round"/>';
    }).join('')+labels.slice(0,n).map((l,i)=>'<text x="'+(n===1?W/2:PAD+(i/(n-1))*(W-PAD*2))+'" y="'+(H-8)+'" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.55">'+kitEsc(l)+'</text>').join('');
  }
  if(kind!=='pie'&&kind!=='donut'&&kind!=='funnel'&&kind!=='scatter'&&kind!=='kpi'&&kind!=='heatmap'){
    const named=kitSeries(v).filter(s=>s.name);
    // Line series (line/area everywhere; combo's overlaid series beyond the bar)
    // get a rule glyph, not a square, so the legend matches the mark it stands for.
    if(named.length>1) body+=named.map((s,i)=>{ const isLine=kind==='line'||kind==='area'||(kind==='combo'&&i>0); const g=isLine?'<line x1="0" y1="5" x2="12" y2="5" stroke="'+P[i%P.length]+'" stroke-width="2" stroke-linecap="round"/>':'<rect width="10" height="10" rx="2" fill="'+P[i%P.length]+'"/>'; return '<g transform="translate('+(W-PAD-90)+','+(16+i*18)+')">'+g+'<text x="16" y="9" font-size="11" fill="currentColor" opacity="0.7">'+kitEsc(s.name)+'</text></g>'; }).join('');
  }
  return '<svg viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">'+body+'</svg>';
}
`;

/** The chart's fixed view-box dimensions (mirrors the source above). */
export const KIT_CHART_W = 660;
export const KIT_CHART_H = 300;

/** The canonical series fills, as a JS literal to prepend to {@link KIT_CHART_JS}. */
export const kitPaletteJs = (scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME): string =>
  `const KIT_PALETTE=${JSON.stringify(SERIES_ORDER.map((t) => DATA_PALETTE[scheme][t].fill))};`;

/**
 * The full kit-chart runtime — the canonical palette prepended to the drawing
 * source. Use this (not {@link KIT_CHART_JS} raw) everywhere the chart is drawn:
 * the standalone HTML runtime and the static PDF `new Function`, so both inline
 * the same series colours from one source.
 */
export const kitChartRuntime = (scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME): string =>
  `${kitPaletteJs(scheme)}\n${KIT_CHART_JS}`;

type DrawFn = (value: unknown, kind: string, labels: string[]) => string;
// One compiled drawing per scheme — the palette is baked into the runtime string,
// so the fills differ by scheme (OB-379); cache each so we compile at most once.
const drawByScheme = new Map<DataColorScheme, DrawFn>();

/**
 * Draw a kit chart to an SVG string for a value/kind/labels in `scheme` — the
 * static-export counterpart of the runtime's live redraw. Returns '' when
 * there's nothing plottable.
 */
export function kitChartSvg(
  value: unknown,
  kind: string,
  labels: string[] = [],
  scheme: DataColorScheme = DEFAULT_DATA_COLOR_SCHEME,
): string {
  let draw = drawByScheme.get(scheme);
  if (!draw) {
    // eslint-disable-next-line no-new-func -- Static export shares the legacy runtime pending OB-146.
    draw = new Function(`${kitChartRuntime(scheme)}\nreturn drawKit;`)() as DrawFn;
    drawByScheme.set(scheme, draw);
  }
  try {
    return draw(value, kind, labels);
  } catch {
    return '';
  }
}
