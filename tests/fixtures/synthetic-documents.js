/**
 * Synthetic Test Documents & Extractions for FinChat Chunking Pipeline
 * 
 * All fixtures in this file are synthetic test models labeled for offline unit testing.
 */

// 1. Multi-pack containing Contoso Logistics Q2 2026 v2 and v1
// Note: CFO signature line is placed AFTER the v1 section, and a blank line is inside the v2 table
// to test signature reassignment and layout noise.
const SYNTHETIC_LOGISTICS_MULTI_PACK = `Contoso Logistics LLC
Management Pack – Statement of Profit or Loss for the quarter ended 30 June 2026 (version 2)
Status: Final management pack (unaudited) – supersedes v1 Prepared: 16 July 2026 Currency: AED

| AED | Q2 2026 |
| --- | --- |
| Revenue | 9,350,000 |

| Direct operating costs | (6,591,800) |
| Gross profit | 2,758,200 |
| Operating expenses | (1,468,200) |
| Operating profit | 1,290,000 |
| Finance costs | (139,500) |
| Profit before tax | 1,150,500 |
| Corporate tax (9%) | (103,545) |
| Net profit for the period | 1,046,955 |

Notes:
1. This version supersedes version 1 dated 8 July 2026. June revenue now reflects final invoicing for all key accounts, which increased revenue by AED 245,000 compared with the draft.

## CFO commentary
Volumes on the Jebel Ali to Abu Dhabi corridor were up 9% on the first quarter. Fuel costs eased slightly, improving the direct cost ratio. A new warehousing contract signed in June will start contributing in the third quarter.

Contoso Logistics LLC
Management Pack – Statement of Profit or Loss for the quarter ended 30 June 2026 (version 1)
DRAFT
Status: DRAFT v1 – superseded, not approved Prepared: 8 July 2026 Currency: AED

| AED | Q2 2026 |
| --- | --- |
| Revenue | 9,105,000 |
| Direct operating costs | (6,591,800) |
| Gross profit | 2,513,200 |
| Net profit for the period | 951,041 |

Notes:
1. Draft figures pending June final billing reconciliation.

– Chief Financial Officer, Contoso Logistics LLC (fictional)`;

// 2. Contoso Retail LLC Q2 2026 pack (using "Cost of sales" instead of "Direct operating costs")
const SYNTHETIC_RETAIL_Q2_PACK = `Contoso Retail LLC
Management Pack – Statement of Profit or Loss for the quarter ended 30 June 2026 (version 1)
Status: Final (unaudited) Prepared: 15 July 2026 Currency: AED

| AED | Q2 2026 |
| --- | --- |
| Revenue | 14,200,000 |
| Cost of sales | (9,800,000) |
| Gross profit | 4,400,000 |
| Net profit for the period | 1,850,000 |

## Management discussion
Retail footfall across Dubai malls rebounded strongly in Q2. Gross margins improved by 120 basis points following direct sourcing renegotiations.

– Chief Financial Officer, Contoso Retail LLC`;

// 3. Contoso Properties LLC Q1 2026 pack with Cash position section BEFORE commentary
const SYNTHETIC_PROPERTIES_Q1_PACK = `Contoso Properties LLC
Management Pack – Statement of Profit or Loss for the quarter ended 31 March 2026 (version 1)
Status: Final (unaudited) Prepared: 20 April 2026 Currency: AED

| AED | Q1 2026 |
| --- | --- |
| Revenue | 5,400,000 |
| Operating costs | (3,100,000) |
| Net profit for the period | 1,200,000 |

## Cash position
Closing cash balance as of 31 March 2026 was AED 1.18 million against a board-mandated minimum requirement of AED 1.5 million, resulting in a temporary shortfall of AED 320,000. This variance arose because commercial rent collections of AED 410,000 were delayed into early April, while a major preventive maintenance payment of AED 260,000 was executed two weeks ahead of schedule.

## CFO commentary
No expected Q2 shortfall. The collection cycle normalized during the first week of April with 94% of outstanding commercial tenant receivables settled.

– Chief Financial Officer, Contoso Properties LLC`;

// 4. Contoso Logistics LLC Q1 2026 Audited Statements
// Note 1 is an auditor report; Note 2 is direct operating costs breakdown.
const SYNTHETIC_LOGISTICS_Q1_AUDITED = `Contoso Logistics LLC
Financial Statements for the period ended 31 March 2026 (version 1)
Status: Approved (audited) Prepared: 30 April 2026 Currency: AED

| AED | Q1 2026 |
| --- | --- |
| Revenue | 8,920,000 |
| Direct operating costs | (6,320,000) |
| Gross profit | 2,600,000 |
| Net profit for the period | 980,000 |

Note 1 – Independent auditor report
We have audited the financial statements of Contoso Logistics LLC for the period ended 31 March 2026. In our opinion, the accompanying financial statements present fairly, in all material respects, the financial position of the company in accordance with IFRS. Dated 30 April 2026.
– Senior Audit Partner, Ernst & Partners LLC

Note 2 – Direct operating costs breakdown
Direct operating costs comprise fuel expenses of AED 2,850,000, driver compensation and allowances of AED 2,120,000, vehicle operating leases of AED 890,000, and third-party haulage sub-contracts of AED 460,000 totaling AED 6,320,000.`;

// 5. Budget FY2026 Workbook for Contoso Logistics
const SYNTHETIC_LOGISTICS_BUDGET = `Contoso Logistics LLC
Budget Workbook FY2026 (version 1)
Status: Approved basis: budget Approved: 15 December 2025 Currency: AED

| Metric (AED) | Q1 2026 | Q2 2026 | Q3 2026 | Q4 2026 | FY2026 Total |
| --- | --- | --- | --- | --- | --- |
| Revenue | 8,800,000 | 9,100,000 | 9,400,000 | 9,700,000 | 37,000,000 |
| Direct operating costs | (6,200,000) | (6,400,000) | (6,600,000) | (6,800,000) | (26,000,000) |
| Gross profit | 2,600,000 | 2,700,000 | 2,800,000 | 2,900,000 | 11,000,000 |
| Net profit | 920,000 | 980,000 | 1,050,000 | 1,120,000 | 4,070,000 |

Notes:
1. Blue figures are budget inputs; black figures are formulas.`;

// 6. Arabic Management Pack
const SYNTHETIC_ARABIC_PACK = `شركة كونتوسو للخدمات اللوجستية ذ.م.م
تقرير الإدارة المالي للربع المنتهي في ٣٠ يونيو ٢٠٢٦ (الإصدار ٢)
الحالة: نهائي (غير مدقق) يلغي ويحل محل الإصدار ١ تاريخ الإعداد: ١٦ يوليو ٢٠٢٦ العملة: درهم

| درهم إماراتي | الربع الثاني ٢٠٢٦ |
| --- | --- |
| الإيرادات | ٩٬٣٥٠٬٠٠٠ |
| تكاليف التشغيل المباشرة | (٦٬٥٩١٬٨٠٠) |
| إجمالي الربح | ٢٬٧٥٨٬٢٠٠ |
| صافي ربح الفترة | ١٬٠٤٦٬٩٥٥ |

ملاحظات:
١. هذا الإصدار يحل محل الإصدار ١ المؤرخ ٨ يوليو ٢٠٢٦.

## تعليق المدير المالي
ارتفعت أحجام النقل على مسار جبل علي إلى أبوظبي بنسبة ٩٪ مقارنة بالربع الأول؛ وتراجعت تكاليف الوقود بشكل طفيف مما ساهم في تحسين هامش التشغيل. هل نتوقع استمرار هذا التحسن في الربع القادم؟ نعم، وفقاً للعقود الجديدة.

– المدير المالي، شركة كونتوسو للخدمات اللوجستية ذ.م.م`;

// 7. Large Table Document (100 rows to test table splitting at row boundaries)
function generate100RowTableDocument() {
    const header = `Contoso Fleet Operations LLC\nFleet Asset Ledger for the period ended 30 June 2026 (version 1)\nStatus: Final (unaudited) Currency: AED\n\n| Vehicle ID | Category | Make & Model | Cost (AED) | Depreciation (AED) | Net Book Value (AED) |\n| --- | --- | --- | --- | --- | --- |\n`;
    const rows = [];
    for (let i = 1; i <= 100; i++) {
        rows.push(`| TRK-${1000 + i} | Heavy Haulage | Volvo FH16 | ${450000 + i * 100} | ${(45000 + i * 10)} | ${405000 + i * 90} |`);
    }
    return header + rows.join('\n');
}

// 8. Document with an Unknown Section
const SYNTHETIC_UNKNOWN_SECTION_DOC = `Contoso Tech Services LLC
Management Pack – Q2 2026 (version 1)
Status: Final (unaudited) Currency: AED

| Metric | Q2 2026 |
| --- | --- |
| Revenue | 3,100,000 |

## Operational Telemetry Logs & Appendix Omega
Raw sensor diagnostics: stream_id=98821 payload_hash=abc982ff19 checksum=valid. Unclassified vendor debug metadata.`;

module.exports = {
    SYNTHETIC_LOGISTICS_MULTI_PACK,
    SYNTHETIC_RETAIL_Q2_PACK,
    SYNTHETIC_PROPERTIES_Q1_PACK,
    SYNTHETIC_LOGISTICS_Q1_AUDITED,
    SYNTHETIC_LOGISTICS_BUDGET,
    SYNTHETIC_ARABIC_PACK,
    generate100RowTableDocument,
    SYNTHETIC_UNKNOWN_SECTION_DOC
};

