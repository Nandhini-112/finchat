const test = require('node:test');
const assert = require('node:assert/strict');
const { createChunks } = require('../src/services/chunking');
const { buildSearchDocument, VECTOR_DIMENSIONS } = require('../src/services/search-document');
const { buildDefaultSearchFilter, findStaleChunkIds } = require('../src/services/chunking/search-helpers');
const {
    SYNTHETIC_LOGISTICS_MULTI_PACK,
    SYNTHETIC_RETAIL_Q2_PACK,
    SYNTHETIC_PROPERTIES_Q1_PACK,
    SYNTHETIC_LOGISTICS_Q1_AUDITED,
    SYNTHETIC_LOGISTICS_BUDGET,
    SYNTHETIC_ARABIC_PACK,
    generate100RowTableDocument,
    SYNTHETIC_UNKNOWN_SECTION_DOC
} = require('./fixtures/synthetic-documents');

const mockVector = () => Array(VECTOR_DIMENSIONS).fill(0.05);

// ============================================================================
// ACCEPTANCE TEST 1: Chunk Counts and Types
// ============================================================================
test('Acceptance 1: Chunk counts and types match specification across documents', () => {
    // 1. Logistics Multi-pack (Contains v2 and v1)
    const logRes = createChunks(SYNTHETIC_LOGISTICS_MULTI_PACK, { fileName: 'logistics_multi.pdf' });
    const logDocs = logRes.documents;
    assert.equal(logDocs.length, 2, 'Multi-pack must split into exactly 2 document versions');

    const v2Chunks = logRes.chunks.filter(c => c.metadata.version === 2);
    const v1Chunks = logRes.chunks.filter(c => c.metadata.version === 1);

    // Logistics v2 = card, table (with Note 1 attached), commentary (with signature)
    const v2Types = v2Chunks.map(c => c.chunk_type);
    assert.deepEqual(v2Types, ['card', 'table', 'commentary']);
    assert.match(v2Chunks.find(c => c.chunk_type === 'table').content, /Note 1|Notes:/i);

    // Logistics v1 = card, table, no commentary
    const v1Types = v1Chunks.map(c => c.chunk_type);
    assert.deepEqual(v1Types, ['card', 'table']);

    // 2. Retail = card, table, commentary
    const retailRes = createChunks(SYNTHETIC_RETAIL_Q2_PACK, { fileName: 'retail_q2.pdf' });
    const retailTypes = retailRes.chunks.map(c => c.chunk_type);
    assert.deepEqual(retailTypes, ['card', 'table', 'commentary']);

    // 3. Properties = card, table, section (Cash position), commentary
    const propRes = createChunks(SYNTHETIC_PROPERTIES_Q1_PACK, { fileName: 'properties_q1.pdf' });
    const propTypes = propRes.chunks.map(c => c.chunk_type);
    assert.deepEqual(propTypes, ['card', 'table', 'section', 'commentary']);
    const cashSection = propRes.chunks.find(c => c.chunk_type === 'section');
    assert.match(cashSection.title, /Cash position/i);

    // 4. Logistics Q1 Audited = card, table (notes attached if within limits, otherwise separate section chunks)
    const auditRes = createChunks(SYNTHETIC_LOGISTICS_Q1_AUDITED, { fileName: 'logistics_q1_audited.pdf' });
    const auditTypes = auditRes.chunks.map(c => c.chunk_type);
    assert.ok(auditTypes.includes('card') && auditTypes.includes('table'), 'Audited statements must have card and table');
    const auditTable = auditRes.chunks.find(c => c.chunk_type === 'table');
    assert.match(auditTable.content, /Direct operating costs comprise fuel|Note 1/i, 'Notes within limits attach to table');

    // 5. Budget = card, table
    const budgetRes = createChunks(SYNTHETIC_LOGISTICS_BUDGET, { fileName: 'budget_fy2026.xlsx' });
    const budgetTypes = budgetRes.chunks.map(c => c.chunk_type);
    assert.deepEqual(budgetTypes, ['card', 'table']);
});

// ============================================================================
// ACCEPTANCE TEST 2: Signature Reassignment & Family Lineage Isolation
// ============================================================================
test('Acceptance 2: CFO signature attaches to v2 commentary, v1 superseded, families isolated', () => {
    const logRes = createChunks(SYNTHETIC_LOGISTICS_MULTI_PACK, { fileName: 'logistics_multi.pdf' });
    const v2Comm = logRes.chunks.find(c => c.metadata.version === 2 && c.chunk_type === 'commentary');
    const v1Chunks = logRes.chunks.filter(c => c.metadata.version === 1);
    const v2Card = logRes.chunks.find(c => c.metadata.version === 2 && c.chunk_type === 'card');
    const v1Card = logRes.chunks.find(c => c.metadata.version === 1 && c.chunk_type === 'card');

    // Signature ended up in v2 commentary
    assert.ok(v2Comm, 'v2 must have commentary');
    assert.match(v2Comm.content, /– Chief Financial Officer, Contoso Logistics LLC \(fictional\)/);

    // v1 has no commentary
    assert.equal(v1Chunks.some(c => c.chunk_type === 'commentary'), false);

    // Lineage linking
    assert.equal(v2Card.metadata.is_latest, true);
    assert.equal(v1Card.metadata.is_latest, false);
    assert.equal(v1Card.metadata.status, 'draft');
    assert.equal(v2Card.metadata.supersedes, v1Card.document_id);
    assert.equal(v1Card.metadata.superseded_by, v2Card.document_id);

    // Family isolation: Compare Q1 Audited vs Q2 Management pack vs Budget
    const auditRes = createChunks(SYNTHETIC_LOGISTICS_Q1_AUDITED, { fileName: 'logistics_q1_audited.pdf' });
    const budgetRes = createChunks(SYNTHETIC_LOGISTICS_BUDGET, { fileName: 'budget_fy2026.xlsx' });

    const q2Family = v2Card.document_family_id;
    const q1Family = auditRes.documents[0].documentFamilyId;
    const budgetFamily = budgetRes.documents[0].documentFamilyId;

    assert.notEqual(q2Family, q1Family, 'Q1 and Q2 must have different families');
    assert.notEqual(q2Family, budgetFamily, 'Budget and actual must have different families');
    assert.notEqual(q1Family, budgetFamily, 'Audited statements and budget must have different families');
});

// ============================================================================
// ACCEPTANCE TEST 3: Content Preservation & Number Formatting Fidelity
// ============================================================================
test('Acceptance 3: Exact numbers, Corporate tax (9%), and original digits preserved in content', () => {
    const logRes = createChunks(SYNTHETIC_LOGISTICS_MULTI_PACK, { fileName: 'logistics_v2.pdf' });
    const tableChunk = logRes.chunks.find(c => c.metadata.version === 2 && c.chunk_type === 'table');

    // Check exact brackets, commas, and percentage string
    assert.match(tableChunk.content, /Corporate tax \(9%\)/);
    assert.match(tableChunk.content, /\(6,591,800\)/);
    assert.match(tableChunk.content, /9,350,000/);
    assert.match(tableChunk.content, /1,046,955/);

    // Arabic digits preserved in content, converted only in search_text
    const arRes = createChunks(SYNTHETIC_ARABIC_PACK, { fileName: 'arabic_pack.pdf' });
    const arTable = arRes.chunks.find(c => c.chunk_type === 'table');

    assert.match(arTable.content, /٩٬٣٥٠٬٠٠٠/, 'Original Arabic-Indic digits must be preserved in content');
    assert.match(arTable.search_text, /9350000|9,350,000|9/, 'search_text must contain normalized ASCII digits');
    assert.doesNotMatch(arTable.search_text, /[\u0660-\u0669]/, 'search_text must not contain raw Arabic-Indic digits');
});

// ============================================================================
// ACCEPTANCE TEST 4: No Invented Defaults & Unaudited Precedence
// ============================================================================
test('Acceptance 4: Missing fields produce null + qa_flags, and unaudited takes precedence over audited', () => {
    // Document with missing currency, status, period
    const rawSparseDoc = `Contoso Mystery LLC\nSome random report\n| Col A | Col B |\n| --- | --- |\n| 1 | 2 |`;
    const sparseRes = createChunks(rawSparseDoc, { fileName: 'mystery.pdf' });
    const card = sparseRes.chunks.find(c => c.chunk_type === 'card');

    assert.equal(card.metadata.currency, null);
    assert.equal(card.metadata.status, null);
    assert.equal(card.metadata.period_label, null);
    assert.equal(card.metadata.audited, null);
    assert.ok(card.metadata.qa_flags.includes('missing_currency'));
    assert.ok(card.metadata.qa_flags.includes('missing_status'));
    assert.ok(card.metadata.qa_flags.includes('missing_period'));
    assert.ok(card.metadata.qa_flags.includes('missing_audit_status'));

    // Unaudited precedence
    const logRes = createChunks(SYNTHETIC_LOGISTICS_MULTI_PACK, { fileName: 'logistics.pdf' });
    const v2Card = logRes.chunks.find(c => c.metadata.version === 2 && c.chunk_type === 'card');
    assert.equal(v2Card.metadata.audited, false, "'unaudited' must be false, never true");

    // Arabic unaudited precedence
    const arRes = createChunks(SYNTHETIC_ARABIC_PACK, { fileName: 'arabic.pdf' });
    const arCard = arRes.chunks.find(c => c.chunk_type === 'card');
    assert.equal(arCard.metadata.audited, false, "'غير مدقق' must be false, never true");
});

// ============================================================================
// ACCEPTANCE TEST 5: Large Table Row-Group Splitting
// ============================================================================
test('Acceptance 5: 100-row table splits at row boundaries, headers repeated, under hard cap', () => {
    const largeDoc = generate100RowTableDocument();
    const res = createChunks(largeDoc, { fileName: 'fleet_ledger.pdf' });
    const tableChunks = res.chunks.filter(c => c.chunk_type === 'table');

    assert.ok(tableChunks.length > 1, '100-row table must split into multiple parts');
    assert.equal(tableChunks[0].metadata.table_part, 1);
    assert.equal(tableChunks[0].metadata.table_parts, tableChunks.length);

    // Each part must repeat the header row
    tableChunks.forEach((tc, idx) => {
        assert.match(tc.content, /\| Vehicle ID \| Category \| Make & Model \|/, `Part ${idx + 1} must repeat table headers`);
        assert.match(tc.title, new RegExp(`\\(Part ${idx + 1} of ${tableChunks.length}\\)`));
        assert.ok(tc.content.length < 9000, 'Chunk must stay well below hard token limit');
    });
});

// ============================================================================
// ACCEPTANCE TEST 6: Content Conservation & Empty Document Handling
// ============================================================================
test('Acceptance 6: Unknown section preserved as other, 0 dropped blocks, empty doc handled safely', () => {
    // 1. Unknown section
    const res = createChunks(SYNTHETIC_UNKNOWN_SECTION_DOC, { fileName: 'tech.pdf' });
    const otherChunk = res.chunks.find(c => c.chunk_type === 'other');
    assert.ok(otherChunk, 'Unclassified section must become other chunk');
    assert.ok(otherChunk.metadata.qa_flags.includes('unclassified'));
    assert.match(otherChunk.content, /Operational Telemetry Logs/);
    assert.equal(res.report.droppedBlocks, 0, 'Content conservation check must report 0 dropped blocks');

    // 2. Empty input
    const emptyRes = createChunks('', { fileName: 'empty.pdf' });
    assert.equal(emptyRes.length, 0);
    assert.equal(emptyRes.report.isValid, false);
    assert.ok(emptyRes.report.validationErrors.length > 0);
});

// ============================================================================
// ACCEPTANCE TEST 7: Determinism & Stale Chunk Deletion Diffing
// ============================================================================
test('Acceptance 7: Deterministic IDs and order; findStaleChunkIds computes stale deletions', () => {
    const run1 = createChunks(SYNTHETIC_RETAIL_Q2_PACK, { fileName: 'retail.pdf' });
    const run2 = createChunks(SYNTHETIC_RETAIL_Q2_PACK, { fileName: 'retail.pdf' });

    assert.equal(run1.chunks.length, run2.chunks.length);
    for (let i = 0; i < run1.chunks.length; i++) {
        assert.equal(run1.chunks[i].id, run2.chunks[i].id);
        assert.equal(run1.chunks[i].title, run2.chunks[i].title);
        assert.equal(run1.chunks[i].content, run2.chunks[i].content);
    }

    // Stale chunk deletion diffing
    const previousIndexedIds = ['doc_retail_card_0', 'doc_retail_table_1', 'doc_retail_commentary_2', 'doc_retail_other_3'];
    const currentProducedIds = ['doc_retail_card_0', 'doc_retail_table_1', 'doc_retail_commentary_2'];
    const staleIds = findStaleChunkIds(previousIndexedIds, currentProducedIds);
    assert.deepEqual(staleIds, ['doc_retail_other_3']);
});

// ============================================================================
// ACCEPTANCE TEST 8: Indexer Mapping & Vector Enforcement
// ============================================================================
test('Acceptance 8: buildSearchDocument flattens chunk metadata, enforces 1536-dim vector', () => {
    const res = createChunks(SYNTHETIC_RETAIL_Q2_PACK, { fileName: 'retail.pdf' });
    const tableChunk = res.chunks.find(c => c.chunk_type === 'table');

    const searchDoc = buildSearchDocument({
        chunk: tableChunk,
        contentVector: mockVector(),
        metadata: { fileName: 'retail.pdf' }
    });

    assert.equal(searchDoc.id, tableChunk.id);
    assert.equal(searchDoc.entity, 'Contoso Retail LLC');
    assert.equal(searchDoc.chunk_type, 'table');
    assert.equal(searchDoc.period_label, 'Q2 2026');
    assert.equal(searchDoc.currency, 'AED');
    assert.equal(searchDoc.is_latest, true);
    assert.equal(searchDoc.contentVector.length, 1536);

    // Invalid vector dimension rejects
    assert.throws(() => {
        buildSearchDocument({
            chunk: tableChunk,
            contentVector: [0.1, 0.2], // wrong dimension
            metadata: {}
        });
    }, /1536-dimension/);
});

// ============================================================================
// ACCEPTANCE TEST 9: Search Filter & Document Expansion Helpers
// ============================================================================
test('Acceptance 9: buildDefaultSearchFilter excludes superseded versions unless history requested', () => {
    // Default filter
    const defaultFilter = buildDefaultSearchFilter({ entity: 'Contoso Logistics LLC', period: 'Q2 2026' });
    assert.equal(defaultFilter, "(is_latest eq true or is_latest eq null) and entity eq 'Contoso Logistics LLC' and period_label eq 'Q2 2026'");

    // History mode: excludes is_latest restriction
    const historyFilter = buildDefaultSearchFilter({
        entity: 'Contoso Logistics LLC',
        period: 'Q2 2026',
        includeHistory: true
    });
    assert.equal(historyFilter, "entity eq 'Contoso Logistics LLC' and period_label eq 'Q2 2026'");
});
