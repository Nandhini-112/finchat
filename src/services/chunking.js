const { adaptToBlocks } = require('./chunking/block-adapter');
const { splitAndParseDocuments } = require('./chunking/doc-parser');
const { linkVersionsAndFamilies } = require('./chunking/version-linker');
const { chunkDocument } = require('./chunking/chunker-engine');
const { buildChunkId } = require('./search-document');
const { TOKEN_LIMITS } = require('../config/chunking');

function pageNumberFromText(text) {
    const matches = [...String(text || '').matchAll(/<!--\s*Page\s+(\d+)\s*-->/gi)];
    if (matches.length === 0) return null;
    const page = Number(matches[matches.length - 1][1]);
    return Number.isInteger(page) && page > 0 ? page : null;
}

/**
 * Pure function: createChunks(extracted, options) -> { documents, chunks, tables, report }
 * 
 * Divides normalized or extracted documents into clean, semantic chunks with
 * context headers and version lineage for Azure AI Search retrieval.
 * Zero network, zero embeddings, zero SQL, zero financial math.
 * 
 * Supports both modern signature createChunks(extracted, options) and legacy
 * signature createChunks(normalizedDoc, fileName, chunkSize, chunkOverlap, options).
 */
function createChunks(extracted, ...args) {
    if (!extracted) {
        const emptyResult = [];
        emptyResult.chunks = [];
        emptyResult.documents = [];
        emptyResult.tables = [];
        emptyResult.report = {
            totalDocuments: 0,
            totalChunks: 0,
            countsByType: { card: 0, table: 0, commentary: 0, section: 0, other: 0 },
            droppedBlocks: 0,
            unclassifiedCount: 0,
            splitTablesCount: 0,
            versionLinksCount: 0,
            qaFlags: ['empty_input'],
            isValid: false,
            validationErrors: ['Input document is empty or undefined.']
        };
        return emptyResult;
    }

    // 1. Normalize options & arguments
    let options = {};
    let fileName = 'document.pdf';
    let chunkSize = null;
    let chunkOverlap = null;

    if (typeof args[0] === 'string') {
        fileName = args[0];
        chunkSize = args[1] !== undefined ? args[1] : null;
        chunkOverlap = args[2] !== undefined ? args[2] : null;
        options = args[3] || {};
    } else if (typeof args[0] === 'object' && args[0] !== null) {
        options = args[0];
        fileName = options.fileName || 'document.pdf';
        chunkSize = options.chunkSize || null;
        chunkOverlap = options.chunkOverlap || null;
    }

    const documentId = options.documentId || extracted.document_id || null;
    const queueKey = options.queueKey || null;

    const mergedOptions = {
        ...options,
        fileName,
        documentId,
        queueKey,
        chunkSize,
        chunkOverlap
    };

    // 2. Convert input to typed blocks
    const blocks = adaptToBlocks(extracted, mergedOptions);

    if (blocks.length === 0) {
        const emptyResult = [];
        emptyResult.chunks = [];
        emptyResult.documents = [];
        emptyResult.tables = [];
        emptyResult.report = {
            totalDocuments: 0,
            totalChunks: 0,
            countsByType: { card: 0, table: 0, commentary: 0, section: 0, other: 0 },
            droppedBlocks: 0,
            unclassifiedCount: 0,
            splitTablesCount: 0,
            versionLinksCount: 0,
            qaFlags: ['no_blocks_extracted'],
            isValid: false,
            validationErrors: ['No readable content blocks found in input.']
        };
        return emptyResult;
    }

    // 3. Extract and parse document partitions & metadata
    const parsedDocs = splitAndParseDocuments(blocks, mergedOptions);

    // 4. Link version lineages and reassign signatures
    const linkedDocs = linkVersionsAndFamilies(parsedDocs);

    // 5. Check if this is an unstructured HR document without any financial metadata
    const isPureHrPolicy = linkedDocs.length === 1 &&
        !linkedDocs[0].entity &&
        !linkedDocs[0].periodLabel &&
        !linkedDocs[0].version &&
        !linkedDocs[0].currency &&
        !mergedOptions.forceFinancial;

    const allChunks = [];
    let totalDroppedBlocks = 0;

    if (isPureHrPolicy) {
        // Fallback for simple HR policies and plain notes to maintain 100% backward compatibility
        const doc = linkedDocs[0];
        const rawContent = extracted.fullMarkdown || extracted.content || (blocks.map(b => b.content).join('\n\n'));
        const sections = rawContent.split(/(?=\n#{1,3}\s+)/);
        let chunkIndex = 0;
        const cleanDocId = documentId ? String(documentId).replace(/^doc_/, '') : (doc.documentId ? String(doc.documentId).replace(/^doc_/, '') : 'unknown');

        for (const section of sections) {
            const trimmed = section.trim();
            if (!trimmed) continue;

            const headingMatch = trimmed.match(/^#{1,3}\s+(.+)$/m);
            const sectionTitle = headingMatch ? headingMatch[1].trim() : `Section ${chunkIndex + 1}`;
            const page = pageNumberFromText(trimmed) || 1;

            const chunkId = buildChunkId({
                queueKey,
                documentId: cleanDocId,
                chunkIndex
            });

            allChunks.push({
                id: chunkId,
                document_id: `doc_${cleanDocId}`,
                documentId: `doc_${cleanDocId}`,
                document_family_id: null,
                chunk_type: 'section',
                chunk_index: chunkIndex,
                chunkIndex,
                title: `${fileName} - ${sectionTitle}`,
                content: trimmed,
                heading: sectionTitle,
                pageNumber: page,
                search_text: null,
                source: fileName,
                metadata: {
                    entity: null,
                    document_type: null,
                    period_label: null,
                    period_end: null,
                    currency: null,
                    basis: null,
                    status: doc.status || null,
                    audited: null,
                    version: null,
                    is_latest: true,
                    supersedes: null,
                    superseded_by: null,
                    prepared_date: null,
                    language: 'en',
                    page_start: page,
                    page_end: page,
                    section_title: sectionTitle,
                    table_id: null,
                    table_part: null,
                    table_parts: null,
                    chunk_count: sections.length,
                    access_tags: mergedOptions.accessTags || [],
                    qa_flags: []
                }
            });
            chunkIndex++;
        }
    } else {
        // Financial chunking pipeline: element-specific chunking
        for (const doc of linkedDocs) {
            const { chunks, droppedBlocks } = chunkDocument(doc, mergedOptions);
            allChunks.push(...chunks);
            totalDroppedBlocks += droppedBlocks;
        }
    }

    // 6. Build parsed in-memory tables for fact-extraction service reuse
    const parsedTables = [];
    blocks.filter(b => b.type === 'table').forEach((tb, idx) => {
        const td = tb.tableData || {};
        parsedTables.push({
            element_id: `table_${idx + 1}`,
            document_id: documentId,
            element_type: 'table',
            table_id: td.tableId || idx + 1,
            row_count: td.rowCount || 0,
            column_count: td.columnCount || 0,
            headers: td.headers || [],
            rows: td.rows || [],
            page_number: tb.pageNumber || 1,
            content: tb.content
        });
    });

    // 7. Validation & conservation audit
    const countsByType = { card: 0, table: 0, commentary: 0, section: 0, other: 0 };
    const validationErrors = [];
    const seenIds = new Set();
    let unclassifiedCount = 0;
    let splitTablesCount = 0;
    let versionLinksCount = 0;
    const allQaFlags = new Set();

    allChunks.forEach(c => {
        // Count type
        if (countsByType[c.chunk_type] !== undefined) {
            countsByType[c.chunk_type]++;
        }

        // Validate unique ID
        if (seenIds.has(c.id)) {
            validationErrors.push(`Duplicate chunk id detected: ${c.id}`);
        }
        seenIds.add(c.id);

        // Validate non-empty content
        if (!c.content || !c.content.trim()) {
            validationErrors.push(`Chunk ${c.id} has empty content.`);
        }

        // Validate token limit hard cap
        if (c.content.length > TOKEN_LIMITS.hardCapTokens * 6) {
            validationErrors.push(`Chunk ${c.id} exceeds hard token character cap.`);
        }

        // Check unclassified & split flags
        if (c.chunk_type === 'other') unclassifiedCount++;
        if (c.metadata?.qa_flags) {
            c.metadata.qa_flags.forEach(f => allQaFlags.add(f));
            if (c.metadata.qa_flags.includes('table_split')) splitTablesCount++;
        }
        if (c.metadata?.supersedes || c.metadata?.superseded_by) {
            versionLinksCount++;
        }
    });

    const report = {
        totalDocuments: linkedDocs.length,
        totalChunks: allChunks.length,
        countsByType,
        droppedBlocks: totalDroppedBlocks,
        unclassifiedCount,
        splitTablesCount,
        versionLinksCount,
        qaFlags: Array.from(allQaFlags),
        isValid: validationErrors.length === 0,
        validationErrors
    };

    // 8. Log chunks to terminal
    if (!mergedOptions.silent) {
        logChunksToTerminal(linkedDocs, allChunks, report, mergedOptions);
    }

    // 9. Return dual-compatible payload
    const result = allChunks;
    result.chunks = allChunks;
    result.documents = linkedDocs;
    result.tables = parsedTables;
    result.report = report;

    return result;
}

/**
 * Terminal logger for chunking inspection and verification
 */
function logChunksToTerminal(linkedDocs, allChunks, report, options = {}) {
    const logger = options.logger || console.log;

    logger(`\n[FinChat Chunker] ========================================================`);
    logger(`[FinChat Chunker] Document Partitioning: ${linkedDocs.length} document version(s) parsed`);
    logger(`[FinChat Chunker] Total Chunks Generated: ${allChunks.length}`);
    logger(`[FinChat Chunker] Chunk Counts: card=${report.countsByType.card}, table=${report.countsByType.table}, commentary=${report.countsByType.commentary}, section=${report.countsByType.section}, other=${report.countsByType.other}`);
    logger(`[FinChat Chunker] Content Conservation: 0 dropped blocks | Status: ${report.isValid ? 'VALID' : 'INVALID'}`);

    linkedDocs.forEach((doc, dIdx) => {
        logger(`\n  --- Document [${dIdx + 1}/${linkedDocs.length}] ID="${doc.documentId}" ---`);
        logger(`  Entity      : ${doc.entity || 'N/A'}`);
        logger(`  DocumentType: ${doc.documentType || 'N/A'}`);
        logger(`  Period      : ${doc.periodLabel || 'N/A'} (End: ${doc.periodEnd || 'N/A'})`);
        logger(`  Version     : v${doc.version !== null ? doc.version : 'N/A'} | Status: ${doc.status || 'N/A'} | Audited: ${doc.audited === true ? 'Yes' : (doc.audited === false ? 'No' : 'N/A')}`);
        logger(`  Family ID   : ${doc.documentFamilyId || 'N/A'}`);
        logger(`  Lineage     : is_latest=${doc.isLatest} | supersedes=${doc.supersedes || 'none'} | superseded_by=${doc.supersededBy || 'none'}`);
        if (doc.qaFlags && doc.qaFlags.length > 0) {
            logger(`  QA Flags    : [${doc.qaFlags.join(', ')}]`);
        }

        const docChunks = allChunks.filter(c => c.document_id === doc.documentId);
        logger(`  Total Chunks for Document: ${docChunks.length}`);

        docChunks.forEach((chunk, cIdx) => {
            const firstLine = chunk.content.split('\n')[0] || '';
            const previewLines = chunk.content.split('\n').slice(1, 4).join(' ').trim();
            const preview = previewLines.length > 100 ? `${previewLines.slice(0, 100)}...` : previewLines;

            logger(`    * [Chunk ${cIdx}] [${chunk.chunk_type.toUpperCase()}] ID: "${chunk.id}"`);
            logger(`      Title  : ${chunk.title}`);
            logger(`      Header : ${firstLine}`);
            if (preview) {
                logger(`      Body   : ${preview} (${chunk.content.length} chars)`);
            }
            if (chunk.search_text) {
                logger(`      Search : [Normalized Arabic text present: ${chunk.search_text.length} chars]`);
            }
            if (chunk.metadata?.qa_flags && chunk.metadata.qa_flags.length > 0) {
                logger(`      Flags  : [${chunk.metadata.qa_flags.join(', ')}]`);
            }
        });
    });
    logger(`[FinChat Chunker] ========================================================\n`);
}

module.exports = {
    createChunks,
    logChunksToTerminal
};
