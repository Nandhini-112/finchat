require('../utils/config');
const { validateDocumentBuffer } = require('../utils/validation');
const { ValidationError, sanitizeErrorMessage } = require('../utils/errors');
const { analyzeDocument } = require('./document-intelligence');
const { normalizeContent } = require('./content-normalizer');
const { extractFinancialFacts } = require('./fact-extraction');
const { createChunks } = require('./chunking');
const { generateBatchEmbeddings } = require('./embeddings');
const { uploadChunks } = require('./azure-search');
const {
    startIngestionRun,
    completeIngestionRun,
    createDocument,
    updateDocumentStatus,
    insertFinancialFacts,
    deleteDocumentFacts
} = require('./sql');
const { detectAndResolveConflicts } = require('./conflict-resolver');

/**
 * Orchestrates the full 10-step enterprise ingestion pipeline.
 * Used by both HTTP ingestion endpoint (ingestDocument) and 
 * scheduled SharePoint queue processor (processDocumentQueue).
 * 
 * Guarantees:
 * 1. Scope enforcement (PDF & Excel IFRS/HR reports only; Word, CSV, images excluded)
 * 2. Status tracking per file in Azure SQL (dbo.Documents, dbo.IngestionRuns)
 * 3. Structured fact extraction into dbo.FinancialFacts (metric, entity, period, value, unit, source, location, as-of date)
 * 4. Conflict detection across documents with authority ranks & equal-rank review flags
 * 5. Multilingual 1536-dim vector embeddings & hybrid search indexing in Azure AI Search
 * 6. Exclusion of failed files: on error, status is marked 'Failed' and partial facts are rolled back.
 */
async function processDocumentIngestion({
    fileBuffer,
    fileName,
    sourceType = 'ManualUpload',
    authorityRank = 4,
    allowedUserGroups = null,
    correlationId = null,
    context = console
}) {
    const corrId = correlationId || `ingest-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const log = (msg) => (context.log ? context.log(`[${corrId}] ${msg}`) : console.log(`[${corrId}] ${msg}`));
    const errorLog = (msg) => (context.error ? context.error(`[${corrId}] ${msg}`) : console.error(`[${corrId}] ${msg}`));

    let currentStep = 'INITIALIZATION';
    let runId = null;
    let documentId = null;

    try {
        // STEP 1: VALIDATION & SCOPE ENFORCEMENT
        currentStep = 'STEP 1: VALIDATION & SCOPE ENFORCEMENT';
        log(`=== ${currentStep} ===`);

        validateDocumentBuffer(fileBuffer, fileName);

        log(`Step 1 Output: File "${fileName}" validated successfully (${(fileBuffer.length / 1024).toFixed(1)} KB, Rank ${authorityRank}).`);

        // STEP 2: INGESTION LIFECYCLE REGISTRATION (AZURE SQL)
        currentStep = 'STEP 2: INGESTION LIFECYCLE REGISTRATION (AZURE SQL)';
        log(`=== ${currentStep} ===`);

        runId = await startIngestionRun(1);
        documentId = await createDocument(fileName, sourceType, authorityRank, allowedUserGroups);

        log(`Step 2 Output: dbo.IngestionRuns ID=${runId}, dbo.Documents ID=${documentId} (Status: Processing).`);

        // STEP 3: DOCUMENT EXTRACTION (PDF / EXCEL EXTRACTOR)
        currentStep = 'STEP 3: DOCUMENT EXTRACTION (PDF / EXCEL)';
        log(`=== ${currentStep} ===`);

        const docIntelResult = await analyzeDocument(fileBuffer, fileName);
        const extractedPages = docIntelResult.pages || [];
        const extractedTables = docIntelResult.tables || [];
        const rawContentLen = (docIntelResult.content || '').length;

        log(`Step 3 Output: Extracted ${extractedPages.length} page(s), ${extractedTables.length} table(s), ${rawContentLen} chars text.`);

        // STEP 4: CONTENT NORMALIZATION
        currentStep = 'STEP 4: CONTENT NORMALIZATION';
        log(`=== ${currentStep} ===`);

        const normalized = normalizeContent(docIntelResult, documentId);
        const normMarkdownLen = (normalized.fullMarkdown || normalized.content || '').length;

        log(`Step 4 Output: Normalized ${normalized.tables.length} table(s), ${normalized.paragraphs.length} paragraph(s) (${normMarkdownLen} chars).`);

        // STEP 5: STRUCTURED FACT EXTRACTION (IFRS & HR FIGURES)
        currentStep = 'STEP 5: STRUCTURED FACT EXTRACTION';
        log(`=== ${currentStep} ===`);

        const extractedFacts = extractFinancialFacts(normalized);
        log(`Step 5 Output: Extracted ${extractedFacts.length} structured fact(s).`);

        // STEP 6: FACT PERSISTENCE & CONFLICT AUDITING (AZURE SQL)
        currentStep = 'STEP 6: FACT PERSISTENCE & CONFLICT AUDITING';
        log(`=== ${currentStep} ===`);

        let conflicts = [];
        if (extractedFacts.length > 0) {
            const insertedCount = await insertFinancialFacts(documentId, extractedFacts, authorityRank, fileName);
            log(`Step 6 Output: Inserted ${insertedCount.length || extractedFacts.length} row(s) into dbo.FinancialFacts.`);

            conflicts = await detectAndResolveConflicts(documentId);
            log(`Step 6 Output: Discovered & registered ${conflicts.length} conflict(s) in dbo.FactConflicts.`);
        } else {
            log('Step 6 Output: No structured facts extracted to insert.');
        }

        // STEP 7: RETRIEVAL CHUNKING
        currentStep = 'STEP 7: RETRIEVAL CHUNKING';
        log(`=== ${currentStep} ===`);

        const chunks = createChunks(normalized, fileName);
        log(`Step 7 Output: Produced ${chunks.length} retrieval chunk(s).`);

        // STEP 8 & 9: MULTILINGUAL EMBEDDINGS & AZURE AI SEARCH INDEXING
        currentStep = 'STEP 8 & 9: MULTILINGUAL EMBEDDINGS & AZURE AI SEARCH';
        log(`=== ${currentStep} ===`);

        if (chunks.length > 0) {
            const chunkTexts = chunks.map(c => `${c.title}\n${c.content}`);
            const embeddings = await generateBatchEmbeddings(chunkTexts);

            const searchIndex = process.env.AZURE_SEARCH_INDEX || 'finance-hr-documents';
            const searchDocuments = chunks.map((chunk, idx) => ({
                id: chunk.id,
                title: chunk.title,
                content: chunk.content,
                source: chunk.source,
                contentVector: embeddings[idx]
            }));

            await uploadChunks(searchDocuments);
            log(`Step 8 & 9 Output: Uploaded ${searchDocuments.length} hybrid vector chunk(s) to search index "${searchIndex}".`);
        } else {
            log('Step 8 & 9 Output: Skipped search indexing (0 chunks).');
        }

        // STEP 10: INGESTION COMPLETION & FINAL STATUS UPDATE
        currentStep = 'STEP 10: INGESTION COMPLETION';
        log(`=== ${currentStep} ===`);

        await updateDocumentStatus(documentId, 'Succeeded');
        await completeIngestionRun(runId, 1, 0, 'Succeeded');

        log(`Step 10 Output: Ingestion finalized as Succeeded for DocumentId=${documentId}, RunId=${runId}.`);

        return {
            status: 'success',
            documentId,
            runId,
            fileName,
            authorityRank,
            factsExtracted: extractedFacts.length,
            chunksIndexed: chunks.length,
            conflictsProcessed: conflicts.length,
            correlationId: corrId
        };

    } catch (err) {
        errorLog(`!!! INGESTION FAILED AT [${currentStep}]: ${err.message} !!!`);

        if (documentId) {
            errorLog(`Rolling back partial facts and setting DocumentId=${documentId} status to 'Failed'...`);
            await deleteDocumentFacts(documentId).catch(e => {
                errorLog(`Failed to delete partial facts: ${e.message}`);
            });
            await updateDocumentStatus(documentId, 'Failed').catch(e => {
                errorLog(`Failed to update document status to Failed: ${e.message}`);
            });
        }

        if (runId) {
            await completeIngestionRun(runId, 0, 1, 'Failed', sanitizeErrorMessage(err)).catch(e => {
                errorLog(`Failed to update ingestion run to Failed: ${e.message}`);
            });
        }

        throw err;
    }
}

module.exports = {
    processDocumentIngestion
};
