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
    manageRun = null
}) {
    const corrId = correlationId || `ingest-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const log = (msg) => (context.log ? context.log(`[${corrId}] ${msg}`) : console.log(`[${corrId}] ${msg}`));
    const errorLog = (msg) => (context.error ? context.error(`[${corrId}] ${msg}`) : console.error(`[${corrId}] ${msg}`));

    const shouldManageRun = manageRun !== null ? Boolean(manageRun) : (existingRunId === null);
    let currentStep = 'INITIALIZATION';
    let runId = existingRunId || null;
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

        if (shouldManageRun) {
            runId = await startIngestionRun(1);
        }
        documentId = await createDocument(fileName, sourceType, authorityRank, allowedUserGroups);

        log(`Step 2 Output: dbo.IngestionRuns ID=${runId || 'N/A'}, dbo.Documents ID=${documentId} (Status: Processing).`);

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
        log(`Step 5 Output (Extracted Facts Count): ${extractedFacts.length}`);
        if (extractedFacts.length > 0) {
            const sampleLimit = Math.min(extractedFacts.length, 4);
            log(`Step 5 Fact Samples (First ${sampleLimit}):`);
            for (let i = 0; i < sampleLimit; i++) {
                const f = extractedFacts[i];
                log(`  [Fact ${i + 1}] Metric="${f.metric}", Entity="${f.entity || 'N/A'}", Value=${f.numericValue ?? f.textValue} ${f.currency || f.unit || ''}, Location="${f.sourceLocation || 'N/A'}"`);
            }
        } else {
            log('Step 5 Notice: No structured financial metrics discovered in document text/tables.');
        }

        // STEP 6: FACT PERSISTENCE & CONFLICT AUDITING (AZURE SQL)
        currentStep = 'STEP 6: FACT PERSISTENCE & CONFLICT AUDITING';
        log(`=== ${currentStep} ===`);

        let conflicts = [];
        if (extractedFacts.length > 0) {
            const insertedCount = await insertFinancialFacts(documentId, extractedFacts, authorityRank, fileName);
            log(`Step 6 Output (dbo.FinancialFacts): Inserted ${insertedCount.length || extractedFacts.length} row(s).`);

            conflicts = await detectAndResolveConflicts(documentId);
            log(`Step 6 Output (dbo.FactConflicts): Discovered & registered ${conflicts.length} conflict(s).`);
            if (conflicts.length > 0) {
                for (const c of conflicts) {
                    log(`  - Discrepancy on "${c.fact1?.Metric}": ${c.status} (${c.fact1?.SourceFileName}: ${c.fact1?.NumericValue} vs ${c.fact2?.SourceFileName}: ${c.fact2?.NumericValue})`);
                }
            }
        } else {
            log('Step 6 Output: Skipped SQL fact insertion (0 facts extracted).');
        }

        // STEP 7: RETRIEVAL CHUNKING
        currentStep = 'STEP 7: RETRIEVAL CHUNKING';
        log(`=== ${currentStep} ===`);

        const chunks = createChunks(normalized, fileName, null, null, { queueKey });
        log(`Step 7 Output (Created Chunks): ${chunks.length} retrieval chunk(s).`);
        if (chunks.length > 0) {
            log(`  - Chunk 0: ID="${chunks[0].id}", Title="${chunks[0].title}", Length=${chunks[0].content.length} chars`);
            if (chunks.length > 1) {
                const lastIdx = chunks.length - 1;
                log(`  - Chunk ${lastIdx}: ID="${chunks[lastIdx].id}", Title="${chunks[lastIdx].title}", Length=${chunks[lastIdx].content.length} chars`);
            }
        }

        // STEP 8 & 9: MULTILINGUAL EMBEDDINGS & AZURE AI SEARCH INDEXING
        currentStep = 'STEP 8 & 9: MULTILINGUAL EMBEDDINGS & AZURE AI SEARCH';
        log(`=== ${currentStep} ===`);

        if (chunks.length > 0) {
            const chunkTexts = chunks.map(c => `${c.title}\n${c.content}`);
            const embeddings = await generateBatchEmbeddings(chunkTexts);
            const vectorDimensions = embeddings[0] ? embeddings[0].length : 0;

            log(`Step 8 Output (Embeddings): Produced ${embeddings.length} vector(s) of ${vectorDimensions} dimensions.`);

            const searchIndex = process.env.AZURE_SEARCH_INDEX || 'finance-hr-documents';
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
            log(`Step 9 Output (Azure AI Search): Uploaded ${searchDocuments.length} hybrid vector chunk(s) to index "${searchIndex}". Deleted replaced chunks: ${deleted}.`);
        } else {
            log('Step 8 & 9 Output: Skipped search indexing (0 chunks).');
        }

        // STEP 10: INGESTION COMPLETION & FINAL STATUS UPDATE
        currentStep = 'STEP 10: INGESTION COMPLETION';
        log(`=== ${currentStep} ===`);

        await updateDocumentStatus(documentId, 'Succeeded');
        if (shouldManageRun && runId) {
            await completeIngestionRun(runId, 1, 0, 'Succeeded');
            log(`Step 10 Output: Ingestion finalized as Succeeded for DocumentId=${documentId}, RunId=${runId}.`);
        } else {
            log(`Step 10 Output: Ingestion finalized as Succeeded for DocumentId=${documentId} (Batch RunId=${runId || 'N/A'}).`);
        }
        log(`>>> INGESTION FINISHED SUCCESSFULLY <<< DocumentId=${documentId}, Facts=${extractedFacts.length}, Chunks=${chunks.length}`);

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
        errorLog(`!!! INGESTION FAILED AT [${currentStep}] !!!`);
        errorLog(`Error Name: ${err.name || 'Error'}`);
        errorLog(`Error Message: ${err.message}`);
        if (err.stack) {
            errorLog(`Error Stack Trace: ${err.stack}`);
        }

        if (documentId) {
            errorLog(`Rolling back partial facts and setting DocumentId=${documentId} status to 'Failed'...`);
            await deleteDocumentFacts(documentId).catch(e => {
                errorLog(`Failed to delete partial facts: ${e.message}`);
            });
            await updateDocumentStatus(documentId, 'Failed').catch(e => {
                errorLog(`Failed to update document status to Failed: ${e.message}`);
            });
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
