require('../utils/config');
const { validateDocumentBuffer } = require('../utils/validation');
const { ValidationError, sanitizeErrorMessage } = require('../utils/errors');
const { analyzeDocument } = require('./document-intelligence');
const { normalizeContent } = require('./content-normalizer');
const { extractFinancialFacts } = require('./fact-extraction');
const { createChunks } = require('./chunking');
const { generateBatchEmbeddings } = require('./embeddings');
const { uploadChunks, deleteReplacedChunks } = require('./azure-search');
const { buildSearchDocument, blankToNull } = require('./search-document');
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
 * Orchestrates the full 10-step enterprise ingestion pipeline with rich status-tracking telemetry.
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
    context = console,
    documentKey = null,
    queueKey = null,
    documentVersionId = null,
    fileLink = null,
    department = null,
    jobTitle = null,
    modifiedDate = null,
    authoritySource = null,
    existingRunId = null,
    manageRun = null,
    existingDocumentId = null
}) {
    const pipelineStartTime = Date.now();
    const corrId = correlationId || `ingest-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const log = (msg) => (context.log ? context.log(`[${corrId}] ${msg}`) : console.log(`[${corrId}] ${msg}`));
    const errorLog = (msg) => (context.error ? context.error(`[${corrId}] ${msg}`) : console.error(`[${corrId}] ${msg}`));

    const shouldManageRun = manageRun !== null ? Boolean(manageRun) : (existingRunId === null);
    let currentStep = 'INITIALIZATION';
    let runId = existingRunId || null;
    let documentId = existingDocumentId || null;
    let stepStartTime = Date.now();

    log(`[INGEST_STATUS: PIPELINE_START] File="${fileName}", Size=${fileBuffer ? (fileBuffer.length / 1024).toFixed(1) : 0} KB, AuthorityRank=${authorityRank}, SourceType="${sourceType}", UserGroups=${allowedUserGroups || 'Public'}`);

    try {
        // =========================================================================
        // STEP 1: VALIDATION & SCOPE ENFORCEMENT
        // =========================================================================
        currentStep = 'STEP 1: VALIDATION & SCOPE ENFORCEMENT';
        stepStartTime = Date.now();
        log(`=== ${currentStep} ===`);
        log(`[INGEST_STATUS: VALIDATING] Step 1/10: Validating document header signature, format scope, and size...`);

        await validateDocumentBuffer(fileBuffer, fileName);

        log(`[INGEST_STATUS: VALIDATED] Step 1/10: File "${fileName}" passed format validation (${(fileBuffer.length / 1024).toFixed(1)} KB, Rank ${authorityRank}) in ${Date.now() - stepStartTime}ms.`);

        // =========================================================================
        // STEP 2: INGESTION LIFECYCLE REGISTRATION (AZURE SQL)
        // =========================================================================
        currentStep = 'STEP 2: INGESTION LIFECYCLE REGISTRATION (AZURE SQL)';
        stepStartTime = Date.now();
        log(`=== ${currentStep} ===`);
        log(`[INGEST_STATUS: SQL_REGISTERING] Step 2/10: Registering ingestion run and document status in Azure SQL...`);

        if (shouldManageRun && !runId) {
            runId = await startIngestionRun(1);
        }
        if (!documentId) {
            documentId = await createDocument(fileName, sourceType, authorityRank, allowedUserGroups);
        }

        log(`[INGEST_STATUS: SQL_REGISTERED] Step 2/10: Registered dbo.IngestionRuns ID=${runId || 'Batch'}, dbo.Documents ID=${documentId} (Status: 'Processing') in ${Date.now() - stepStartTime}ms.`);

        // =========================================================================
        // STEP 3: DOCUMENT EXTRACTION (PDF / EXCEL EXTRACTOR)
        // =========================================================================
        currentStep = 'STEP 3: DOCUMENT EXTRACTION (PDF / EXCEL)';
        stepStartTime = Date.now();
        log(`=== ${currentStep} ===`);
        log(`[INGEST_STATUS: EXTRACTING] Step 3/10: Extracting text, paragraphs, and table layouts...`);

        const docIntelResult = await analyzeDocument(fileBuffer, fileName);
        const extractedPages = docIntelResult.pages || [];
        const extractedTables = docIntelResult.tables || [];
        const rawContentLen = (docIntelResult.content || '').length;

        log(`[INGEST_STATUS: EXTRACTED] Step 3/10: Extracted ${extractedPages.length} page(s), ${extractedTables.length} table(s), ${rawContentLen} raw characters in ${Date.now() - stepStartTime}ms.`);

        // =========================================================================
        // STEP 4: CONTENT NORMALIZATION
        // =========================================================================
        currentStep = 'STEP 4: CONTENT NORMALIZATION';
        stepStartTime = Date.now();
        log(`=== ${currentStep} ===`);
        log(`[INGEST_STATUS: NORMALIZING] Step 4/10: Normalizing cell layout grids, multi-period headers, and markdown...`);

        const normalized = normalizeContent(docIntelResult, documentId);
        const normMarkdownLen = (normalized.fullMarkdown || normalized.content || '').length;

        log(`[INGEST_STATUS: NORMALIZED] Step 4/10: Normalized ${normalized.tables.length} table(s), ${normalized.paragraphs.length} paragraph(s) (${normMarkdownLen} markdown chars) in ${Date.now() - stepStartTime}ms.`);

        // =========================================================================
        // STEP 5: STRUCTURED FACT EXTRACTION (IFRS & HR FIGURES)
        // =========================================================================
        currentStep = 'STEP 5: STRUCTURED FACT EXTRACTION';
        stepStartTime = Date.now();
        log(`=== ${currentStep} ===`);
        log(`[INGEST_STATUS: FACT_EXTRACTING] Step 5/10: Mapping normalized financial rows to canonical facts and unit metrics...`);

        const extractedFacts = extractFinancialFacts(normalized);
        log(`[INGEST_STATUS: FACT_EXTRACTED] Step 5/10: Extracted ${extractedFacts.length} structured fact(s) in ${Date.now() - stepStartTime}ms.`);

        if (extractedFacts.length > 0) {
            const sampleLimit = Math.min(extractedFacts.length, 4);
            log(`Step 5 Fact Samples (First ${sampleLimit}):`);
            for (let i = 0; i < sampleLimit; i++) {
                const f = extractedFacts[i];
                log(`  [Fact ${i + 1}] Metric="${f.metric}" (Canonical="${f.canonicalMetric || 'Unmapped'}"), Period="${f.periodLabel}", Val=${f.numericValue ?? f.textValue} ${f.currency || f.unit || ''}, Status=${f.validationStatus || 'Pending'}`);
            }
        } else {
            log('Step 5 Notice: No structured financial metrics discovered in document text/tables.');
        }

        // =========================================================================
        // STEP 6: FACT PERSISTENCE & CONFLICT AUDITING (AZURE SQL)
        // =========================================================================
        currentStep = 'STEP 6: FACT PERSISTENCE & CONFLICT AUDITING';
        stepStartTime = Date.now();
        log(`=== ${currentStep} ===`);
        log(`[INGEST_STATUS: PERSISTING] Step 6/10: Persisting structured facts into dbo.FinancialFacts and auditing conflicts...`);

        let conflicts = [];
        if (extractedFacts.length > 0) {
            const insertedCount = await insertFinancialFacts(documentId, extractedFacts, authorityRank, fileName);
            log(`[INGEST_STATUS: FACTS_STORED] Step 6/10: Persisted ${insertedCount.length || extractedFacts.length} row(s) to dbo.FinancialFacts for DocumentId=${documentId}.`);

            conflicts = await detectAndResolveConflicts(documentId);
            log(`[INGEST_STATUS: CONFLICTS_EVALUATED] Step 6/10: Audited conflicts across corpus; found ${conflicts.length} active conflict(s) in ${Date.now() - stepStartTime}ms.`);
            if (conflicts.length > 0) {
                for (const c of conflicts) {
                    log(`  - Conflict on "${c.fact1?.Metric}": Status="${c.status}" (${c.fact1?.SourceFileName}: ${c.fact1?.NumericValue} vs ${c.fact2?.SourceFileName}: ${c.fact2?.NumericValue})`);
                }
            }
        } else {
            log('Step 6 Output: Skipped SQL fact insertion (0 facts extracted).');
        }

        // =========================================================================
        // STEP 7: RETRIEVAL CHUNKING
        // =========================================================================
        currentStep = 'STEP 7: RETRIEVAL CHUNKING';
        stepStartTime = Date.now();
        log(`=== ${currentStep} ===`);
        log(`[INGEST_STATUS: CHUNKING] Step 7/10: Partitioning normalized content into semantically coherent retrieval chunks...`);

        const chunks = createChunks(normalized, fileName, null, null, { queueKey, logger: log });
        log(`[INGEST_STATUS: CHUNKED] Step 7/10: Produced ${chunks.length} retrieval chunk(s) in ${Date.now() - stepStartTime}ms.`);
        if (chunks.length > 0) {
            chunks.forEach((c, idx) => {
                const header = c.content.split('\n')[0] || '';
                log(`  - Chunk ${idx} [${(c.chunk_type || 'section').toUpperCase()}]: ID="${c.id}", Title="${c.title}", Length=${c.content.length} chars, Page=${c.pageNumber || c.metadata?.page_start || 1}`);
            });
        }

        // =========================================================================
        // STEP 8 & 9: MULTILINGUAL EMBEDDINGS & AZURE AI SEARCH INDEXING
        // =========================================================================
        currentStep = 'STEP 8 & 9: MULTILINGUAL EMBEDDINGS & AZURE AI SEARCH';
        stepStartTime = Date.now();
        log(`=== ${currentStep} ===`);

        if (chunks.length > 0) {
            log(`[INGEST_STATUS: EMBEDDING] Step 8/10: Generating dense 1536-dim vector embeddings via text-embedding-3-small...`);
            const chunkTexts = chunks.map(c => `${c.title}\n${c.content}`);
            const embeddings = await generateBatchEmbeddings(chunkTexts);
            const vectorDimensions = embeddings[0] ? embeddings[0].length : 0;

            log(`[INGEST_STATUS: EMBEDDED] Step 8/10: Produced ${embeddings.length} vector embedding(s) (${vectorDimensions} dims) in ${Date.now() - stepStartTime}ms.`);

            stepStartTime = Date.now();
            const searchIndex = process.env.AZURE_SEARCH_INDEX || 'finance-hr-documents';
            log(`[INGEST_STATUS: SEARCH_INDEXING] Step 9/10: Indexing hybrid vector chunks into Azure AI Search index "${searchIndex}"...`);

            const searchMetadata = {
                documentId,
                documentVersionId: blankToNull(documentVersionId),
                documentKey: blankToNull(documentKey),
                queueKey: blankToNull(queueKey),
                fileName,
                fileLink: blankToNull(fileLink),
                department: blankToNull(department),
                jobTitle: blankToNull(jobTitle),
                authorityRank,
                authoritySource: blankToNull(authoritySource),
                modifiedDate: blankToNull(modifiedDate)
            };
            const searchDocuments = chunks.map((chunk, idx) => buildSearchDocument({
                chunk,
                contentVector: embeddings[idx],
                metadata: searchMetadata
            }));

            await uploadChunks(searchDocuments);
            const deleted = await deleteReplacedChunks(
                searchMetadata.documentKey,
                searchDocuments.map(document => document.id)
            );
            log(`[INGEST_STATUS: SEARCH_INDEXED] Step 9/10: Uploaded ${searchDocuments.length} chunk(s) to index "${searchIndex}". Deleted superseded chunks: ${deleted} in ${Date.now() - stepStartTime}ms.`);
        } else {
            log('Step 8 & 9 Output: Skipped search indexing (0 chunks).');
        }

        // =========================================================================
        // STEP 10: INGESTION COMPLETION & FINAL STATUS UPDATE
        // =========================================================================
        currentStep = 'STEP 10: INGESTION COMPLETION';
        stepStartTime = Date.now();
        log(`=== ${currentStep} ===`);
        log(`[INGEST_STATUS: FINALIZING] Step 10/10: Transitioning document status to 'Succeeded' in dbo.Documents...`);

        await updateDocumentStatus(documentId, 'Succeeded');
        if (shouldManageRun && runId) {
            await completeIngestionRun(runId, 1, 0, 'Succeeded');
            log(`Step 10 Output: Ingestion finalized as Succeeded for DocumentId=${documentId}, RunId=${runId}.`);
        } else {
            log(`Step 10 Output: Ingestion finalized as Succeeded for DocumentId=${documentId} (Batch RunId=${runId || 'N/A'}).`);
        }

        const totalElapsedMs = Date.now() - pipelineStartTime;
        log(`[INGEST_STATUS: SUCCEEDED] >>> INGESTION FINISHED SUCCESSFULLY <<< DocumentId=${documentId}, Facts=${extractedFacts.length}, Chunks=${chunks.length}, TotalDuration=${totalElapsedMs}ms.`);

        return {
            status: 'success',
            documentId,
            runId,
            fileName,
            authorityRank,
            factsExtracted: extractedFacts.length,
            chunksIndexed: chunks.length,
            conflictsProcessed: conflicts.length,
            durationMs: totalElapsedMs,
            correlationId: corrId
        };

    } catch (err) {
        const totalElapsedMs = Date.now() - pipelineStartTime;
        errorLog(`[INGEST_STATUS: FAILED] !!! INGESTION FAILED AT [${currentStep}] !!! TotalElapsed=${totalElapsedMs}ms`);
        errorLog(`Error Name: ${err.name || 'Error'}`);
        errorLog(`Error Message: ${err.message}`);
        if (err.stack) {
            errorLog(`Error Stack Trace: ${err.stack}`);
        }

        if (documentId) {
            errorLog(`[INGEST_STATUS: ROLLBACK] Rolling back partial facts and setting DocumentId=${documentId} status to 'Failed'...`);
            await deleteDocumentFacts(documentId).catch(e => {
                errorLog(`Failed to delete partial facts: ${e.message}`);
            });
            await updateDocumentStatus(documentId, 'Failed').catch(e => {
                errorLog(`Failed to update document status to Failed: ${e.message}`);
            });
            errorLog(`[INGEST_STATUS: ROLLBACK_COMPLETE] DocumentId=${documentId} marked as 'Failed' in dbo.Documents.`);
        }

        if (shouldManageRun && runId) {
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
