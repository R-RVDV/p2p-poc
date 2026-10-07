import { useState, useEffect, useRef, useMemo } from "react";
import * as d3 from "d3";
import QUERIES from "./queries.js";

// ── Emixa brand palette ──────────────────────────────────────────
const C = {
  bg:"#09132B", nav:"#0C1830", surface:"#101C36", surfaceEl:"#162040",
  border:"#1A2B45", borderMid:"#213455",
  teal:"#2DD4C4", tealDim:"rgba(45,212,196,0.12)", tealBd:"rgba(45,212,196,0.3)",
  text:"#E4EDF8", textMid:"#6F89B4", textDim:"#344D6E",
  red:"#F87171", redDim:"rgba(248,113,113,0.14)", redBd:"rgba(248,113,113,0.4)",
  amber:"#FBBF24", amberDim:"rgba(251,191,36,0.12)", amberBd:"rgba(251,191,36,0.3)",
  green:"#34D399", greenDim:"rgba(52,211,153,0.12)", greenBd:"rgba(52,211,153,0.3)",
  purple:"#A78BFA", blue:"#7AA8CC",
};

const NT = {
  PurchaseRequisition:{ fill:"#0C1D3A", stroke:"#4B7096", tc:"#7AA8CC", abbr:"REQ", full:"Purchase Requisition" },
  PurchaseOrder:      { fill:"#081E20", stroke:"#2DD4C4", tc:"#2DD4C4", abbr:"PO",  full:"Purchase Order"       },
  GoodsReceipt:       { fill:"#071A10", stroke:"#34D399", tc:"#34D399", abbr:"GR",  full:"Goods Receipt"        },
  Invoice:            { fill:"#1E1400", stroke:"#FBBF24", tc:"#FBBF24", abbr:"INV", full:"Invoice"              },
  FinancialDocument:  { fill:"#0E0A20", stroke:"#A78BFA", tc:"#A78BFA", abbr:"FD",  full:"Financial Doc"        },
};

const ATTR_LABELS = {
  user:"User", date:"Date", netAmount:"Amount (€)",
  vendorId:"Vendor", quantity:"Quantity",
  transactionCode:"T-code", tcode:"T-code",
  materialNumber:"Material", scheduledDeliveryDate:"Delivery date",
  changedFieldName:"Changed field", oldValue:"Old value", newValue:"New value",
};
const ATTR_SKIP = new Set(["id","label","type"]);

const OCEDD = `P2P OCED Model — Emixa. Objects: PurchaseRequisition(EBAN), PurchaseOrder(EKKO/EKPO), GoodsReceipt(MKPF/MSEG), Invoice(RBKP/RSEG), FinancialDocument(BKPF/BSEG). Events use oced:observes and oced:observed_at. Relations: isConvertedTo, isDeliveredBy, isBilledBy, matches(Three-Way Match), generatesFinancialDoc. Attributes: userName(USNAM), vendorId(LIFNR), netAmount(NETWR/WRBTR), quantity(MENGE), transactionCode(TCODE). OCBC: C1 Unary-Response(Req→PO), C2 Unary-Precedence(GR,PO), C3 Precedence(Invoice,GR), C4 Precedence(Clear,Invoice), C5 Precedence(Clear,GR)=Three-Way Match.`;



const SEV = {
  critical:{ c:C.red,   bg:C.redDim,   bc:C.redBd   },
  high:    { c:C.amber, bg:C.amberDim, bc:C.amberBd },
  medium:  { c:C.teal,  bg:C.tealDim,  bc:C.tealBd  },
};

async function sparqlQuery(q) {
  const r = await fetch("/sparql",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:q})});
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function aiDiagnose(q, res, ocbc, relatedNodes = []) {
  const enriched = res.rows.map(row => {
    const enrichedRow = { ...row };
    Object.values(row).forEach(uri => {
      if (typeof uri !== "string") return;
      const node = relatedNodes.find(n =>
        n.id === uri || n.id.includes(uri) || uri.includes(n.id)
      );
      if (node) enrichedRow[`_context_${node.type}`] = node;
    });
    return enrichedRow;
  });

  const r = await fetch("/diagnose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: q,
      ocbc,
      count: res.count,
      rows: res.rows,
      enriched,
    })
  });

  if (!r.ok) throw new Error(await r.text());
  const d = await r.json();
  return d.diagnosis ?? "";
}
function parseDiag(t) {
  return t
    .replace(/\*\*(.*?)\*\*/g,`<span style="display:block;margin-top:16px;margin-bottom:4px;font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${C.teal}">$1</span>`)
    .replace(/\n\n/g,"</p><p style='margin-top:6px'>").replace(/\n/g,"<br/>");
}
function getNodeId(e) { return typeof e==="object" ? e.id : e; }
function fmtEur(v) {
  if (!v) return "—";
  return new Intl.NumberFormat("nl-NL",{style:"currency",currency:"EUR",minimumFractionDigits:0,maximumFractionDigits:0}).format(v);
}
function pct(part, total) {
  if (!total) return "0%";
  return Math.round((part/total)*100) + "%";
}

// ── Stats sub-components ─────────────────────────────────────────
function KpiCard({label, value, sub, color, warn}) {
  return (
    <div style={{background:C.surface,border:`1px solid ${warn?C.redBd:C.border}`,borderRadius:"10px",padding:"16px 18px",display:"flex",flexDirection:"column",gap:"4px"}}>
      <div style={{fontSize:"10px",color:C.textDim,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.07em"}}>{label}</div>
      <div style={{fontSize:"28px",fontWeight:700,color:color||C.text,lineHeight:1}}>{value ?? "—"}</div>
      {sub && <div style={{fontSize:"10px",color:C.textMid}}>{sub}</div>}
    </div>
  );
}

function HealthCard({label, value, total, invert, color}) {
  const ratio = total ? value/total : 0;
  const pctVal = Math.round(ratio*100);
  const isGood = invert ? ratio < 0.1 : ratio > 0.8;
  const isMid  = invert ? ratio < 0.3 : ratio > 0.5;
  const col = isGood ? C.green : isMid ? C.amber : C.red;
  return (
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"16px 18px"}}>
      <div style={{fontSize:"10px",color:C.textDim,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:"8px"}}>{label}</div>
      <div style={{fontSize:"24px",fontWeight:700,color:color||col,marginBottom:"6px"}}>{pctVal}%</div>
      <div style={{background:C.surfaceEl,borderRadius:"4px",height:"6px",overflow:"hidden",marginBottom:"6px"}}>
        <div style={{width:`${pctVal}%`,height:"100%",background:color||col,borderRadius:"4px",transition:"width 0.6s"}}/>
      </div>
      <div style={{fontSize:"10px",color:C.textMid}}>{value} / {total}</div>
    </div>
  );
}

function HBarChart({title, data, labelKey, valueKey, color}) {
  if (!data?.length) return null;
  const max = Math.max(...data.map(d=>d[valueKey]));
  return (
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"16px 18px"}}>
      <div style={{fontSize:"11px",fontWeight:700,color:C.text,marginBottom:"14px"}}>{title}</div>
      {data.map((d,i) => (
        <div key={i} style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"8px"}}>
          <div style={{fontSize:"10px",color:C.textMid,width:"90px",textAlign:"right",flexShrink:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontFamily:"monospace"}}
               title={d[labelKey]}>
            {d[labelKey]}
          </div>
          <div style={{flex:1,background:C.surfaceEl,borderRadius:"4px",height:"18px",overflow:"hidden"}}>
            <div style={{width:`${(d[valueKey]/max)*100}%`,height:"100%",background:color||C.teal,borderRadius:"4px",minWidth:"4px",transition:"width 0.5s"}}/>
          </div>
          <div style={{fontSize:"10px",color:C.textMid,width:"28px",flexShrink:0,textAlign:"right"}}>{d[valueKey]}</div>
        </div>
      ))}
    </div>
  );
}

function FunnelCard({stats}) {
  const total = stats.count_PurchaseOrder || 1;
  const steps = [
    { label:"Purchase Orders aangemaakt", value:stats.count_PurchaseOrder, color:C.teal },
    { label:"POs met GR of Invoice",      value:stats.connected_pos,       color:C.blue },
    { label:"POs met Goods Receipt",       value:stats.has_gr_pos,          color:C.green },
    { label:"POs met Invoice",             value:stats.has_inv_pos,         color:C.amber },
    { label:"Volledige 3-Way Match",        value:stats.complete_flows,      color:C.purple },
  ];
  return (
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"16px 18px"}}>
      <div style={{fontSize:"11px",fontWeight:700,color:C.text,marginBottom:"14px"}}>P2P Flow Trechter</div>
      {steps.map((s,i) => (
        <div key={i} style={{marginBottom:"10px"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:"3px"}}>
            <span style={{fontSize:"10px",color:C.textMid}}>{s.label}</span>
            <span style={{fontSize:"10px",color:s.color,fontWeight:700,fontFamily:"monospace"}}>{s.value} ({pct(s.value,total)})</span>
          </div>
          <div style={{background:C.surfaceEl,borderRadius:"4px",height:"8px",overflow:"hidden"}}>
            <div style={{width:`${(s.value/total)*100}%`,height:"100%",background:s.color,borderRadius:"4px",transition:"width 0.6s"}}/>
          </div>
        </div>
      ))}
    </div>
  );
}

function ViolationPreview({stats, onRunQuery}) {
  const items = [
    { label:"POs met Invoice maar zonder GR", value:stats.potential_c5, constraint:"C5 — Three-Way Match", queryId:"twm_no_gr" },
    { label:"POs zonder Requisition (maverick buying)", value:stats.maverick_pos, constraint:"Geen formeel goedkeuringsspoor", queryId:"no_req" },
  ];
  return (
    <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"16px 18px"}}>
      <div style={{fontSize:"11px",fontWeight:700,color:C.text,marginBottom:"14px"}}>Potentiële Violations — Snelle Scan</div>
      {items.map((item,i) => (
        <div key={i} style={{display:"flex",alignItems:"center",gap:"12px",padding:"10px 12px",background:item.value>0?C.redDim:C.greenDim,border:`1px solid ${item.value>0?C.redBd:C.greenBd}`,borderRadius:"8px",marginBottom:"8px"}}>
          <div style={{flex:1}}>
            <div style={{fontSize:"11px",color:item.value>0?C.red:C.green,fontWeight:600}}>{item.label}</div>
            <div style={{fontSize:"9px",color:C.textDim,marginTop:"2px"}}>{item.constraint}</div>
          </div>
          <div style={{fontSize:"20px",fontWeight:700,color:item.value>0?C.red:C.green,flexShrink:0}}>{item.value}</div>
          {item.value>0 && (
            <button onClick={()=>onRunQuery(item.queryId)} style={{padding:"4px 10px",borderRadius:"5px",border:`1px solid ${C.redBd}`,background:"transparent",color:C.red,fontSize:"10px",cursor:"pointer",flexShrink:0}}>
              → Query
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Event Timeline component ─────────────────────────────────────
const EV_META = {
  PurchaseRequisition: { label:"Create Requisition",    color:"#7AA8CC" },
  PurchaseOrder:       { label:"Create Purchase Order", color:"#2DD4C4" },
  GoodsReceipt:        { label:"Record Goods Receipt",  color:"#34D399" },
  Invoice:             { label:"Record Invoice",        color:"#FBBF24" },
  FinancialDocument:   { label:"Clear Invoice",         color:"#A78BFA" },
};

function EventTimeline({ displayedData }) {
  if (!displayedData?.nodes) return null;

  const entries = displayedData.nodes
    .filter(n => n.date)
    .map(n => ({
      label: EV_META[n.type]?.label || n.type,
      color: EV_META[n.type]?.color || "#6F89B4",
      date:  n.date,
      user:  n.user,
      tcode: n.tcode,
    }));

  entries.sort((a, b) => a.date.localeCompare(b.date));
  if (!entries.length) return null;

  return (
    <div style={{padding:"8px 14px",borderBottom:`1px solid #1A2B45`}}>
      <div style={{fontSize:"9px",fontWeight:700,color:"#344D6E",textTransform:"uppercase",letterSpacing:"0.09em",marginBottom:"10px"}}>Event Timeline</div>
      {entries.map((e, i) => (
        <div key={i} style={{display:"flex",gap:"8px",marginBottom:"10px",position:"relative"}}>
          {i < entries.length - 1 && (
            <div style={{position:"absolute",left:"5px",top:"13px",width:"1px",height:"calc(100% + 4px)",background:"#1A2B45",zIndex:0}}/>
          )}
          <div style={{width:"11px",height:"11px",borderRadius:"50%",background:e.color,flexShrink:0,marginTop:"2px",zIndex:1}}/>
          <div style={{minWidth:0,flex:1}}>
            <div style={{fontSize:"10px",fontWeight:600,color:e.color,lineHeight:1.2}}>{e.label}</div>
            <div style={{fontSize:"9px",color:"#344D6E",fontFamily:"monospace",marginTop:"1px"}}>{e.date}</div>
            {e.user  && <div style={{fontSize:"9px",color:"#6F89B4",marginTop:"1px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>👤 {e.user}</div>}
            {e.tcode && <div style={{fontSize:"9px",color:"#344D6E",fontFamily:"monospace"}}>T: {e.tcode}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}


// ── Conformance page ─────────────────────────────────────────────
const CLAM_LABELS = {
  isConvertedTo:  "Requisition → PO",
  isDeliveredBy:  "PO → Goods Receipt",
  isBilledBy:     "PO → Invoice",
  invoiceChain:   "Invoice → Financial Doc",
};
const BCM_LABELS = {
  C1_Req_before_PO:        "C1 — Requisition before PO",
  C2_PO_before_GR:         "C2 — PO before Goods Receipt",
  C3_GR_before_Invoice:    "C3 — GR before Invoice",
  C4_Invoice_before_Clear: "C4 — Invoice before Clear",
  C5_GR_before_Clear:      "C5 — GR before Clear (3WM)",
};

function RelationRow({ label, total, violations, ties, onShowInGraph }) {
  const vPct = total ? Math.round((violations / total) * 100) : 0;
  const tPct = total ? Math.round(((ties || 0) / total) * 100) : 0;
  const cPct = 100 - vPct - tPct;
  return (
    <div style={{marginBottom:"10px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"3px"}}>
        <span style={{fontSize:"11px",color:C.text}}>{label}</span>
        <div style={{display:"flex",alignItems:"center",gap:"6px"}}>
          <span style={{fontSize:"10px",color:C.textMid,fontFamily:"monospace"}}>
            {violations > 0 && <span style={{color:C.red}}>{violations} violation{violations!==1?"s":""}</span>}
            {violations > 0 && ties > 0 && <span style={{color:C.textDim}}> · </span>}
            {ties > 0 && <span style={{color:C.amber}}>{ties} tie{ties!==1?"s":""}</span>}
            {violations === 0 && !ties && <span style={{color:C.green}}>✓ all conform</span>}
          </span>
          {violations > 0 && onShowInGraph && (
            <button onClick={onShowInGraph} style={{padding:"1px 7px",borderRadius:"4px",border:`1px solid ${C.redBd}`,background:C.redDim,color:C.red,fontSize:"9px",cursor:"pointer",flexShrink:0}}>
              → Graph
            </button>
          )}
        </div>
      </div>
      <div style={{display:"flex",height:"8px",borderRadius:"4px",overflow:"hidden",background:C.surfaceEl}}>
        {cPct > 0 && <div style={{width:`${cPct}%`,background:C.green,transition:"width 0.6s"}}/>}
        {tPct > 0 && <div style={{width:`${tPct}%`,background:C.amber,transition:"width 0.6s"}}/>}
        {vPct > 0 && <div style={{width:`${vPct}%`,background:C.red,  transition:"width 0.6s"}}/>}
      </div>
    </div>
  );
}

function ConformancePage({ data, setData, loading, setLoading, onJumpToQuery, onShowInGraph, onSetGraphFilter, graphPOFilter }) {
  const [err,  setErr]  = useState("");
  const [view, setView] = useState("all"); // "all" | "subset"

  async function run() {
    setLoading(true); setErr(""); setData(null);
    try {
      const r = await fetch("/conformance");
      if (!r.ok) throw new Error(await r.text());
      setData(await r.json());
    } catch(e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  const d = data?.[view];
  const score = d ? Math.round((d.conform / d.total) * 100) : null;
  const scoreCol = score === null ? C.textDim : score >= 80 ? C.green : score >= 50 ? C.amber : C.red;

  return (
    <div style={{padding:"28px",overflowY:"auto"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:"24px"}}>
        <div>
          <div style={{fontSize:"16px",fontWeight:700,color:C.text,marginBottom:"3px"}}>Model-Wide Conformance</div>
          <div style={{fontSize:"11px",color:C.textMid}}>Full OCBC model check across all Purchase Orders — ClaM (object relations) + BCM (event precedence)</div>
        </div>
        <button onClick={run} disabled={loading} style={{padding:"8px 20px",borderRadius:"7px",border:"none",cursor:loading?"not-allowed":"pointer",background:loading?C.surfaceEl:C.teal,color:loading?"#555":"#09132B",fontSize:"13px",fontWeight:700,minWidth:"120px",flexShrink:0}}>
          {loading ? "Running…" : data ? "↺ Re-run" : "▶ Run Check"}
        </button>
      </div>

      {err && <div style={{padding:"10px 14px",borderRadius:"8px",background:C.redDim,border:`1px solid ${C.redBd}`,color:C.red,fontSize:"12px",marginBottom:"16px"}}>{err}</div>}

      {!data && !loading && (
        <div style={{textAlign:"center",paddingTop:"80px",color:C.textDim}}>
          <div style={{fontSize:"32px",opacity:0.15,marginBottom:"12px"}}>◈</div>
          <div style={{fontSize:"12px"}}>Click "Run Check" to evaluate all OCBC constraints across the full knowledge graph</div>
        </div>
      )}

      {loading && (
        <div style={{textAlign:"center",paddingTop:"80px",color:C.textDim,animation:"pulse 1.4s infinite",fontSize:"12px"}}>
          Running conformance check — this may take a few seconds…
        </div>
      )}

      {data && (
        <>
          {/* View switcher */}
          <div style={{display:"flex",gap:"4px",marginBottom:"20px"}}>
            {[["all","All Purchase Orders"],["subset","Billed POs only"]].map(([id,label])=>(
              <button key={id} onClick={()=>{
                setView(id);
                if (id==="subset" && data?.billed_pos) onSetGraphFilter?.(new Set(data.billed_pos));
                else onSetGraphFilter?.(null);
              }} style={{padding:"5px 14px",borderRadius:"6px",border:`1px solid ${view===id?C.teal:C.border}`,background:view===id?C.tealDim:"transparent",color:view===id?C.teal:C.textMid,fontSize:"11px",cursor:"pointer",fontWeight:view===id?600:400}}>
                {label} {id==="all"?`(n=${data.all.total})`:`(n=${data.subset.total})`}
                {id==="subset"&&graphPOFilter&&<span style={{marginLeft:"5px",fontSize:"9px",color:C.green}}>● in graph</span>}
              </button>
            ))}
          </div>

          {/* KPI row */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:"12px",marginBottom:"24px"}}>
            {[
              { label:"Conformance Score",  value:`${score}%`,       color:scoreCol },
              { label:"Fully Conformant",   value:d.conform,         color:C.green  },
              { label:"Deviating",          value:d.violation,       color:d.violation>0?C.red:C.green },
              { label:"Maverick (no PR)",   value:d.maverick??"-",   color:C.amber  },
            ].map((k,i)=>(
              <div key={i} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"16px 18px"}}>
                <div style={{fontSize:"10px",color:C.textDim,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:"6px"}}>{k.label}</div>
                <div style={{fontSize:"28px",fontWeight:700,color:k.color,lineHeight:1}}>{k.value}</div>
                <div style={{fontSize:"9px",color:C.textDim,marginTop:"4px"}}>of {d.total} POs</div>
              </div>
            ))}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"16px",marginBottom:"16px"}}>
            {/* ClaM layer */}
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"18px"}}>
              <div style={{fontSize:"11px",fontWeight:700,color:C.text,marginBottom:"4px"}}>ClaM Layer — Object Relations</div>
              <div style={{fontSize:"9px",color:C.textDim,marginBottom:"14px"}}>Object-to-object structural conformance</div>
              {Object.entries(CLAM_LABELS).map(([key,label])=>(
                <RelationRow key={key} label={label} total={d.total}
                  violations={d.per_relation?.[key]??0}
                  ties={0}
                  onShowInGraph={d.per_relation_pos?.[key]?.length>0 ? ()=>onShowInGraph(d.per_relation_pos[key]) : null}
                />
              ))}
            </div>

            {/* BCM layer */}
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"18px"}}>
              <div style={{fontSize:"11px",fontWeight:700,color:C.text,marginBottom:"4px"}}>BCM Layer — Event Precedence</div>
              <div style={{fontSize:"9px",color:C.textDim,marginBottom:"14px"}}>Event ordering constraints — TIE = same-day, order undecidable</div>
              {Object.entries(BCM_LABELS).map(([key,label])=>(
                <RelationRow key={key} label={label} total={d.total}
                  violations={d.per_relation?.[key]??0}
                  ties={d.per_relation_ties?.[key]??0}
                  onShowInGraph={d.per_relation_pos?.[key]?.length>0 ? ()=>onShowInGraph(d.per_relation_pos[key]) : null}
                />
              ))}
            </div>
          </div>

          {/* Three-Way Match + Orphan reqs */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"16px"}}>
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"18px"}}>
              <div style={{fontSize:"11px",fontWeight:700,color:C.text,marginBottom:"4px"}}>Three-Way Match View</div>
              <div style={{fontSize:"9px",color:C.textDim,marginBottom:"14px"}}>Invoices matched to a GR via shared PO (reported separately — same condition as isDeliveredBy)</div>
              <div style={{fontSize:"24px",fontWeight:700,color:data.three_way_match.violations>0?C.red:C.green,marginBottom:"4px"}}>
                {data.three_way_match.pct}%
              </div>
              <div style={{fontSize:"10px",color:C.textMid,marginBottom:"10px"}}>
                {data.three_way_match.conform}/{data.three_way_match.total_invoices} invoices matched to a GR
              </div>
              <RelationRow label="Invoice → GR match" total={data.three_way_match.total_invoices}
                violations={data.three_way_match.violations} ties={0} />
            </div>

            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:"10px",padding:"18px"}}>
              <div style={{fontSize:"11px",fontWeight:700,color:C.text,marginBottom:"4px"}}>Requisition Coverage</div>
              <div style={{fontSize:"9px",color:C.textDim,marginBottom:"14px"}}>Requisitions that never converted to a Purchase Order</div>
              <div style={{fontSize:"24px",fontWeight:700,color:C.amber,marginBottom:"4px"}}>{data.orphan_reqs}</div>
              <div style={{fontSize:"10px",color:C.textMid}}>orphan requisitions (no downstream PO)</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────
export default function App() {
  const svgRef    = useRef(null);
  const wrapRef   = useRef(null);
  const graphRef  = useRef([]);
  const d3Ver     = useRef(0);

  // Page state
  const [page,        setPage]        = useState("graph"); // "graph" | "stats"

  // Graph state
  const [graphData,   setGraphData]   = useState(null);
  const [graphLimit,  setGraphLimit]  = useState(40);
  const [graphPOFilter,setGraphPOFilter] = useState(null); // null = no filter, Set<string> = billed POs
  const [isDemo,      setIsDemo]      = useState(false);
  const [viewMode,    setViewMode]    = useState("full");
  const [focusPO,     setFocusPO]     = useState(null);
  const [typeFilters, setTypeFilters] = useState(new Set(Object.keys(NT)));
  const [poSearch,    setPoSearch]    = useState("");
  const [selNode,     setSelNode]     = useState(null);
  const [d3VerState,  setD3VerState]  = useState(0);

  // Stats state
  const [stats,       setStats]       = useState(null);
  const [statsLoading,setStatsLoading]= useState(false);

  // Conformance state — lifted to persist across tab switches
  const [conformanceData,    setConformanceData]    = useState(null);
  const [conformanceLoading, setConformanceLoading] = useState(false);

  // Query state
  const [viols,   setViols]   = useState(new Set());
  const [selQ,    setSelQ]    = useState(QUERIES[0]);
  const [qtext,   setQtext]   = useState(QUERIES[0].query);
  const [results, setResults] = useState(null);
  const [diag,    setDiag]    = useState("");
  const [running, setRunning] = useState(false);
  const [diaRun,  setDiaRun]  = useState(false);
  const [tab,     setTab]     = useState("results");
  const [err,     setErr]     = useState("");
  const [showRel, setShowRel] = useState(true);

  // ── Fetch graph ──────────────────────────────────────────────
  useEffect(() => {
    fetch(`/graph?limit=${graphLimit}`)
      .then(r=>r.json())
      .then(data=>{
        if (data.nodes?.length>0){ setGraphData(data); setIsDemo(false); }
        else setIsDemo(true);
      })
      .catch(()=>setIsDemo(true));
  }, [graphLimit]);

  // When billed PO filter is set, ensure all POs are loaded
  useEffect(()=>{
    if (graphPOFilter && graphLimit < 200) setGraphLimit(200);
  }, [graphPOFilter]);

  useEffect(() => { if (graphData) graphRef.current = graphData.nodes; }, [graphData]);

  // ── Fetch stats (lazy, on first visit) ──────────────────────
  useEffect(() => {
    if (page!=="stats" || stats || statsLoading) return;
    setStatsLoading(true);
    fetch("/stats")
      .then(r=>r.json())
      .then(data=>{ setStats(data); setStatsLoading(false); })
      .catch(()=>setStatsLoading(false));
  }, [page]);

  // ── Derived ──────────────────────────────────────────────────
  const allPOs = useMemo(()=>{
    if (!graphData) return [];
    return graphData.nodes.filter(n=>n.type==="PurchaseOrder").sort((a,b)=>a.label.localeCompare(b.label));
  }, [graphData]);

  const filteredPOs = useMemo(()=>{
    if (!poSearch) return allPOs;
    const q=poSearch.toLowerCase();
    return allPOs.filter(po=>po.label.toLowerCase().includes(q));
  }, [allPOs, poSearch]);

  const displayedData = useMemo(()=>{
    if (!graphData) return null;
    let nodes = graphData.nodes;
    if (viewMode==="detail"&&focusPO) {
      const inView=new Set([focusPO.id]);
      for (let h=0;h<2;h++) {
        graphData.links.forEach(lnk=>{
          const s=getNodeId(lnk.source),t=getNodeId(lnk.target);
          if (inView.has(s)) inView.add(t);
          if (inView.has(t)) inView.add(s);
        });
      }
      nodes=nodes.filter(n=>inView.has(n.id));
    } else if (graphPOFilter) {
      // Billed POs filter: show only filtered POs + their 2-hop neighbours
      const allowedIds = new Set(graphPOFilter);
      for (let h=0;h<2;h++) {
        graphData.links.forEach(lnk=>{
          const s=getNodeId(lnk.source),t=getNodeId(lnk.target);
          if (allowedIds.has(s)) allowedIds.add(t);
          if (allowedIds.has(t)) allowedIds.add(s);
        });
      }
      nodes=nodes.filter(n=>allowedIds.has(n.id));
    }
    nodes=nodes.filter(n=>typeFilters.has(n.type));
    const nodeIds=new Set(nodes.map(n=>n.id));
    let links=graphData.links
      .filter(lnk=>{ const s=getNodeId(lnk.source),t=getNodeId(lnk.target); return nodeIds.has(s)&&nodeIds.has(t); })
      .map(lnk=>({...lnk,source:getNodeId(lnk.source),target:getNodeId(lnk.target)}));
    if (viewMode==="detail"&&focusPO) {
      const evNodes=[], evLinks=[];
      nodes.forEach(n=>{
        if (n.date) {
          const evId=n.id+"__ev";
          evNodes.push({id:evId,label:n.date,type:"__event",evColor:EV_META[n.type]?.color||"#6F89B4",evLabel:EV_META[n.type]?.label||n.type,user:n.user,tcode:n.tcode});
          evLinks.push({source:evId,target:n.id,rel:"observes"});
         }
      });
      nodes=[...nodes,...evNodes];
      links=[...links,...evLinks];
    }
    return {nodes,links};
  }, [graphData,viewMode,focusPO,typeFilters,graphPOFilter]);

  const detailSummary = useMemo(()=>{
    if (!focusPO||!graphData) return null;
    const grouped={PurchaseRequisition:[],GoodsReceipt:[],Invoice:[],FinancialDocument:[]};
    const focusId=focusPO.id;
    graphData.links.forEach(lnk=>{
      const s=getNodeId(lnk.source),t=getNodeId(lnk.target);
      const otherId=s===focusId?t:t===focusId?s:null;
      if (!otherId) return;
      const other=graphData.nodes.find(n=>n.id===otherId);
      if (other&&grouped[other.type]) grouped[other.type].push(other);
    });
    return grouped;
  }, [focusPO,graphData]);

  // ── D3 init ──────────────────────────────────────────────────
  useEffect(()=>{
    if (page !== "graph") return;   // ← deze regel toevoegen
    if (!displayedData || !svgRef.current || !wrapRef.current) return;
    if (!displayedData||!svgRef.current||!wrapRef.current) return;
    const wrap=wrapRef.current, el=svgRef.current;
    const W=wrap.clientWidth||800, H=420;
    el.setAttribute("width",W); el.setAttribute("height",H);
    const svg=d3.select(el);
    svg.selectAll("*").remove();
    const defs=svg.append("defs");
    const f=defs.append("filter").attr("id","vglow").attr("x","-60%").attr("y","-60%").attr("width","220%").attr("height","220%");
    f.append("feGaussianBlur").attr("in","SourceGraphic").attr("stdDeviation","6").attr("result","b");
    const fm=f.append("feMerge");
    fm.append("feMergeNode").attr("in","b"); fm.append("feMergeNode").attr("in","SourceGraphic");
    [["anorm","#1E3050"],["aviol",C.red],["aamb",C.amber]].forEach(([id,fill])=>{
      defs.append("marker").attr("id",id).attr("viewBox","0 -4 10 8").attr("refX",24).attr("refY",0)
        .attr("markerWidth",5).attr("markerHeight",5).attr("orient","auto")
        .append("path").attr("d","M0,-4L10,0L0,4").attr("fill",fill);
    });
    const g=svg.append("g").attr("class","zg");
    const zoomBeh=d3.zoom().scaleExtent([0.05,8]).on("zoom",e=>g.attr("transform",e.transform));
    svg.call(zoomBeh);
    svg.on("click.desel",()=>setSelNode(null));
    const nodes=displayedData.nodes.map(d=>({...d}));
    const links=displayedData.links.map(d=>({...d}));
    if (viewMode==="detail"&&focusPO) { const fn=nodes.find(n=>n.id===focusPO.id); if(fn){fn.fx=W/2;fn.fy=H/2;} }
    const charge=nodes.length>80?-200:nodes.length>40?-300:-420;
    const sim=d3.forceSimulation(nodes)
      .force("link",d3.forceLink(links).id(d=>d.id).distance(90).strength(0.8))
      .force("charge",d3.forceManyBody().strength(charge))
      .force("center",d3.forceCenter(W/2,H/2))
      .force("x",d3.forceX(W/2).strength(0.03))
      .force("y",d3.forceY(H/2).strength(0.03))
      .force("collide",d3.forceCollide(d=>d.type==="__event"?22:32));
    const linkSel=g.append("g").selectAll("line").data(links).join("line")
      .attr("class","lnk").attr("stroke","#1E3050").attr("stroke-width",1.5).attr("marker-end","url(#anorm)");
    const llSel=g.append("g").selectAll("text").data(links).join("text")
      .attr("class","llab").attr("font-size","7px").attr("fill",C.textDim)
      .attr("text-anchor","middle").attr("pointer-events","none").text(d=>d.rel);
    const nodeSel=g.append("g").selectAll("g").data(nodes).join("g")
      .attr("class","nd").attr("data-nid",d=>d.id).style("cursor","pointer")
      .on("click",(e,d)=>{ e.stopPropagation(); setSelNode(p=>p?.id===d.id?null:{...d}); })
      .call(d3.drag()
        .on("start",(e,d)=>{sim.alphaTarget(0.3).restart();d.fx=d.x;d.fy=d.y;})
        .on("drag", (e,d)=>{d.fx=e.x;d.fy=e.y;})
        .on("end",  (e,d)=>{sim.alphaTarget(0);d.fx=null;d.fy=null;})
      );
    nodeSel.append("circle").attr("class","nc")
      .attr("r",d=>d.type==="__event"?11:18)
      .attr("fill",d=>d.type==="__event"?"rgba(0,0,0,0.25)":NT[d.type]?.fill||C.surface)
      .attr("stroke",d=>d.type==="__event"?d.evColor:NT[d.type]?.stroke||C.border)
      .attr("stroke-width",d=>d.type==="__event"?1.5:2)
      .attr("stroke-dasharray",d=>d.type==="__event"?"4,2":null);
    nodeSel.append("text").attr("text-anchor","middle").attr("dy","4px").attr("font-size","8px").attr("font-weight","700")
      .attr("fill",d=>d.type==="__event"?d.evColor:NT[d.type]?.tc||C.textMid)
      .attr("pointer-events","none").text(d=>d.type==="__event"?"EV":NT[d.type]?.abbr||"?");
    nodeSel.append("text").attr("class","nlab").attr("text-anchor","middle").attr("dy","26px")
      .attr("font-size","7px").attr("pointer-events","none")
      .attr("fill",d=>d.type==="__event"?d.evColor:C.textMid)
      .text(d=>d.type==="__event"?d.evLabel:d.label);
    nodeSel.filter(d=>d.type==="__event").append("text").attr("text-anchor","middle").attr("dy","36px")
      .attr("font-size","6px").attr("fill","#344D6E").attr("pointer-events","none").text(d=>d.date||"");
    sim.on("tick",()=>{
      linkSel.attr("x1",d=>d.source.x).attr("y1",d=>d.source.y).attr("x2",d=>d.target.x).attr("y2",d=>d.target.y);
      llSel.attr("x",d=>(d.source.x+d.target.x)/2).attr("y",d=>(d.source.y+d.target.y)/2-6);
      nodeSel.attr("transform",d=>`translate(${d.x},${d.y})`);
    });
    svg.on("dblclick.zoom",null);
    el._resetZoom=()=>svg.transition().duration(400).call(zoomBeh.transform,d3.zoomIdentity.translate(W/2,H/2).scale(1).translate(-W/2,-H/2));
    el._fitZoom=()=>{
      const bb=g.node()?.getBBox?.();
      if(!bb||!bb.width) return;
      const scale=Math.min(0.9*W/bb.width,0.9*H/bb.height,3);
      svg.transition().duration(500).call(zoomBeh.transform,d3.zoomIdentity.translate(W/2-scale*(bb.x+bb.width/2),H/2-scale*(bb.y+bb.height/2)).scale(scale));
    };
    let ticked=0;
    sim.on("tick.count",()=>{ticked++;if(ticked===1){d3Ver.current++;setD3VerState(v=>v+1);}});
    return ()=>sim.stop();
  }, [displayedData, viewMode, focusPO, page]);

  useEffect(()=>{ if(!svgRef.current) return; d3.select(svgRef.current).selectAll(".llab").attr("display",showRel?null:"none"); },[showRel]);

  useEffect(()=>{
    const el=svgRef.current; if(!el) return;
    const svg=d3.select(el);
    svg.selectAll(".nd").each(function(d){
      const nc=d3.select(this).select(".nc");
      if (d?.type==="__event") { nc.attr("stroke",d.evColor||C.border).attr("stroke-width",1.5).attr("filter",null); }
      else { nc.attr("stroke",NT[d?.type]?.stroke||C.border).attr("stroke-width",2).attr("filter",null); }
    });
    svg.selectAll(".lnk").attr("stroke","#1E3050").attr("stroke-width",1.5).attr("marker-end","url(#anorm)");
    if (!viols.size) return;
    svg.selectAll(".nd").each(function(d){ if(viols.has(d?.id)) d3.select(this).select(".nc").attr("stroke",C.red).attr("stroke-width",3).attr("filter","url(#vglow)"); });
    svg.selectAll(".lnk").each(function(d){ const s=getNodeId(d.source),t=getNodeId(d.target); if(viols.has(s)&&viols.has(t)) d3.select(this).attr("stroke",C.red).attr("stroke-width",2).attr("marker-end","url(#aviol)"); else if(viols.has(s)||viols.has(t)) d3.select(this).attr("stroke",C.amber).attr("stroke-width",1.8); });
  }, [viols,d3VerState]);

  // ── Handlers ─────────────────────────────────────────────────
  function toggleType(type){ setTypeFilters(prev=>{const next=new Set(prev);next.has(type)?next.delete(type):next.add(type);return next;}); }
  function focusOnPO(po){ setFocusPO(po);setViewMode("detail");setSelNode(null); }
  function backToFull(){ setFocusPO(null);setViewMode("full");setSelNode(null); }
  function pickQuery(id){ const q=QUERIES.find(x=>x.id===id)||QUERIES[0]; setSelQ(q);setQtext(q.query);setResults(null);setDiag("");setErr("");setTab("results"); if(page==="stats") setPage("graph"); }
  function extractViolNodes(rows,cols){ const s=new Set(); const cur=graphRef.current||[]; rows.forEach(row=>cols.forEach(col=>{ const v=String(row[col]||""); cur.forEach(n=>{if(v===n.id||v.includes(n.id)||n.id.includes(v))s.add(n.id);}); })); return s; }
  async function run(){ setRunning(true);setResults(null);setErr("");setDiag("");setViols(new Set()); try{const data=await sparqlQuery(qtext);setResults(data);setViols(extractViolNodes(data.rows||[],data.columns||[]));setTab("results");}catch(e){setErr("Query failed: "+e.message);}finally{setRunning(false);} }
  async function diagnose(){ if(!results) return; setDiaRun(true);setDiag("");setTab("explanation"); try{setDiag(await aiDiagnose(qtext,results,selQ.ocbc,graphRef.current));}catch(e){setDiag("Error: "+e.message);}finally{setDiaRun(false);} }

  const dispNodes=displayedData?.nodes?.length??0;
  const dispLinks=displayedData?.links?.length??0;
  const violCount=viols.size;
  const totalNodes=graphData?.nodes?.length??0;
  const cats=[...new Set(QUERIES.map(q=>q.cat))];

  // ── Render ────────────────────────────────────────────────────
  return (
    <div style={{background:C.bg,color:C.text,fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",fontSize:"13px",minHeight:"100vh"}}>

      {/* Header */}
      <div style={{background:C.nav,borderBottom:`1px solid ${C.border}`,padding:"10px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:"12px"}}>
        <div style={{display:"flex",alignItems:"center",gap:"10px"}}>
          {/* Nav tabs */}
          <div style={{display:"flex",gap:"2px"}}>
            {[["graph","Knowledge Graph"],["conformance","Conformance"]].map(([id,label])=>(
              <button key={id} onClick={()=>setPage(id)} style={{padding:"4px 12px",borderRadius:"5px",border:"none",cursor:"pointer",background:page===id?C.tealDim:"transparent",color:page===id?C.teal:C.textMid,fontSize:"12px",fontWeight:page===id?600:400,transition:"all 0.15s"}}>
                {label}
              </button>
            ))}
          </div>
          {/* Breadcrumb in graph mode */}
          {page==="graph"&&viewMode==="detail"&&(
            <>
              <span style={{color:C.borderMid}}>·</span>
              <button onClick={backToFull} style={{padding:"3px 10px",borderRadius:"5px",border:`1px solid ${C.borderMid}`,background:C.surfaceEl,color:C.textMid,fontSize:"11px",cursor:"pointer"}}>← Overview</button>
              <span style={{fontSize:"12px",color:C.teal,fontWeight:600}}>{focusPO?.label}</span>
            </>
          )}
        </div>
        <div style={{display:"flex",gap:"12px",alignItems:"center"}}>
          {page==="graph"&&(!graphData
            ? <span style={{fontSize:"11px",color:C.textDim,animation:"pulse 1.4s infinite"}}>Loading…</span>
            : <span style={{fontSize:"11px",color:C.textMid}}>{dispNodes}/{totalNodes} nodes · {dispLinks} relations{isDemo&&<span style={{color:C.amber,marginLeft:"6px"}}>(demo)</span>}</span>
          )}
          {violCount>0&&<span style={{fontSize:"11px",fontWeight:700,padding:"2px 9px",borderRadius:"10px",background:C.redDim,color:C.red,border:`1px solid ${C.redBd}`}}>⚠ {violCount} violations</span>}
        </div>
      </div>


      {/* ══ CONFORMANCE PAGE ════════════════════════════════════ */}
      {page==="conformance"&&(
        <ConformancePage
          data={conformanceData}       setData={setConformanceData}
          loading={conformanceLoading} setLoading={setConformanceLoading}
          onJumpToQuery={(id)=>{ pickQuery(id); setPage("graph"); }}
          onShowInGraph={(poUris)=>{ setViols(new Set(poUris)); setPage("graph"); }}
          onSetGraphFilter={(f)=>setGraphPOFilter(f)}
          graphPOFilter={graphPOFilter}
        />
      )}

      {/* ══ KENNISGRAAF PAGE ═══════════════════════════════════ */}
      {page==="graph"&&(
        <>
          {/* Filter bar */}
          <div style={{background:C.nav,borderBottom:`1px solid ${C.border}`,padding:"7px 18px",display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
            <span style={{fontSize:"9px",color:C.textDim,fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase",marginRight:"4px"}}>Filter</span>
            {Object.entries(NT).map(([type,v])=>{
              const active=typeFilters.has(type);
              return(
                <button key={type} onClick={()=>toggleType(type)} style={{padding:"3px 9px",borderRadius:"20px",cursor:"pointer",border:`1px solid ${active?v.stroke:C.borderMid}`,background:active?`${v.fill}cc`:C.surface,color:active?v.tc:C.textDim,fontSize:"10px",fontWeight:active?600:400,transition:"all 0.15s"}}>
                  {v.abbr}
                </button>
              );
            })}
            <div style={{flex:1}}/>
            {violCount>0&&viewMode==="full"&&<span style={{fontSize:"10px",color:C.amber}}>Violations marked in graph</span>}
            {conformanceData?.per_po_status && viewMode==="full" && (() => {
              const allViolPos = Object.entries(conformanceData.per_po_status)
                .filter(([,s])=>Object.values(s).some(v=>v==="VIOLATION"))
                .map(([uri])=>uri);
              const isActive = allViolPos.length>0 && allViolPos.every(uri=>viols.has(uri));
              return (
                <button onClick={()=>isActive?setViols(new Set()):setViols(new Set(allViolPos))}
                  style={{padding:"3px 9px",borderRadius:"20px",cursor:"pointer",border:`1px solid ${isActive?C.redBd:C.borderMid}`,background:isActive?C.redDim:C.surface,color:isActive?C.red:C.textDim,fontSize:"10px",fontWeight:isActive?600:400}}>
                  {isActive?"✕ Clear violations":"⚠ Show all violations"}
                </button>
              );
            })()}
            {graphPOFilter&&viewMode==="full"&&(
              <span style={{display:"flex",alignItems:"center",gap:"5px",padding:"2px 9px",borderRadius:"20px",background:C.tealDim,border:`1px solid ${C.tealBd}`,fontSize:"10px",color:C.teal,fontWeight:600}}>
                🔍 {graphPOFilter.size} billed POs
                <button onClick={()=>setGraphPOFilter(null)} style={{background:"none",border:"none",cursor:"pointer",color:C.teal,fontSize:"12px",lineHeight:1,padding:"0 1px"}}>✕</button>
              </span>
            )}
            {!graphPOFilter&&viewMode==="full"&&<button onClick={()=>setGraphLimit(l=>l+20)} style={{padding:"3px 10px",borderRadius:"5px",border:`1px solid ${C.borderMid}`,background:C.surfaceEl,color:C.textMid,fontSize:"10px",cursor:"pointer"}}>+ Load more POs</button>}
          </div>

          {/* Graph */}
          <div ref={wrapRef} style={{position:"relative",background:"#060E1D",borderBottom:`1px solid ${C.border}`,minHeight:"420px"}}>
            {!graphData
              ? <div style={{height:"420px",display:"flex",alignItems:"center",justifyContent:"center",color:C.textDim,fontSize:"12px"}}><span style={{animation:"pulse 1.4s infinite"}}>Loading knowledge graph…</span></div>
              : <svg ref={svgRef} style={{display:"block",width:"100%"}}/>
            }
            {/* Legend */}
            <div style={{position:"absolute",top:"10px",right:"12px",background:"rgba(9,19,43,0.9)",border:`1px solid ${C.border}`,borderRadius:"8px",padding:"8px 12px",backdropFilter:"blur(4px)"}}>
              <div style={{fontSize:"9px",fontWeight:700,color:C.textDim,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:"6px"}}>Types</div>
              {Object.entries(NT).map(([k,v])=>(
                <div key={k} style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:"3px",opacity:typeFilters.has(k)?1:0.3}}>
                  <div style={{width:"9px",height:"9px",borderRadius:"50%",background:v.fill,border:`1.5px solid ${v.stroke}`,flexShrink:0}}/>
                  <span style={{fontSize:"9px",color:C.textMid}}>{v.full}</span>
                </div>
              ))}
              {violCount>0&&<div style={{marginTop:"6px",paddingTop:"6px",borderTop:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:"6px"}}>
                <div style={{width:"9px",height:"9px",borderRadius:"50%",background:C.redDim,border:`1.5px solid ${C.red}`,flexShrink:0}}/>
                <span style={{fontSize:"9px",color:C.red}}>Violation</span>
              </div>}
            </div>
            {/* Controls */}
            <div style={{position:"absolute",bottom:"10px",right:"12px",display:"flex",gap:"6px"}}>
              <button onClick={()=>setShowRel(p=>!p)} style={{padding:"4px 8px",borderRadius:"5px",border:`1px solid ${C.borderMid}`,background:C.surfaceEl,color:C.textMid,fontSize:"9px",cursor:"pointer"}}>{showRel?"Hide labels":"Show labels"}</button>
              <button onClick={()=>svgRef.current?._fitZoom?.()} style={{padding:"4px 8px",borderRadius:"5px",border:`1px solid ${C.borderMid}`,background:C.surfaceEl,color:C.textMid,fontSize:"9px",cursor:"pointer"}}>⊞ Fit</button>
              <button onClick={()=>svgRef.current?._resetZoom?.()} style={{padding:"4px 8px",borderRadius:"5px",border:`1px solid ${C.borderMid}`,background:C.surfaceEl,color:C.textMid,fontSize:"9px",cursor:"pointer"}}>↺ Reset</button>
              {violCount>0&&<button onClick={()=>setViols(new Set())} style={{padding:"4px 8px",borderRadius:"5px",border:`1px solid ${C.redBd}`,background:C.redDim,color:C.red,fontSize:"9px",cursor:"pointer"}}>✕ Delete</button>}
            </div>
            {/* Node detail card */}
            {selNode&&(
              <div style={{position:"absolute",top:"10px",left:"12px",minWidth:"200px",maxWidth:"250px",background:"rgba(9,19,43,0.95)",border:`1px solid ${NT[selNode.type]?.stroke||C.border}`,borderRadius:"10px",padding:"12px 14px",backdropFilter:"blur(6px)",zIndex:10,maxHeight:"380px",overflowY:"auto"}}>
                <div style={{display:"flex",alignItems:"center",gap:"8px",marginBottom:"10px"}}>
                  <div style={{width:"28px",height:"28px",borderRadius:"50%",background:NT[selNode.type]?.fill,border:`2px solid ${NT[selNode.type]?.stroke}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    <span style={{fontSize:"8px",fontWeight:800,color:NT[selNode.type]?.tc}}>{NT[selNode.type]?.abbr}</span>
                  </div>
                  <div style={{minWidth:0}}>
                    <div style={{fontSize:"11px",fontWeight:700,color:NT[selNode.type]?.tc,wordBreak:"break-all"}}>{selNode.label}</div>
                    <div style={{fontSize:"9px",color:C.textMid}}>{NT[selNode.type]?.full}</div>
                  </div>
                </div>
                {Object.entries(selNode).filter(([k])=>!ATTR_SKIP.has(k)).map(([k,v])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",gap:"8px",marginBottom:"3px"}}>
                    <span style={{fontSize:"10px",color:C.textDim,flexShrink:0}}>{ATTR_LABELS[k]||k}</span>
                    <span style={{fontSize:"10px",color:C.text,fontFamily:"monospace",textAlign:"right",wordBreak:"break-all"}}>{String(v)}</span>
                  </div>
                ))}
                {viols.has(selNode.id)&&<div style={{marginTop:"8px",padding:"5px 8px",borderRadius:"5px",background:C.redDim,border:`1px solid ${C.redBd}`,fontSize:"9px",color:C.red}}>⚠ Marked as violation</div>}
                {selNode.type==="PurchaseOrder"&&viewMode==="full"&&(
                  <button onClick={()=>focusOnPO(selNode)} style={{marginTop:"8px",width:"100%",padding:"5px",borderRadius:"5px",border:`1px solid ${C.tealBd}`,background:C.tealDim,color:C.teal,fontSize:"10px",cursor:"pointer",fontWeight:600}}>🔍 View PO-flow</button>
                )}
              </div>
            )}
          </div>

          {/* Bottom panel */}
          <div style={{display:"flex",minHeight:"380px"}}>
            {/* Sidebar */}
            <div style={{width:"220px",flexShrink:0,borderRight:`1px solid ${C.border}`,background:C.nav,display:"flex",flexDirection:"column"}}>
              {viewMode==="full"?(
                <>
                  <div style={{padding:"10px 14px 6px",borderBottom:`1px solid ${C.border}`}}>
                    <div style={{fontSize:"9px",fontWeight:700,color:C.textDim,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:"6px"}}>PO Navigator</div>
                    <input value={poSearch} onChange={e=>setPoSearch(e.target.value)} placeholder="Search PO..."
                      style={{width:"100%",padding:"5px 8px",borderRadius:"5px",border:`1px solid ${C.borderMid}`,background:C.surfaceEl,color:C.text,fontSize:"11px",outline:"none",boxSizing:"border-box"}}
                    />
                  </div>
                  <div style={{maxHeight:"140px",overflowY:"auto",borderBottom:`1px solid ${C.border}`}}>
                    {filteredPOs.length===0
                      ? <div style={{padding:"10px 14px",fontSize:"11px",color:C.textDim}}>No POs loaded</div>
                      : filteredPOs.map(po=>(
                        <div key={po.id} onClick={()=>focusOnPO(po)} style={{padding:"5px 14px",cursor:"pointer",fontSize:"11px",color:viols.has(po.id)?C.red:C.textMid,borderLeft:viols.has(po.id)?`2px solid ${C.red}`:"2px solid transparent"}}>
                          {po.label}{viols.has(po.id)&&<span style={{marginLeft:"4px",fontSize:"9px"}}>⚠</span>}
                        </div>
                      ))
                    }
                  </div>
                  <div style={{padding:"8px 14px 4px",fontSize:"9px",fontWeight:700,color:C.textDim,textTransform:"uppercase",letterSpacing:"0.1em"}}>SPARQL Queries</div>
                  <div style={{overflowY:"auto",flex:1}}>
                    {cats.map(cat=>(
                      <div key={cat}>
                        <div style={{padding:"8px 14px 3px",fontSize:"9px",fontWeight:700,color:C.textDim,textTransform:"uppercase",letterSpacing:"0.09em"}}>{cat}</div>
                        {QUERIES.filter(q=>q.cat===cat).map(q=>{const sv=SEV[q.sev];const active=selQ.id===q.id;return(
                          <div key={q.id} onClick={()=>pickQuery(q.id)} style={{padding:"6px 14px 8px",borderLeft:active?`2px solid ${C.teal}`:"2px solid transparent",background:active?C.surfaceEl:"transparent",cursor:"pointer"}}>
                            <span style={{fontSize:"8px",fontWeight:700,padding:"1px 5px",borderRadius:"3px",background:sv.bg,color:sv.c,border:`1px solid ${sv.bc}`,textTransform:"uppercase"}}>{q.sev}</span>
                            <div style={{fontSize:"11px",lineHeight:1.3,color:active?C.text:C.textMid,marginTop:"3px"}}>{q.label}</div>
                          </div>
                        );})}
                      </div>
                    ))}
                  </div>
                </>
              ):(
                <>
                  <div style={{padding:"10px 14px",borderBottom:`1px solid ${C.border}`}}>
                    <button onClick={backToFull} style={{width:"100%",padding:"6px",borderRadius:"5px",border:`1px solid ${C.borderMid}`,background:C.surfaceEl,color:C.textMid,fontSize:"11px",cursor:"pointer",marginBottom:"8px"}}>← Back to overview</button>
                    <div style={{fontSize:"10px",fontWeight:700,color:C.teal,marginBottom:"6px"}}>{focusPO?.label}</div>
                    {focusPO&&Object.entries(focusPO).filter(([k])=>!ATTR_SKIP.has(k)).map(([k,v])=>(
                      <div key={k} style={{display:"flex",justifyContent:"space-between",marginBottom:"2px"}}>
                        <span style={{fontSize:"9px",color:C.textDim}}>{ATTR_LABELS[k]||k}</span>
                        <span style={{fontSize:"9px",color:C.text,fontFamily:"monospace"}}>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                  {/* PO-level OCBC conformance — shown when model-wide check has run */}
                  {conformanceData?.per_po_status && focusPO && (() => {
                    const poStatus = conformanceData.per_po_status[focusPO.id];
                    if (!poStatus) return null;
                    const violations = Object.entries(poStatus).filter(([,v])=>v==="VIOLATION");
                    const ties       = Object.entries(poStatus).filter(([,v])=>v==="TIE");
                    const isConform  = violations.length === 0;
                    return (
                      <div style={{padding:"8px 14px",borderBottom:`1px solid ${C.border}`}}>
                        <div style={{fontSize:"9px",fontWeight:700,color:C.textDim,textTransform:"uppercase",letterSpacing:"0.09em",marginBottom:"6px"}}>OCBC Conformance</div>
                        <div style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:violations.length>0||ties.length>0?"5px":0}}>
                          <div style={{width:"8px",height:"8px",borderRadius:"50%",background:isConform?C.green:C.red,flexShrink:0}}/>
                          <span style={{fontSize:"10px",fontWeight:600,color:isConform?C.green:C.red}}>
                            {isConform?"Fully Conformant":`${violations.length} violation${violations.length!==1?"s":""}${ties.length>0?` · ${ties.length} tie${ties.length!==1?"s":""}`:""}`}
                          </span>
                        </div>
                        {violations.map(([rel])=>(<div key={rel} style={{fontSize:"9px",color:C.red,paddingLeft:"14px",marginBottom:"2px"}}>⚠ {CLAM_LABELS[rel]||BCM_LABELS[rel]||rel}</div>))}
                        {ties.map(([rel])=>(<div key={rel} style={{fontSize:"9px",color:C.amber,paddingLeft:"14px",marginBottom:"2px"}}>≈ {CLAM_LABELS[rel]||BCM_LABELS[rel]||rel}</div>))}
                      </div>
                    );
                  })()}
                  {detailSummary&&(
                    <div style={{padding:"8px 14px",borderBottom:`1px solid ${C.border}`}}>
                      <div style={{fontSize:"9px",fontWeight:700,color:C.textDim,textTransform:"uppercase",letterSpacing:"0.09em",marginBottom:"6px"}}>Linked objects</div>
                      {Object.entries(detailSummary).map(([type,items])=>items.length>0?(
                        <div key={type} style={{marginBottom:"5px"}}>
                          <div style={{fontSize:"9px",color:NT[type]?.tc,fontWeight:600,marginBottom:"2px"}}>{NT[type]?.full} ({items.length})</div>
                          {items.slice(0,3).map(item=>(
                            <div key={item.id} onClick={()=>setSelNode(item)} style={{fontSize:"9px",color:viols.has(item.id)?C.red:C.textMid,paddingLeft:"8px",cursor:"pointer"}}>
                              {item.label}{viols.has(item.id)&&" ⚠"}
                            </div>
                          ))}
                          {items.length>3&&<div style={{fontSize:"9px",color:C.textDim,paddingLeft:"8px"}}>+{items.length-3} meer</div>}
                        </div>
                      ):null)}
                    </div>
                  )}
                  <EventTimeline displayedData={displayedData} />
                  <div style={{padding:"8px 14px 4px",fontSize:"9px",fontWeight:700,color:C.textDim,textTransform:"uppercase",letterSpacing:"0.1em"}}>SPARQL Queries</div>
                  <div style={{overflowY:"auto",flex:1}}>
                    {QUERIES.map(q=>{const sv=SEV[q.sev];const active=selQ.id===q.id;return(
                      <div key={q.id} onClick={()=>pickQuery(q.id)} style={{padding:"6px 14px 8px",borderLeft:active?`2px solid ${C.teal}`:"2px solid transparent",background:active?C.surfaceEl:"transparent",cursor:"pointer"}}>
                        <span style={{fontSize:"8px",fontWeight:700,padding:"1px 5px",borderRadius:"3px",background:sv.bg,color:sv.c,border:`1px solid ${sv.bc}`,textTransform:"uppercase"}}>{q.sev}</span>
                        <div style={{fontSize:"11px",lineHeight:1.3,color:active?C.text:C.textMid,marginTop:"3px"}}>{q.label}</div>
                      </div>
                    );})}
                  </div>
                </>
              )}
              <div style={{padding:"8px 14px",borderTop:`1px solid ${C.border}`}}>
                <div style={{fontSize:"8px",color:C.textDim}}>{isDemo?<span style={{color:C.amber}}>Demo mode</span>:<><span style={{color:C.green}}>●</span> rdflib connected</>}</div>
              </div>
            </div>

            {/* Editor + Results */}
            <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
              <div style={{padding:"12px 15px",borderBottom:`1px solid ${C.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"8px",gap:"10px"}}>
                  <div style={{minWidth:0}}>
                    <div style={{fontWeight:600,fontSize:"13px",marginBottom:"2px"}}>{selQ.label}</div>
                    <div style={{fontSize:"9px",color:C.textDim,fontFamily:"monospace",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selQ.ocbc}</div>
                  </div>
                  <div style={{display:"flex",gap:"6px",flexShrink:0}}>
                    <button onClick={run} disabled={running} style={{padding:"6px 14px",borderRadius:"6px",border:"none",cursor:running?"not-allowed":"pointer",background:running?C.surfaceEl:C.teal,color:running?"#555":"#09132B",fontSize:"12px",fontWeight:700}}>
                      {running?"Running…":"▶ Execute"}
                    </button>
                    {results&&<button onClick={diagnose} disabled={diaRun} style={{padding:"6px 13px",borderRadius:"6px",border:`1px solid ${C.borderMid}`,cursor:diaRun?"not-allowed":"pointer",background:diaRun?C.surface:C.surfaceEl,color:diaRun?C.textDim:C.text,fontSize:"12px",fontWeight:500}}>
                      {diaRun?"Analysing…":"⚡ AI Explanation"}
                    </button>}
                  </div>
                </div>
                <textarea value={qtext} onChange={e=>setQtext(e.target.value)} spellCheck={false}
                  style={{width:"100%",height:"120px",background:"#04090F",border:`1px solid ${C.borderMid}`,borderRadius:"7px",color:"#6DD5C8",fontFamily:"'Menlo','Monaco','Consolas',monospace",fontSize:"11px",padding:"10px 12px",resize:"vertical",lineHeight:"1.65",outline:"none",boxSizing:"border-box"}}
                />
              </div>
              <div style={{display:"flex",borderBottom:`1px solid ${C.border}`,paddingLeft:"15px",background:C.nav}}>
                {["results","explanation"].map(t=>(
                  <button key={t} onClick={()=>setTab(t)} style={{padding:"8px 14px",background:"none",border:"none",cursor:"pointer",color:tab===t?C.teal:C.textMid,borderBottom:tab===t?`2px solid ${C.teal}`:"2px solid transparent",fontSize:"12px",fontWeight:tab===t?600:400,textTransform:"capitalize",display:"flex",alignItems:"center",gap:"6px"}}>
                    {t}
                    {t==="results"&&results&&<span style={{padding:"1px 7px",borderRadius:"20px",fontSize:"10px",fontWeight:700,background:results.count>0?C.redDim:C.greenDim,color:results.count>0?C.red:C.green}}>{results.count}</span>}
                  </button>
                ))}
              </div>
              <div style={{flex:1,overflow:"auto",padding:"14px 15px"}}>
                {err&&<div style={{padding:"9px 12px",borderRadius:"7px",background:C.redDim,border:`1px solid ${C.redBd}`,color:C.red,fontSize:"12px",marginBottom:"12px"}}>{err}</div>}
                {tab==="results"&&(results?(
                  <div>
                    <div style={{marginBottom:"10px",fontSize:"11px",color:C.textMid,display:"flex",alignItems:"center",gap:"8px"}}>
                      <span>{results.note}</span>
                      <span style={{width:"1px",height:"11px",background:C.border,display:"inline-block"}}/>
                      <span style={{fontWeight:700,color:results.count>0?C.red:C.green}}>{results.count} violation{results.count!==1?"s":""}</span>
                      {violCount>0&&<span style={{fontSize:"10px",color:C.amber}}>↑ gemarkeerd in graaf</span>}
                    </div>
                    <div style={{borderRadius:"7px",border:`1px solid ${C.border}`,overflow:"hidden"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:"12px"}}>
                        <thead><tr style={{background:C.surface}}>
                          {results.columns?.map(col=>(
                            <th key={col} style={{padding:"8px 11px",textAlign:"left",borderBottom:`1px solid ${C.border}`,color:C.teal,fontSize:"9.5px",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.07em",fontFamily:"monospace",whiteSpace:"nowrap"}}>{col.replace("?","")}</th>
                          ))}
                        </tr></thead>
                        <tbody>{results.rows?.map((row,i)=>(
                          <tr key={i} style={{background:i%2===1?C.surface:"transparent"}}>
                            {results.columns?.map(col=>{
                              const v=row[col]??"—";
                              const display=typeof v==="string"&&v.startsWith("http")?v.split("/").pop():v;
                              return <td key={col} style={{padding:"8px 11px",borderBottom:`1px solid ${C.border}`,fontFamily:"monospace",fontSize:"11px",color:C.text,whiteSpace:"nowrap",maxWidth:"200px",overflow:"hidden",textOverflow:"ellipsis"}} title={String(v)}>{display}</td>;
                            })}
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  </div>
                ):!running&&(
                  <div style={{textAlign:"center",paddingTop:"50px",color:C.textDim}}>
                    <div style={{fontSize:"24px",marginBottom:"10px",opacity:0.2}}>◈</div>
                    <div style={{fontSize:"12px"}}>Select a constraint and click Execute</div>
                  </div>
                ))}
                {tab==="explanation"&&(diaRun?(
                  <div style={{color:C.textMid,fontSize:"12px",animation:"pulse 1.4s infinite"}}>Generating AI explanation…</div>
                ):diag?(
                  <div style={{lineHeight:"1.75",fontSize:"13px",color:C.textMid,maxWidth:"660px"}} dangerouslySetInnerHTML={{__html:`<p style="margin:0">${parseDiag(diag)}</p>`}}/>
                ):!results?(
                  <div style={{textAlign:"center",paddingTop:"50px",color:C.textDim,fontSize:"12px"}}>Run a query first, then click ⚡ AI Explanation</div>
                ):(
                  <div style={{textAlign:"center",paddingTop:"50px",color:C.textDim,fontSize:"12px"}}>Click ⚡ AI Explanation for a process explanation</div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}} textarea:focus{border-color:${C.teal}!important;box-shadow:0 0 0 3px ${C.tealDim};} input:focus{border-color:${C.teal}!important;outline:none;}`}</style>
    </div>
  );
}