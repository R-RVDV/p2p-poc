"""
P2P Conformance Backend
pip install fastapi uvicorn rdflib
uvicorn main:app --reload --port 8000
"""

from pathlib import Path
from collections import defaultdict
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from rdflib import ConjunctiveGraph, URIRef, Literal
from rdflib.namespace import RDF
from pydantic import BaseModel
from anthropic import Anthropic

OCEDD_CONTEXT = """P2P OCED Model — Emixa. Objects: PurchaseRequisition(EBAN),
PurchaseOrder(EKKO/EKPO), GoodsReceipt(MKPF/MSEG), Invoice(RBKP/RSEG),
FinancialDocument(BKPF/BSEG). Events use oced:observes and oced:observed_at.
Relations: isConvertedTo, isDeliveredBy, isBilledBy, matches, generatesFinancialDoc.
Attributes: userName(USNAM), vendorId(LIFNR), netAmount(NETWR/WRBTR),
quantity(MENGE), transactionCode(TCODE).
OCBC: C1 Unary-Response(Req→PO), C2 Unary-Precedence(GR,PO),
C3 Precedence(Invoice,GR), C4 Precedence(Clear,Invoice),
C5 Precedence(Clear,GR)=Three-Way Match."""

app = FastAPI(title="P2P Conformance API")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

EXT  = "http://emixa.nl/p2p/domain#"
OCED = "https://w3id.org/ocedo/core#"

OBSERVES     = URIRef(f"{OCED}observes")
OBS_AT       = URIRef(f"{OCED}observed_at")
USR_P        = URIRef(f"{EXT}userName")
TCODE_P      = URIRef(f"{EXT}transactionCode")
IS_DELIVERED = URIRef(f"{EXT}isDeliveredBy")
IS_BILLED    = URIRef(f"{EXT}isBilledBy")
IS_CONVERTED = URIRef(f"{EXT}isConvertedTo")
MATCHES      = URIRef(f"{EXT}matches")
GEN_FIN      = URIRef(f"{EXT}generatesFinancialDoc")
PO_TYPE      = URIRef(f"{EXT}PurchaseOrder")
NET_AMT      = URIRef(f"{EXT}netAmount")
VENDOR_ID    = URIRef(f"{EXT}vendorId")

OBJ_TYPES = {"PurchaseRequisition","PurchaseOrder","GoodsReceipt","Invoice","FinancialDocument"}
OBJ_RELS  = ["isConvertedTo","isDeliveredBy","isBilledBy","matches","generatesFinancialDoc"]

g = ConjunctiveGraph()
DATA_DIR = Path(__file__).parent / "data"
INJECTED_DIR = Path(__file__).parent / "data" / "injected"
schema_file = DATA_DIR / "emixa_p2p_ocedd.ttl"
data_file   = DATA_DIR / "ocedr_p2p_graph.ttl"

g.parse(str(schema_file), format="turtle")
print(f"Loaded schema: {schema_file.name}  ({len(g)} triples)")
g.parse(str(data_file), format="turtle")
print(f"Loaded data:   {data_file.name}  ({len(g)} triples total)")


# ── SPARQL ────────────────────────────────────────────────────────
class QueryBody(BaseModel):
    query: str

@app.post("/sparql")
def sparql_query(body: QueryBody):
    try:
        result = g.query(body.query)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"SPARQL error: {e}")
    columns = [f"?{v}" for v in result.vars]
    rows = [{f"?{k}": str(v) if v is not None else None for k, v in row.asdict().items()} for row in result]
    return {"columns": columns, "rows": rows, "count": len(rows), "note": f"{len(rows)} result(s)"}


# ── Graph ─────────────────────────────────────────────────────────
@app.get("/graph")
def get_graph(limit: int = 40):
    connected_pos = []
    for po in g.subjects(RDF.type, PO_TYPE):
        has_gr  = next(g.objects(po, IS_DELIVERED), None) is not None
        has_inv = next(g.objects(po, IS_BILLED),    None) is not None
        if has_gr or has_inv:
            connected_pos.append(str(po))
            if len(connected_pos) >= limit:
                break

    if not connected_pos:
        for po in g.subjects(RDF.type, PO_TYPE):
            connected_pos.append(str(po))
            if len(connected_pos) >= limit:
                break

    anchor_uris = set(connected_pos)
    rel_preds   = [IS_CONVERTED, IS_DELIVERED, IS_BILLED, MATCHES, GEN_FIN]
    for _ in range(2):
        current = list(anchor_uris)
        for pred in rel_preds:
            for uri_str in current:
                ref = URIRef(uri_str)
                for o in g.objects(ref, pred): anchor_uris.add(str(o))
                for s in g.subjects(pred, ref): anchor_uris.add(str(s))

    nodes = {}
    for uri_str in anchor_uris:
        ref      = URIRef(uri_str)
        obj_type = None
        for o in g.objects(ref, RDF.type):
            t = str(o).replace(EXT, "")
            if t in OBJ_TYPES: obj_type = t; break
        if not obj_type: continue
        label = uri_str.split("/")[-1]
        node  = {"id": uri_str, "label": label, "type": obj_type}
        for pred, obj in g.predicate_objects(ref):
            if isinstance(obj, Literal) and str(pred).startswith(EXT):
                node[str(pred).replace(EXT, "")] = str(obj)
        nodes[uri_str] = node

    for uri_str, node in nodes.items():
        ref = URIRef(uri_str)
        for ev in g.subjects(OBSERVES, ref):
            if "user"  not in node:
                u = next(g.objects(ev, USR_P),   None)
                if u: node["user"]  = str(u)
            if "date"  not in node:
                d = next(g.objects(ev, OBS_AT),  None)
                if d: node["date"]  = str(d)[:10]
            if "tcode" not in node:
                t = next(g.objects(ev, TCODE_P), None)
                if t: node["tcode"] = str(t)
            if all(k in node for k in ("user","date","tcode")): break

    links, seen = [], set()
    for rel_name in OBJ_RELS:
        pred = URIRef(f"{EXT}{rel_name}")
        for s, o in g.subject_objects(pred):
            s_str, o_str = str(s), str(o)
            if s_str in nodes and o_str in nodes:
                key = f"{s_str}|{o_str}"
                if key not in seen:
                    seen.add(key)
                    links.append({"source": s_str, "target": o_str, "rel": rel_name})

    return {"nodes": list(nodes.values()), "links": links,
            "total_nodes": len(nodes), "total_links": len(links)}


# ── AI Diagnosis ────────────────────────────────────────────────────────
client = Anthropic()  # leest ANTHROPIC_API_KEY automatisch uit omgeving

class DiagnoseBody(BaseModel):
    query: str
    ocbc: str
    count: int
    rows: list
    enriched: list

@app.post("/diagnose")
def diagnose(body: DiagnoseBody):
    system = f"""{OCEDD_CONTEXT}

You are a P2P process compliance expert explaining audit findings to business consultants and internal auditors. They understand procurement processes but are not SAP technical experts.

Write a structured diagnosis with the following sections using clear headers:

**Violation Summary**
One or two sentences. What went wrong in plain business language. Mention specific document numbers and dates.

**Business Risk**
What could go wrong as a result. Focus on financial exposure, fraud risk, and audit consequences. No technical jargon.

**What likely happened**
A short, readable explanation of the most probable cause. Write as if explaining to a manager.

**What to do next**
Two or three concrete actions. Written as clear instructions, not technical specifications.

Rules:
- Never use SAP transaction codes or technical field names
- Replace technical terms: use "purchase order" not "EBELN", "goods receipt" not "MIGO/MKPF"
- Keep each section to 3-4 sentences maximum
- Always mention the specific document numbers and dates from the data"""

    message = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1500,
        system=system,
        messages=[{
            "role": "user",
            "content": f"SPARQL Query:\n{body.query}\n\nOCBC Constraint: {body.ocbc}\nViolations detected: {body.count}\n\nViolation instances with context:\n{body.enriched}"
        }]
    )
    return {"diagnosis": message.content[0].text}

# ── Statistics ────────────────────────────────────────────────────
@app.get("/stats")
def get_stats():
    stats = {}

    # ── 1. Object counts (volledig, niet alleen connected) ───────
    for t in OBJ_TYPES:
        stats[f"count_{t}"] = len(list(g.subjects(RDF.type, URIRef(f"{EXT}{t}"))))

    # ── 2. P2P trechter ──────────────────────────────────────────
    total_pos   = stats["count_PurchaseOrder"]
    connected   = 0   # PO met GR of Invoice
    has_gr_cnt  = 0   # PO met minstens 1 GR
    has_inv_cnt = 0   # PO met minstens 1 Invoice
    complete    = 0   # PO met GR + Invoice + FinDoc (volledige 3WM)
    maverick    = 0   # PO zonder Requisition

    for po in g.subjects(RDF.type, PO_TYPE):
        gr  = next(g.objects(po, IS_DELIVERED), None)
        inv = next(g.objects(po, IS_BILLED),    None)
        req = next(g.subjects(IS_CONVERTED, po), None)

        if gr:  has_gr_cnt  += 1
        if inv: has_inv_cnt += 1
        if gr or inv: connected += 1
        if not req:   maverick  += 1

        if gr and inv:
            fi = next(g.objects(inv, GEN_FIN), None)
            if fi: complete += 1

    stats["connected_pos"]  = connected
    stats["has_gr_pos"]     = has_gr_cnt
    stats["has_inv_pos"]    = has_inv_cnt
    stats["complete_flows"] = complete
    stats["maverick_pos"]   = maverick

    # ── 3. Potentiële violations (snelle scan, geen SPARQL) ──────
    # C5: PO heeft Invoice maar geen GR
    potential_c5 = 0
    for po in g.subjects(RDF.type, PO_TYPE):
        has_inv = next(g.objects(po, IS_BILLED),    None) is not None
        has_gr  = next(g.objects(po, IS_DELIVERED), None) is not None
        if has_inv and not has_gr:
            potential_c5 += 1
    stats["potential_c5"] = potential_c5

    # ── 4. Financieel (op Invoice objecten) ──────────────────────
    amounts = []
    for inv in g.subjects(RDF.type, URIRef(f"{EXT}Invoice")):
        for amt in g.objects(inv, NET_AMT):
            try: amounts.append(float(str(amt)))
            except: pass

    stats["invoice_with_amount"] = len(amounts)
    stats["total_invoiced"]      = round(sum(amounts), 2)          if amounts else 0
    stats["avg_invoice"]         = round(sum(amounts)/len(amounts), 2) if amounts else 0
    stats["max_invoice"]         = round(max(amounts), 2)          if amounts else 0
    stats["min_invoice"]         = round(min(amounts), 2)          if amounts else 0

    # ── 5. GRs per PO (gemiddeld) ────────────────────────────────
    gr_counts = []
    for po in g.subjects(RDF.type, PO_TYPE):
        cnt = len(list(g.objects(po, IS_DELIVERED)))
        if cnt > 0: gr_counts.append(cnt)
    stats["avg_gr_per_po"] = round(sum(gr_counts)/len(gr_counts), 2) if gr_counts else 0

    # ── 6. Top leveranciers (op PO-aantallen) ────────────────────
    vendor_counts = {}
    for po in g.subjects(RDF.type, PO_TYPE):
        for v in g.objects(po, VENDOR_ID):
            vs = str(v)
            vendor_counts[vs] = vendor_counts.get(vs, 0) + 1
    stats["top_vendors"] = [
        {"vendor": v, "count": c}
        for v, c in sorted(vendor_counts.items(), key=lambda x: -x[1])[:8]
    ]

    # ── 7. Top gebruikers (op event-aantallen) ───────────────────
    user_counts = {}
    for ev in g.subjects(OBSERVES, None):
        for u in g.objects(ev, USR_P):
            us = str(u)
            user_counts[us] = user_counts.get(us, 0) + 1
    stats["top_users"] = [
        {"user": u, "count": c}
        for u, c in sorted(user_counts.items(), key=lambda x: -x[1])[:8]
    ]

    # ── 8. Top T-codes ───────────────────────────────────────────
    tcode_counts = {}
    for ev in g.subjects(OBSERVES, None):
        for tc in g.objects(ev, TCODE_P):
            tcs = str(tc)
            tcode_counts[tcs] = tcode_counts.get(tcs, 0) + 1
    stats["top_tcodes"] = [
        {"tcode": t, "count": c}
        for t, c in sorted(tcode_counts.items(), key=lambda x: -x[1])[:6]
    ]

    return stats


# ── Model-Wide Conformance ────────────────────────────────────────
# Ports model_wide_conformance.py + sparql_queries.py into a single
# FastAPI endpoint. Uses the already-loaded ConjunctiveGraph `g`.

_STATUS_CONFORM   = "CONFORM"
_STATUS_VIOLATION = "VIOLATION"
_STATUS_MAVERICK  = "MAVERICK"
_STATUS_NA        = "N/A"
_STATUS_TIE       = "TIE"

_Q_IS_CONVERTED_TO = """
PREFIX ext: <http://emixa.nl/p2p/domain#>
SELECT ?po ?req WHERE {
    ?po a ext:PurchaseOrder .
    OPTIONAL { ?req ext:isConvertedTo ?po }
}"""

_Q_ORPHAN_REQS = """
PREFIX ext: <http://emixa.nl/p2p/domain#>
SELECT ?req WHERE {
    ?req a ext:PurchaseRequisition .
    FILTER NOT EXISTS { ?req ext:isConvertedTo ?po }
}"""

_Q_MATCHES = """
PREFIX ext: <http://emixa.nl/p2p/domain#>
SELECT ?invoice (COUNT(?gr) AS ?n) WHERE {
    ?invoice a ext:Invoice ; ^ext:isBilledBy ?po .
    OPTIONAL { ?po ext:isDeliveredBy ?gr }
} GROUP BY ?invoice"""

_Q_PO_INVOICES = """
PREFIX ext: <http://emixa.nl/p2p/domain#>
SELECT ?po ?invoice WHERE {
    ?po a ext:PurchaseOrder .
    OPTIONAL { ?po ext:isBilledBy ?invoice }
}"""

def _downstream_q(src_class, relation):
    return f"""PREFIX ext: <http://emixa.nl/p2p/domain#>
SELECT ?source (COUNT(?target) AS ?n) WHERE {{
    ?source a ext:{src_class} .
    OPTIONAL {{ ?source ext:{relation} ?target }}
}} GROUP BY ?source"""

_Q_TIME_REQ = """
PREFIX ext: <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>
SELECT ?po (MIN(?t) AS ?minT) WHERE {
    ?req a ext:PurchaseRequisition ; ext:isConvertedTo ?po .
    ?ev a ext:CreateRequisition ; oced:observes ?req ; oced:observed_at ?t .
} GROUP BY ?po"""

_Q_TIME_PO = """
PREFIX ext: <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>
SELECT ?po (MIN(?t) AS ?minT) WHERE {
    ?po a ext:PurchaseOrder .
    ?ev a ext:CreatePurchaseOrder ; oced:observes ?po ; oced:observed_at ?t .
} GROUP BY ?po"""

_Q_TIME_GR = """
PREFIX ext: <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>
SELECT ?po (MIN(?t) AS ?minT) WHERE {
    ?po a ext:PurchaseOrder ; ext:isDeliveredBy ?gr .
    ?ev a ext:RecordGoodsReceipt ; oced:observes ?gr ; oced:observed_at ?t .
} GROUP BY ?po"""

_Q_TIME_INV = """
PREFIX ext: <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>
SELECT ?po (MIN(?t) AS ?minT) WHERE {
    ?po a ext:PurchaseOrder ; ext:isBilledBy ?inv .
    ?ev a ext:RecordInvoice ; oced:observes ?inv ; oced:observed_at ?t .
} GROUP BY ?po"""

_Q_TIME_CLEAR = """
PREFIX ext: <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>
SELECT ?po (MIN(?t) AS ?minT) WHERE {
    ?po a ext:PurchaseOrder ; ext:isBilledBy ?inv .
    ?inv ext:generatesFinancialDoc ?fd .
    ?ev a ext:ClearInvoice ; oced:observes ?fd ; oced:observed_at ?t .
} GROUP BY ?po"""

def _min_times(query):
    return {row.po: str(row.minT) for row in g.query(query) if row.minT is not None}

def _order(t_early, t_late):
    if t_early == t_late: return _STATUS_TIE
    return _STATUS_CONFORM if t_early < t_late else _STATUS_VIOLATION

def _build_summary(report, total):
    OKAY = {_STATUS_CONFORM, _STATUS_MAVERICK, _STATUS_NA, _STATUS_TIE}
    conform      = sum(1 for s in report.values() if all(v in OKAY for v in s.values()))
    maverick     = sum(1 for s in report.values() if s.get("isConvertedTo") == _STATUS_MAVERICK)
    per_viol     = defaultdict(int)
    per_ties     = defaultdict(int)
    per_viol_pos = defaultdict(list)
    for po_uri, s in report.items():
        for rel, status in s.items():
            if status == _STATUS_VIOLATION:
                per_viol[rel] += 1
                per_viol_pos[rel].append(str(po_uri))
            elif status == _STATUS_TIE:
                per_ties[rel] += 1
    return {
        "total":             total,
        "conform":           conform,
        "violation":         total - conform,
        "maverick":          maverick,
        "per_relation":      dict(per_viol),
        "per_relation_ties": dict(per_ties),
        "per_relation_pos":  dict(per_viol_pos),
    }

@app.get("/conformance")
def get_conformance():
    # ClaM layer
    conv = {}
    for row in g.query(_Q_IS_CONVERTED_TO):
        conv[row.po] = _STATUS_CONFORM if row.req is not None else _STATUS_MAVERICK

    orphan_reqs = list(g.query(_Q_ORPHAN_REQS))

    deliv = {row.source: (_STATUS_CONFORM if int(row.n) > 0 else _STATUS_VIOLATION)
             for row in g.query(_downstream_q("PurchaseOrder", "isDeliveredBy"))}
    bill  = {row.source: (_STATUS_CONFORM if int(row.n) > 0 else _STATUS_VIOLATION)
             for row in g.query(_downstream_q("PurchaseOrder", "isBilledBy"))}
    fin   = {row.source: (_STATUS_CONFORM if int(row.n) > 0 else _STATUS_VIOLATION)
             for row in g.query(_downstream_q("Invoice", "generatesFinancialDoc"))}

    match_results = {row.invoice: (_STATUS_CONFORM if int(row.n) > 0 else _STATUS_VIOLATION)
                     for row in g.query(_Q_MATCHES)}

    po_invoices = defaultdict(list)
    for row in g.query(_Q_PO_INVOICES):
        if row.invoice is not None:
            po_invoices[row.po].append(row.invoice)

    all_pos = set(conv) | set(deliv) | set(bill)

    # BCM layer
    times = {
        "req":   _min_times(_Q_TIME_REQ),
        "po":    _min_times(_Q_TIME_PO),
        "gr":    _min_times(_Q_TIME_GR),
        "inv":   _min_times(_Q_TIME_INV),
        "clear": _min_times(_Q_TIME_CLEAR),
    }

    report = {}
    for po in all_pos:
        t_req, t_po = times["req"].get(po), times["po"].get(po)
        t_gr,  t_inv = times["gr"].get(po),  times["inv"].get(po)
        t_clear = times["clear"].get(po)

        s = {
            "isConvertedTo": conv.get(po, _STATUS_VIOLATION),
            "isDeliveredBy": deliv.get(po, _STATUS_VIOLATION),
            "isBilledBy":    bill.get(po, _STATUS_VIOLATION),
        }
        inv_statuses = [fin.get(inv, _STATUS_VIOLATION) for inv in po_invoices.get(po, [])]
        s["invoiceChain"] = (_STATUS_VIOLATION if _STATUS_VIOLATION in inv_statuses
                             else _STATUS_CONFORM) if inv_statuses else _STATUS_CONFORM

        s["C1_Req_before_PO"]        = _STATUS_NA if t_req is None   else (_STATUS_VIOLATION if t_po is None    else _order(t_req, t_po))
        s["C2_PO_before_GR"]         = _STATUS_NA if t_gr is None    else (_STATUS_VIOLATION if t_po is None    else _order(t_po, t_gr))
        s["C3_GR_before_Invoice"]    = _STATUS_NA if t_inv is None   else (_STATUS_VIOLATION if t_gr is None    else _order(t_gr, t_inv))
        s["C4_Invoice_before_Clear"] = _STATUS_NA if t_clear is None else (_STATUS_VIOLATION if t_inv is None   else _order(t_inv, t_clear))
        s["C5_GR_before_Clear"]      = _STATUS_NA if t_clear is None else (_STATUS_VIOLATION if t_gr is None    else _order(t_gr, t_clear))

        report[po] = s

    all_summary    = _build_summary(report, len(report))
    billed_pos     = {po for po, invs in po_invoices.items() if invs}
    subset_summary = _build_summary(
        {po: s for po, s in report.items() if po in billed_pos},
        len(billed_pos)
    )

    n_inv  = len(match_results)
    n_viol = sum(1 for s in match_results.values() if s == _STATUS_VIOLATION)
    per_po = {str(po): statuses for po, statuses in report.items()}
    return {
        "all":    all_summary,
        "subset": subset_summary,
        "three_way_match": {
            "total_invoices": n_inv,
            "conform":        n_inv - n_viol,
            "violations":     n_viol,
            "pct":            round((n_inv - n_viol) / n_inv * 100, 1) if n_inv else 0,
        },
        "orphan_reqs":   len(orphan_reqs),
        "per_po_status": per_po,
        "billed_pos":    [str(po) for po in billed_pos],
    }


# ── Debug & Health ────────────────────────────────────────────────
@app.get("/debug")
def debug():
    counts = {t: len(list(g.subjects(RDF.type, URIRef(f"{EXT}{t}")))) for t in OBJ_TYPES}
    rels   = {r: len(list(g.subject_objects(URIRef(f"{EXT}{r}")))) for r in OBJ_RELS}
    connected = sum(1 for po in g.subjects(RDF.type, PO_TYPE)
                    if next(g.objects(po, IS_DELIVERED), None) or next(g.objects(po, IS_BILLED), None))
    return {"total_triples": len(g), "object_counts": counts, "relation_counts": rels,
            "connected_pos": connected,
            "event_predicates": {
                "oced:observes":    len(list(g.subject_objects(OBSERVES))),
                "oced:observed_at": len(list(g.subject_objects(OBS_AT))),
            }}

@app.get("/health")
def health():
    return {"status": "ok", "triples": len(g)}