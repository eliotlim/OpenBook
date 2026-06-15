/**
 * Kind-faithful kit-chart drawing (line, area, bar, pie, donut, scatter, funnel)
 * as pure SVG — no charting library. The geometry mirrors the editor's
 * `chartMath`, so an exported chart looks like the one in the window.
 *
 * The drawing lives as a JS **source string** ({@link KIT_CHART_JS}) so it has a
 * single definition used two ways: inlined verbatim into the standalone HTML
 * runtime (where it redraws live as sliders move), and executed here via
 * `new Function` for the static PDF export ({@link kitChartSvg}). Keeping it as
 * one string avoids the two copies drifting apart.
 */

export const KIT_CHART_JS = `
const KIT_PALETTE=["#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4","#f97316","#14b8a6"];
function kitSeries(v){ if(v&&typeof v==="object"&&Array.isArray(v.series)) return v.series.filter(s=>Array.isArray(s.data)&&s.data.every(n=>typeof n==="number")&&s.data.length).map(s=>({name:String(s.name??""),values:s.data})); if(Array.isArray(v)&&v.every(n=>typeof n==="number")) return v.length?[{name:"",values:v}]:[]; if(Array.isArray(v)&&v.length&&v.every(p=>p&&typeof p==="object"&&isFinite(p.x)&&isFinite(p.y))) return [{name:"",values:v.map(p=>p.y)}]; if(Array.isArray(v)&&v.every(a=>Array.isArray(a)&&a.every(n=>typeof n==="number"))) return v.filter(a=>a.length).map((a,i)=>({name:"s"+(i+1),values:a})); if(v&&typeof v==="object"&&!Array.isArray(v)) return Object.entries(v).filter(([,a])=>Array.isArray(a)&&a.every(n=>typeof n==="number")&&a.length).map(([n,a])=>({name:n,values:a})); if(typeof v==="number"&&isFinite(v)) return [{name:"",values:[v]}]; return []; }
function kitLabelled(v,labels){ if(v&&typeof v==="object"&&!Array.isArray(v)){ const e=Object.entries(v).filter(([,n])=>typeof n==="number"&&isFinite(n)); if(e.length) return e.map(([label,value])=>({label,value})); } if(Array.isArray(v)&&v.every(n=>typeof n==="number")) return v.map((value,i)=>({label:labels[i]||("#"+(i+1)),value})); return []; }
function kitExtent(vals){ if(!vals.length) return {min:0,max:1}; let min=Math.min.apply(null,vals.concat([0])), max=Math.max.apply(null,vals); if(min===max){min-=1;max+=1;} return {min,max}; }
function kitScale(v,d,r0,r1){ return r0+((v-d.min)/(d.max-d.min))*(r1-r0); }
function kitTicks(d){ const span=d.max-d.min, step0=Math.pow(10,Math.floor(Math.log10(span/3))); const step=[step0,step0*2,step0*5,step0*10].find(s=>span/s<=4)||step0*10; const out=[]; for(let v=Math.ceil(d.min/step)*step; v<=d.max+1e-9; v+=step) out.push(Math.round(v*1e6)/1e6); return out; }
function drawKit(v,kind,labels){
  labels = labels || [];
  const W=660,H=300,PAD=34,P=KIT_PALETTE;
  const grid=(d)=>kitTicks(d).map(t=>{const y=kitScale(t,d,H-PAD,PAD);return '<line x1="'+PAD+'" x2="'+(W-PAD)+'" y1="'+y+'" y2="'+y+'" stroke="currentColor" opacity="0.15" stroke-dasharray="2 4"/><text x="'+(PAD-6)+'" y="'+(y+3)+'" font-size="10" fill="currentColor" opacity="0.55" text-anchor="end">'+t+'</text>';}).join('');
  let body='';
  if(kind==='pie'||kind==='donut'){
    const slices=kitLabelled(v,labels).filter(s=>s.value>0); if(!slices.length) return '';
    const total=slices.reduce((a,s)=>a+s.value,0), r=H/2-16, r0=kind==='donut'?r*0.55:0, cx=H/2, cy=H/2; let ang=-Math.PI/2;
    body=slices.map((s,i)=>{ const sweep=s.value/total*Math.PI*2, a0=ang, a1=ang+sweep; ang=a1; const end=sweep>=Math.PI*2-1e-6?a1-1e-4:a1, large=sweep>Math.PI?1:0; const pt=(a,rad)=>(cx+Math.cos(a)*rad)+','+(cy+Math.sin(a)*rad);
      const path=r0>0?'M '+pt(a0,r)+' A '+r+' '+r+' 0 '+large+' 1 '+pt(end,r)+' L '+pt(end,r0)+' A '+r0+' '+r0+' 0 '+large+' 0 '+pt(a0,r0)+' Z':'M '+cx+','+cy+' L '+pt(a0,r)+' A '+r+' '+r+' 0 '+large+' 1 '+pt(end,r)+' Z';
      return '<path d="'+path+'" fill="'+P[i%P.length]+'"/>';
    }).join('')+slices.map((s,i)=>'<g transform="translate('+(H+24)+','+(28+i*20)+')"><rect width="10" height="10" rx="2" fill="'+P[i%P.length]+'"/><text x="16" y="9" font-size="11" fill="currentColor" opacity="0.7">'+s.label+' · '+Math.round(s.value/total*100)+'%</text></g>').join('');
  } else if(kind==='funnel'){
    const stages=kitLabelled(v,labels); const max=Math.max.apply(null,stages.map(s=>Math.max(0,s.value)).concat([0])); if(!stages.length||max<=0) return '';
    const gap=3, rowH=(H-PAD-gap*(stages.length-1))/stages.length;
    body=stages.map((s,i)=>{ const w=Math.max(Math.max(0,s.value)/max*(W-PAD*2),2), x=PAD+((W-PAD*2)-w)/2, y=12+i*(rowH+gap);
      return '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+rowH+'" rx="4" fill="'+P[i%P.length]+'" opacity="0.85"/><text x="'+(W/2)+'" y="'+(y+rowH/2+4)+'" font-size="11" font-weight="600" text-anchor="middle" fill="#fff">'+s.label+' · '+s.value+'</text>';
    }).join('');
  } else if(kind==='scatter'){
    const pts=Array.isArray(v)&&v.length&&v.every(p=>p&&typeof p==="object"&&isFinite(p.x)&&isFinite(p.y))?v:(Array.isArray(v)&&v.every(n=>typeof n==="number")?v.map((y,x)=>({x,y})):[]); if(!pts.length) return '';
    const dx=kitExtent(pts.map(p=>p.x)), dy=kitExtent(pts.map(p=>p.y));
    body=grid(dy)+pts.map(p=>'<circle cx="'+kitScale(p.x,dx,PAD,W-PAD)+'" cy="'+kitScale(p.y,dy,H-PAD,PAD)+'" r="4" fill="'+P[0]+'" opacity="0.75"/>').join('');
  } else if(kind==='bar'){
    const series=kitSeries(v); if(!series.length) return '';
    const d=kitExtent(series.flatMap(s=>s.values)), n=Math.max.apply(null,series.map(s=>s.values.length)), groupW=(W-PAD*2)/n, barW=Math.max(groupW*0.7/series.length,2), zero=kitScale(Math.max(d.min,0),d,H-PAD,PAD);
    body=grid(d)+series.map((s,si)=>s.values.map((val,i)=>{ const y=kitScale(val,d,H-PAD,PAD), x=PAD+i*groupW+groupW*0.15+si*barW; return '<rect x="'+x+'" y="'+Math.min(y,zero)+'" width="'+(barW-1)+'" height="'+Math.max(Math.abs(zero-y),1)+'" rx="2" fill="'+P[si%P.length]+'"/>'; }).join('')).join('')+labels.slice(0,n).map((l,i)=>'<text x="'+(PAD+i*groupW+groupW/2)+'" y="'+(H-8)+'" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.55">'+l+'</text>').join('');
  } else { // line / area
    const series=kitSeries(v); if(!series.length) return '';
    const d=kitExtent(series.flatMap(s=>s.values)), base=kitScale(Math.max(d.min,0),d,H-PAD,PAD);
    const n=Math.max.apply(null,series.map(s=>s.values.length));
    body=grid(d)+series.map((s,i)=>{ const len=s.values.length; const pts=s.values.map((val,j)=>{ const x=len===1?W/2:PAD+(j/(len-1))*(W-PAD*2); return (Math.round(x*10)/10)+','+(Math.round(kitScale(val,d,H-PAD,PAD)*10)/10); }).join(' ');
      const first=pts.split(' ')[0].split(',')[0], parts=pts.split(' '), last=parts[parts.length-1].split(',')[0];
      return (kind==='area'?'<polygon points="'+first+','+base+' '+pts+' '+last+','+base+'" fill="'+P[i%P.length]+'" opacity="0.15"/>':'')+'<polyline points="'+pts+'" fill="none" stroke="'+P[i%P.length]+'" stroke-width="2" stroke-linejoin="round"/>';
    }).join('')+labels.slice(0,n).map((l,i)=>'<text x="'+(n===1?W/2:PAD+(i/(n-1))*(W-PAD*2))+'" y="'+(H-8)+'" font-size="10" text-anchor="middle" fill="currentColor" opacity="0.55">'+l+'</text>').join('');
  }
  if(kind!=='pie'&&kind!=='donut'&&kind!=='funnel'&&kind!=='scatter'){
    const named=kitSeries(v).filter(s=>s.name);
    if(named.length>1) body+=named.map((s,i)=>'<g transform="translate('+(W-PAD-90)+','+(16+i*18)+')"><rect width="10" height="10" rx="2" fill="'+P[i%P.length]+'"/><text x="16" y="9" font-size="11" fill="currentColor" opacity="0.7">'+s.name+'</text></g>').join('');
  }
  return '<svg viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">'+body+'</svg>';
}
`;

/** The chart's fixed view-box dimensions (mirrors the source above). */
export const KIT_CHART_W = 660;
export const KIT_CHART_H = 300;

let draw: ((value: unknown, kind: string, labels: string[]) => string) | null = null;

/**
 * Draw a kit chart to an SVG string for a value/kind/labels — the static-export
 * counterpart of the runtime's live redraw. Returns '' when there's nothing
 * plottable.
 */
export function kitChartSvg(value: unknown, kind: string, labels: string[] = []): string {
  if (!draw) {
    draw = new Function(`${KIT_CHART_JS}\nreturn drawKit;`)() as typeof draw;
  }
  try {
    return draw!(value, kind, labels);
  } catch {
    return '';
  }
}
