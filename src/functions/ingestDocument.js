const { app } = require('@azure/functions');
const { validateDocumentBuffer } = require('../utils/validation');
const { ValidationError, toErrorResponse, sanitizeErrorMessage } = require('../utils/errors');
const { analyzeDocument } = require('../services/document-intelligence');
const { normalizeContent } = require('../services/content-normalizer');
const { extractFinancialFacts } = require('../services/fact-extraction');
const { createChunks } = require('../services/chunking');
const { generateBatchEmbeddings } = require('../services/embeddings');
const { uploadChunks } = require('../services/azure-search');
const {
    startIngestionRun,
    completeIngestionRun,
    createDocument,
    updateDocumentStatus,
    insertFinancialFacts,
    deleteDocumentFacts
} = require('../services/sql');
const { detectAndResolveConflicts } = require('../services/conflict-resolver');

app.http('ingestDocument', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const correlationId = `ingest-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        context.log(`[${correlationId}] >>> START INGESTION REQUEST <<< Method=POST, URL=${request.url}`);

        let currentStep = 'INITIALIZATION';
        let runId = null;
        let documentId = null;

        try {
            // STEP 1: VALIDATION & INPUT EXTRACTION
            currentStep = 'STEP 1: VALIDATION & INPUT EXTRACTION';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            const contentType = (request.headers.get('content-type') || '').toLowerCase();
            let fileBuffer;

            // 1. Extract filename from query string (case-insensitive)
            let fileName = null;
            if (request.query) {
                for (const [key, val] of request.query.entries()) {
                    if (/^(filename|name|file|title)$/i.test(key) && val) {
                        fileName = decodeURIComponent(val).trim();
                        break;
                    }
                }
            }

            // 2. Check headers (x-filename, x-file-name, content-disposition)
            if (!fileName) {
                const xFn = request.headers.get('x-filename') || request.headers.get('x-file-name');
                if (xFn) fileName = decodeURIComponent(xFn).trim();
            }

            if (!fileName) {
                const disp = request.headers.get('content-disposition') || '';
                const match = disp.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i);
                if (match && match[1]) fileName = decodeURIComponent(match[1]).trim();
            }

            let allowedUserGroups = request.query.get('allowedUserGroups') || request.headers.get('x-user-groups') || null;
            let authorityRank = Number(request.query.get('authorityRank') || request.headers.get('x-authority-rank') || 4);
            let sourceType = request.query.get('sourceType') || request.headers.get('x-source-type') || 'ManualUpload';

            if (contentType.includes('text/plain') || contentType.includes('text/markdown') || contentType.includes('text/csv')) {
                const textContent = await request.text();
                fileBuffer = Buffer.from(textContent, 'utf8');
                fileName = fileName || `report_${Date.now()}.${contentType.includes('csv') ? 'csv' : 'txt'}`;
            } else if (contentType.includes('application/pdf') ||
                contentType.includes('application/octet-stream') ||
                contentType.includes('spreadsheetml') ||
                contentType.includes('ms-excel')) {
                const arrayBuffer = await request.arrayBuffer();
                fileBuffer = Buffer.from(arrayBuffer);
            } else if (contentType.includes('multipart/form-data')) {
                const formData = await request.formData();
                const file = formData.get('file') || formData.get('document');
                if (file && typeof file.arrayBuffer === 'function') {
                    const arrayBuffer = await file.arrayBuffer();
                    fileBuffer = Buffer.from(arrayBuffer);
                    fileName = fileName || file.name;
                } else {
                    throw new ValidationError('form-data request must include a "file" or "document" field with an uploaded file.');
                }
                if (formData.get('fileName')) fileName = formData.get('fileName');
                if (formData.get('allowedUserGroups')) allowedUserGroups = formData.get('allowedUserGroups');
                if (formData.get('authorityRank')) authorityRank = Number(formData.get('authorityRank'));
                if (formData.get('sourceType')) sourceType = formData.get('sourceType');
            } else if (contentType.includes('application/json')) {
                const jsonBody = await request.json().catch(() => null);
                if (!jsonBody) throw new ValidationError('JSON body is malformed or empty.');

                fileName = fileName || jsonBody.fileName || jsonBody.filename;
                allowedUserGroups = allowedUserGroups || jsonBody.allowedUserGroups || null;
                if (jsonBody.authorityRank) authorityRank = Number(jsonBody.authorityRank);
                if (jsonBody.sourceType) sourceType = jsonBody.sourceType;

                if (jsonBody.text || jsonBody.content) {
                    fileBuffer = Buffer.from(jsonBody.text || jsonBody.content, 'utf8');
                    fileName = fileName || `report_${Date.now()}.txt`;
                } else if (jsonBody.base64) {
                    fileBuffer = Buffer.from(jsonBody.base64, 'base64');
                } else {
                    throw new ValidationError('JSON request must include "text", "content", or "base64".');
                }
            } else {
                throw new ValidationError(`Unsupported Content-Type: "${contentType}". Finora AI accepts form-data, PDF/Binary, CSV, Excel (.xlsx/.xls), Text, or JSON.`);
            }

            // Auto-detect format and append extension if missing
            const isPdf = fileBuffer && fileBuffer.length >= 4 && fileBuffer.toString('utf8', 0, 4) === '%PDF';
            const isZipOrExcel = fileBuffer && fileBuffer.length >= 4 && fileBuffer.toString('hex', 0, 4) === '504b0304';

            if (fileName) {
                if (!fileName.includes('.')) {
                    if (isPdf) fileName += '.pdf';
                    else if (isZipOrExcel) fileName += '.xlsx';
                    else if (contentType.includes('csv')) fileName += '.csv';
                    else fileName += '.txt';
                }
            } else {
                const timestamp = Date.now();
                if (isPdf) fileName = `document_${timestamp}.pdf`;
                else if (isZipOrExcel) fileName = `spreadsheet_${timestamp}.xlsx`;
                else if (contentType.includes('csv')) fileName = `data_${timestamp}.csv`;
                else fileName = `document_${timestamp}.txt`;
            }

            validateDocumentBuffer(fileBuffer, fileName);

            context.log(`[${correlationId}] Step 1 Output: Buffer validated successfully.`);
            context.log(`[${correlationId}]   - Resolved FileName: "${fileName}"`);
            context.log(`[${correlationId}]   - File Size: ${fileBuffer.length} bytes (${(fileBuffer.length / 1024).toFixed(1)} KB)`);
            context.log(`[${correlationId}]   - Authority Rank: ${authorityRank}`);
            context.log(`[${correlationId}]   - Source Type: "${sourceType}"`);
            context.log(`[${correlationId}]   - Content-Type: "${contentType}"`);

            // STEP 2: INGESTION LIFECYCLE REGISTRATION (AZURE SQL)
            currentStep = 'STEP 2: INGESTION LIFECYCLE REGISTRATION (AZURE SQL)';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            runId = await startIngestionRun(1);
            documentId = await createDocument(fileName, sourceType, authorityRank, allowedUserGroups);

            context.log(`[${correlationId}] Step 2 Output (Database Registered):`);
            context.log(`[${correlationId}]   - Ingestion Run ID (dbo.IngestionRuns): ${runId}`);
            context.log(`[${correlationId}]   - Document ID (dbo.Documents): ${documentId}`);
            context.log(`[${correlationId}]   - Initial Status: "Processing"`);

            // STEP 3: DOCUMENT EXTRACTION (LOCAL EXTRACTOR)
            currentStep = 'STEP 3: DOCUMENT EXTRACTION (LOCAL EXTRACTOR)';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            const docIntelResult = await analyzeDocument(fileBuffer, fileName);
            const extractedPages = docIntelResult.pages || [];
            const extractedTables = docIntelResult.tables || [];
            const extractedParagraphs = docIntelResult.paragraphs || [];
            const rawContentLen = (docIntelResult.content || '').length;

            context.log(`[${correlationId}] Step 3 Output (Extraction Results):`);
            context.log(`[${correlationId}]   - Total Pages Extracted: ${extractedPages.length}`);
            context.log(`[${correlationId}]   - Total Tables Extracted: ${extractedTables.length}`);
            context.log(`[${correlationId}]   - Total Paragraphs Extracted: ${extractedParagraphs.length}`);
            context.log(`[${correlationId}]   - Raw Text Content Length: ${rawContentLen} characters`);
            if (extractedTables.length > 0) {
                context.log(`[${correlationId}]   - Table 1 Dimensions: ${extractedTables[0].rowCount} rows x ${extractedTables[0].columnCount} columns`);
            }

            // STEP 4: CONTENT NORMALIZATION
            currentStep = 'STEP 4: CONTENT NORMALIZATION';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            const normalized = normalizeContent(docIntelResult, documentId);
            const normTextLen = (normalized.fullMarkdown || normalized.content || '').length;
            const normTables = (normalized.tables || []).length;
            const normParas = (normalized.paragraphs || []).length;

            context.log(`[${correlationId}] Step 4 Output (Normalized Content):`);
            context.log(`[${correlationId}]   - Normalized Markdown Length: ${normTextLen} characters`);
            context.log(`[${correlationId}]   - Normalized Paragraphs: ${normParas}`);
            context.log(`[${correlationId}]   - Normalized Tables: ${normTables}`);

            // STEP 5: STRUCTURED FINANCIAL FACT EXTRACTION
            currentStep = 'STEP 5: STRUCTURED FINANCIAL FACT EXTRACTION';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            const extractedFacts = extractFinancialFacts(normalized);

            context.log(`[${correlationId}] Step 5 Output (Extracted Facts Count): ${extractedFacts.length}`);
            if (extractedFacts.length > 0) {
                const sampleLimit = Math.min(extractedFacts.length, 4);
                context.log(`[${correlationId}] Step 5 Fact Samples (First ${sampleLimit}):`);
                for (let i = 0; i < sampleLimit; i++) {
                    const f = extractedFacts[i];
                    context.log(`[${correlationId}]   [Fact ${i + 1}] Metric="${f.metric}", Entity="${f.entity || 'N/A'}", Value=${f.numericValue ?? f.textValue} ${f.currency || f.unit || ''}, Location="${f.sourceLocation || 'N/A'}"`);
                }
            } else {
                context.log(`[${correlationId}] Step 5 Notice: No structured financial metrics discovered in this document text.`);
            }

            // STEP 6: FACT PERSISTENCE & CONFLICT RESOLUTION (AZURE SQL)
            currentStep = 'STEP 6: FACT PERSISTENCE & CONFLICT AUDITING (AZURE SQL)';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            let conflicts = [];
            if (extractedFacts.length > 0) {
                const insertedCount = await insertFinancialFacts(documentId, extractedFacts, authorityRank, fileName);
                context.log(`[${correlationId}] Step 6 Output (dbo.FinancialFacts):`);
                context.log(`[${correlationId}]   - Inserted Rows: ${insertedCount || extractedFacts.length}`);

                conflicts = await detectAndResolveConflicts(documentId);
                context.log(`[${correlationId}] Step 6 Output (dbo.FactConflicts Audit):`);
                context.log(`[${correlationId}]   - Conflicts/Discrepancies Discovered: ${conflicts.length}`);
                if (conflicts.length > 0) {
                    for (let c of conflicts) {
                        context.log(`[${correlationId}]   - Conflict on Metric "${c.metric}": Doc1Value=${c.fact1Value} vs Doc2Value=${c.fact2Value}, Diff=${c.difference}`);
                    }
                }
            } else {
                context.log(`[${correlationId}] Step 6 Output: Skipped SQL fact insertion (0 facts extracted).`);
            }

            // STEP 7: RETRIEVAL CHUNKING
            currentStep = 'STEP 7: RETRIEVAL CHUNKING';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            const chunks = createChunks(normalized, fileName);

            context.log(`[${correlationId}] Step 7 Output (Created Chunks):`);
            context.log(`[${correlationId}]   - Total Chunks Created: ${chunks.length}`);
            if (chunks.length > 0) {
                context.log(`[${correlationId}]   - Chunk 0: ID="${chunks[0].id}", Title="${chunks[0].title}", Length=${chunks[0].content.length} chars`);
                if (chunks.length > 1) {
                    const lastIdx = chunks.length - 1;
                    context.log(`[${correlationId}]   - Chunk ${lastIdx}: ID="${chunks[lastIdx].id}", Title="${chunks[lastIdx].title}", Length=${chunks[lastIdx].content.length} chars`);
                }
            }

            // STEP 8: VECTOR EMBEDDINGS GENERATION (AZURE OPENAI)
            currentStep = 'STEP 8: VECTOR EMBEDDINGS (AZURE OPENAI)';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            if (chunks.length > 0) {
                const chunkTexts = chunks.map(c => `${c.title}\n${c.content}`);
                context.log(`[${correlationId}]   - Requesting embeddings for ${chunkTexts.length} chunks via text-embedding-3-small...`);

                const embeddings = await generateBatchEmbeddings(chunkTexts);
                const vectorDimensions = embeddings[0] ? embeddings[0].length : 0;

                context.log(`[${correlationId}] Step 8 Output (Embeddings Generated):`);
                context.log(`[${correlationId}]   - Total Vectors Produced: ${embeddings.length}`);
                context.log(`[${correlationId}]   - Vector Dimensionality: ${vectorDimensions} floats per vector`);

                const searchDocuments = chunks.map((chunk, idx) => ({
                    id: chunk.id,
                    title: chunk.title,
                    content: chunk.content,
                    source: chunk.source,
                    contentVector: embeddings[idx]
                }));

                // STEP 9: VECTOR INDEXING (AZURE AI SEARCH)
                currentStep = 'STEP 9: VECTOR INDEXING (AZURE AI SEARCH)';
                context.log(`[${correlationId}] === ${currentStep} ===`);

                const searchIndex = process.env.AZURE_SEARCH_INDEX || 'finance-hr-documents';
                context.log(`[${correlationId}]   - Uploading ${searchDocuments.length} documents to Azure Search index "${searchIndex}"...`);

                await uploadChunks(searchDocuments);

                context.log(`[${correlationId}] Step 9 Output (Azure AI Search):`);
                context.log(`[${correlationId}]   - Successfully uploaded ${searchDocuments.length} vector chunks to index "${searchIndex}".`);
            } else {
                context.log(`[${correlationId}] Step 8 & 9 Output: Skipped embedding and vector indexing (0 chunks).`);
            }

            // STEP 10: INGESTION COMPLETION (AZURE SQL)
            currentStep = 'STEP 10: INGESTION COMPLETION (AZURE SQL)';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            await updateDocumentStatus(documentId, 'Succeeded');
            await completeIngestionRun(runId, 1, 0, 'Succeeded');

            context.log(`[${correlationId}] Step 10 Output (Status Finalized):`);
            context.log(`[${correlationId}]   - dbo.Documents [ID ${documentId}]: IngestionStatus = "Succeeded"`);
            context.log(`[${correlationId}]   - dbo.IngestionRuns [ID ${runId}]: RunStatus = "Succeeded", FilesSucceeded = 1`);
            context.log(`[${correlationId}] >>> INGESTION FINISHED SUCCESSFULLY <<< DocumentId=${documentId}, Facts=${extractedFacts.length}, Chunks=${chunks.length}`);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'success',
                    documentId,
                    runId,
                    fileName,
                    authorityRank,
                    factsExtracted: extractedFacts.length,
                    chunksIndexed: chunks.length,
                    conflictsProcessed: conflicts.length,
                    correlationId
                })
            };

        } catch (err) {
            context.error(`[${correlationId}] !!! INGESTION FAILED AT [${currentStep}] !!!`);
            context.error(`[${correlationId}] Error Name: ${err.name || 'Error'}`);
            context.error(`[${correlationId}] Error Message: ${err.message}`);
            if (err.stack) {
                context.error(`[${correlationId}] Error Stack Trace: ${err.stack}`);
            }

            if (documentId) {
                context.warn(`[${correlationId}] Rolling back partial facts and updating DocumentId=${documentId} status to 'Failed' in SQL...`);
                await deleteDocumentFacts(documentId).catch(e => {
                    context.error(`[${correlationId}] Failed to delete partial facts: ${e.message}`);
                });
                await updateDocumentStatus(documentId, 'Failed').catch(e => {
                    context.error(`[${correlationId}] Failed to update document status in SQL: ${e.message}`);
                });
            }
            if (runId) {
                context.warn(`[${correlationId}] Updating RunId=${runId} status to 'Failed' in SQL...`);
                await completeIngestionRun(runId, 0, 1, 'Failed', sanitizeErrorMessage(err)).catch(e => {
                    context.error(`[${correlationId}] Failed to update ingestion run in SQL: ${e.message}`);
                });
            }

            return toErrorResponse(err, correlationId);
        }
    }
});
