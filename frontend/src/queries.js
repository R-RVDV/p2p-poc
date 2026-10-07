// ── P2P Conformance Queries ──────────────────────────────────────
// 9 constraints: 4 Behavioral (BCM) + 2 Data + 3 Segregation of Duties
//
// Constraint IDs map directly to the interview protocol and thesis:
//   B1–B4  Behavioral  — direct OCBC BCM constraints (Van der Aalst et al. 2017)
//   D4, D6 Data        — attribute comparisons via variable bindings (Küsters 2024)
//   S1, S3, S5 SoD     — interaction constraints on ext:userName
//
// KG path reminders:
//   PO  --ext:isDeliveredBy-->  GR
//   PO  --ext:isBilledBy-->     Invoice
//   Inv --ext:generatesFinancialDoc--> FinancialDocument
//   PR  --ext:isConvertedTo-->  PO
//   ClearInvoice observes FinancialDocument (NOT Invoice directly)
//   → to reach Invoice from ClearInvoice: ?inv ext:generatesFinancialDoc ?fi
//
// Velden per query:
//   id    — unieke identifier
//   cat   — categorie (groepeert queries in de sidebar)
//   label — leesbare naam
//   sev   — "critical" | "high" | "medium"
//   ocbc  — OCBC constraint type + label
//   query — SPARQL SELECT query

const QUERIES = [

  // ════════════════════════════════════════════════════════════════
  // BEHAVIORAL CONSTRAINTS — B1–B4
  // Direct OCBC BCM constraints from the OCBC diagram
  // ════════════════════════════════════════════════════════════════

 {
    id:    "b1_gr_without_po",
    cat:   "Behavioral",
    label: "B1 — Goods Receipt posted without a Purchase Order",
    sev:   "high",
    ocbc:  "B1: Unary-Precedence(RecordGoodsReceipt, CreatePurchaseOrder)",
    query: `PREFIX ext:  <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>
 
# Violation: a RecordGoodsReceipt event exists but no PurchaseOrder
# has an ext:isDeliveredBy link to that GoodsReceipt.
#
# Scope filter: only GoodsReceipts that are linked to an Invoice
# via ext:matches are considered. This restricts the query to GRs
# that are part of the P2P conformance scope (i.e. PO-related
# goods movements), excluding MKPF records for other movement
# types (e.g. production issues, reservations) that have no EBELN
# by design and would otherwise inflate the violation count.
 
SELECT ?gr ?grDate
WHERE {
  ?gr a ext:GoodsReceipt .
 
  ?grEvent a ext:RecordGoodsReceipt ;
           oced:observes ?gr ;
           oced:observed_at ?grDate .
 
  # Scope: only GRs that are part of a Three-Way Match chain
  FILTER EXISTS {
    ?inv ext:matches ?gr .
  }
 
  FILTER NOT EXISTS {
    ?po a ext:PurchaseOrder ;
        ext:isDeliveredBy ?gr .
  }
}
ORDER BY ?grDate`,
  },

  {
    id:    "b2_invoice_before_gr",
    cat:   "Behavioral",
    label: "B2 — Invoice recorded without a prior Goods Receipt",
    sev:   "high",
    ocbc:  "B2: Precedence(RecordInvoice, RecordGoodsReceipt)",
    query: `PREFIX ext:  <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>

# Violation: a RecordInvoice event exists but no RecordGoodsReceipt
# event was posted on or before the invoice date for the same PO.
# Covers both: (1) no GR exists at all, and (2) GR posted after invoice.

SELECT ?invoice ?po ?invoiceDate
WHERE {
  ?po a ext:PurchaseOrder ;
      ext:isBilledBy ?invoice .

  ?invEvent a ext:RecordInvoice ;
            oced:observes ?invoice ;
            oced:observed_at ?invoiceDate .

  FILTER NOT EXISTS {
    ?po ext:isDeliveredBy ?gr .

    ?grEvent a ext:RecordGoodsReceipt ;
             oced:observes ?gr ;
             oced:observed_at ?grDate .

    FILTER(?grDate <= ?invoiceDate)
  }
}
ORDER BY ?invoiceDate`,
  },

{
    id:    "b3_payment_before_invoice",
    cat:   "Behavioral",
    label: "B3 — Payment posted without a prior invoice registration",
    sev:   "high",
    ocbc:  "B3: Precedence(ClearInvoice, RecordInvoice)",
    query: `PREFIX ext:  <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>

# Violation: a ClearInvoice event exists for an Invoice that has
# no corresponding RecordInvoice event.
#
# Note: temporal ordering is not checked due to day-level timestamp
# granularity in the SAP source tables (BKPF.BUDAT, RBKP.BLDAT).
# The constraint is operationalised as a presence check: a violation
# is reported when no RecordInvoice event exists at all for the
# corresponding Invoice, regardless of date ordering.
#
# Scope: only ext:Invoice instances are checked. The 2,391 non-invoice
# financial documents in BKPF are excluded because they have no
# rdf:type ext:Invoice triple — without this filter the query returns
# 2,392 false positives.

SELECT ?invoice ?fi
WHERE {
  ?invoice a ext:Invoice .
  ?invoice ext:generatesFinancialDoc ?fi .

  ?clearEvent a ext:ClearInvoice ;
              oced:observes ?fi .

  FILTER NOT EXISTS {
    ?invEvent a ext:RecordInvoice ;
              oced:observes ?invoice .
  }
}`,
  },

  {
    id:    "b4_payment_without_gr",
    cat:   "Behavioral",
    label: "B4 — Invoice cleared without a Goods Receipt (Three-Way Match)",
    sev:   "critical",
    ocbc:  "B4: Precedence(ClearInvoice, RecordGoodsReceipt)",
    query: `PREFIX ext:  <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>

# Violation: an invoice has been cleared (payment posted) but no
# GoodsReceipt exists for the corresponding PurchaseOrder.
# This is the Three-Way Match final check: PO + GR + Invoice must
# all be present before payment is made.

SELECT ?invoice ?po ?fi ?clearDate ?amount
WHERE {
  ?invoice a ext:Invoice .
  ?invoice ext:generatesFinancialDoc ?fi .
  ?po ext:isBilledBy ?invoice .

  ?clearEvent a ext:ClearInvoice ;
              oced:observes ?fi ;
              oced:observed_at ?clearDate .

  OPTIONAL { ?invoice ext:netAmount ?amount }

  FILTER NOT EXISTS {
    ?po ext:isDeliveredBy ?gr .
  }
}
ORDER BY DESC(?amount)`,
  },

  // ════════════════════════════════════════════════════════════════
  // DATA CONSTRAINTS — D4, D6
  // Attribute comparisons on ClaM objects (variable bindings)
  // ════════════════════════════════════════════════════════════════

  {
    id:    "d4_vendor_mismatch",
    cat:   "Data",
    label: "D4 — Vendor on invoice does not match vendor on PO",
    sev:   "critical",
    ocbc:  "D4: Data constraint — ext:vendorId mismatch (Three-Way Match vendor check)",
    query: `PREFIX ext:  <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>

# Violation: the vendor recorded on the invoice (RBKP.LIFNR → ext:vendorId
# on ext:Invoice) differs from the vendor on the Purchase Order
# (EKKO.LIFNR → ext:vendorId on ext:PurchaseOrder).
# A vendor mismatch is a strong indicator of fraud or a master data error.
#
# GROUP BY with MAX(?amt) prevents duplicate rows caused by invoices
# with multiple ext:netAmount values (multi-line RSEG artefact).

SELECT ?invoice ?po ?invoiceVendor ?poVendor (MAX(?amt) AS ?amount)
WHERE {
  ?po a ext:PurchaseOrder ;
      ext:vendorId ?poVendor ;
      ext:isBilledBy ?invoice .

  ?invoice a ext:Invoice ;
           ext:vendorId ?invoiceVendor .

  OPTIONAL { ?invoice ext:netAmount ?amt }

  FILTER(?invoiceVendor != ?poVendor)
}
GROUP BY ?invoice ?po ?invoiceVendor ?poVendor
ORDER BY DESC(?amount)`,
  },

  {
    id:    "d6_amount_tolerance",
    cat:   "Data",
    label: "D6 — Invoiced amount exceeds PO value beyond tolerance",
    sev:   "high",
    ocbc:  "D6: Data constraint — ext:netAmount deviation (Three-Way Match amount check)",
    query: `PREFIX ext:  <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>

# Violation: the invoiced amount (RSEG.WRBTR → ext:netAmount on Invoice)
# exceeds the PO value (EKPO.NETWR → ext:netAmount on PurchaseOrder)
# by more than the configured tolerance.
#
# ⚠️  TOLERANCE: currently set to 5% (1.05 multiplier).
#     Update this value after the expert interview confirms the
#     organisation's actual MIRO tolerance key setting.

SELECT ?invoice ?po ?invoicedAmount ?poValue ?deviation
WHERE {
  ?po a ext:PurchaseOrder ;
      ext:netAmount ?poValue ;
      ext:isBilledBy ?invoice .

  ?invoice a ext:Invoice ;
           ext:netAmount ?invoicedAmount .

  BIND(?invoicedAmount - ?poValue AS ?deviation)

  FILTER(?invoicedAmount > ?poValue * 1.05)
}
ORDER BY DESC(?deviation)`,
  },

  // ════════════════════════════════════════════════════════════════
  // SEGREGATION OF DUTIES — S1, S3, S5
  // Interaction constraints on ext:userName across event types
  // ════════════════════════════════════════════════════════════════

  {
    id:    "s1_po_creator_is_invoice_enterer",
    cat:   "Segregation of Duties",
    label: "S1 — PO creator also entered the vendor invoice",
    sev:   "critical",
    ocbc:  "S1: SoD — CreatePurchaseOrder ≠ RecordInvoice (ext:userName)",
    query: `PREFIX ext:  <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>

# Violation: the same ext:userName appears on both a CreatePurchaseOrder
# event and a RecordInvoice event for the same PO/Invoice combination.
# Source fields: EKKO.ERNAM (PO creator) and RBKP.USNAM (invoice enterer).

SELECT ?user ?po ?invoice ?poDate ?invDate
WHERE {
  ?poEvent a ext:CreatePurchaseOrder ;
           oced:observes ?po ;
           ext:userName ?user ;
           oced:observed_at ?poDate .

  ?invEvent a ext:RecordInvoice ;
            oced:observes ?invoice ;
            ext:userName ?user ;
            oced:observed_at ?invDate .

  ?po ext:isBilledBy ?invoice .
}
ORDER BY ?user ?poDate`,
  },

  {
    id:    "s3_invoice_enterer_is_payment_poster",
    cat:   "Segregation of Duties",
    label: "S3 — Invoice enterer also posted the payment",
    sev:   "critical",
    ocbc:  "S3: SoD — RecordInvoice ≠ ClearInvoice (ext:userName)",
    query: `PREFIX ext:  <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>

# Violation: the same ext:userName appears on both a RecordInvoice event
# and the corresponding ClearInvoice event.
# Source fields: RBKP.USNAM (invoice enterer) and BKPF.USNAM (payment poster).
# Link: Invoice → FinancialDocument via ext:generatesFinancialDoc;
#       ClearInvoice observes FinancialDocument.

SELECT ?user ?invoice ?fi ?invDate ?clearDate
WHERE {
  ?invEvent a ext:RecordInvoice ;
            oced:observes ?invoice ;
            ext:userName ?user ;
            oced:observed_at ?invDate .

  ?invoice ext:generatesFinancialDoc ?fi .

  ?clearEvent a ext:ClearInvoice ;
              oced:observes ?fi ;
              ext:userName ?user ;
              oced:observed_at ?clearDate .
}
ORDER BY ?user ?invDate`,
  },

  {
    id:    "s5_po_creator_is_gr_poster",
    cat:   "Segregation of Duties",
    label: "S5 — PO creator also posted the Goods Receipt",
    sev:   "high",
    ocbc:  "S5: SoD — CreatePurchaseOrder ≠ RecordGoodsReceipt (ext:userName)",
    query: `PREFIX ext:  <http://emixa.nl/p2p/domain#>
PREFIX oced: <https://w3id.org/ocedo/core#>

# Violation: the same ext:userName appears on both a CreatePurchaseOrder
# event and a RecordGoodsReceipt event for the same PO/GR combination.
# Source fields: EKKO.ERNAM (PO creator) and MKPF.USNAM (GR poster).

SELECT ?user ?po ?gr ?poDate ?grDate
WHERE {
  ?poEvent a ext:CreatePurchaseOrder ;
           oced:observes ?po ;
           ext:userName ?user ;
           oced:observed_at ?poDate .

  ?po ext:isDeliveredBy ?gr .

  ?grEvent a ext:RecordGoodsReceipt ;
           oced:observes ?gr ;
           ext:userName ?user ;
           oced:observed_at ?grDate .
}
ORDER BY ?user ?poDate`,
  },

];

export default QUERIES;