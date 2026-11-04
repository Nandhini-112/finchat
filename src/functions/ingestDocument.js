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
    insertFinancialFacts
} = require('../services/sql');
const { detectAndResolveConflicts } = require('../services/conflict-resolver');

app.http('ingestDocument', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const correlationId = `ingest-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        context.log(`[${correlationId}] Ingestion request received for: ${request.url}`);

        let runId = null;
        let documentId = null;

        try {
            const contentType = (request.headers.get('content-type') || '').toLowerCase();
            let fileBuffer;
            let fileName = request.query.get('fileName') || request.headers.get('x-filename') || null;
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

                fileName = fileName || jsonBody.fileName;
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

            fileName = fileName || `document_${Date.now()}.pdf`;

            // 1. Validate Document Buffer
            validateDocumentBuffer(fileBuffer, fileName);
            context.log(`[${correlationId}] Processing document "${fileName}" (${(fileBuffer.length / 1024).toFixed(1)} KB), Rank=${authorityRank}`);

            // 2. Start Ingestion Run & Register Document in SQL
            runId = await startIngestionRun(1);
            documentId = await createDocument(fileName, sourceType, authorityRank, allowedUserGroups);
            context.log(`[${correlationId}] Registered in SQL: DocumentId=${documentId}, RunId=${runId}`);

            // 3. Extract Document Content & Tables Locally
            context.log(`[${correlationId}] Extracting document structure...`);
            const docIntelResult = await analyzeDocument(fileBuffer, fileName);

            // 4. Normalize Content
            const normalized = normalizeContent(docIntelResult, documentId);

            // 5. Extract Structured Financial Facts
            const extractedFacts = extractFinancialFacts(normalized);
            context.log(`[${correlationId}] Extracted ${extractedFacts.length} structured facts.`);

            // 6. Insert Facts into SQL & Check Discrepancies
            let conflicts = [];
            if (extractedFacts.length > 0) {
                await insertFinancialFacts(documentId, extractedFacts, authorityRank, fileName);
                conflicts = await detectAndResolveConflicts(documentId);
            }

            // 7. Create Retrieval Chunks
            const chunks = createChunks(normalized, fileName);

            // 8. Generate OpenAI Embeddings
            if (chunks.length > 0) {
                const chunkTexts = chunks.map(c => `${c.title}\n${c.content}`);
                context.log(`[${correlationId}] Generating embeddings for ${chunks.length} chunks...`);
                const embeddings = await generateBatchEmbeddings(chunkTexts);

                const searchDocuments = chunks.map((chunk, idx) => ({
                    id: chunk.id,
                    title: chunk.title,
                    content: chunk.content,
                    source: chunk.source,
                    contentVector: embeddings[idx]
                }));

                // 9. Upload Chunks to Azure AI Search
                await uploadChunks(searchDocuments);
                context.log(`[${correlationId}] Successfully indexed ${searchDocuments.length} chunks into Azure AI Search.`);
            }

            // 10. Mark Document as Succeeded
            await updateDocumentStatus(documentId, 'Succeeded');
            await completeIngestionRun(runId, 1, 0, 'Succeeded');

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
            context.error(`[${correlationId}] Ingestion failed: ${err.message}`, err.stack);

            if (documentId) {
                await updateDocumentStatus(documentId, 'Failed').catch(() => {});
            }
            if (runId) {
                await completeIngestionRun(runId, 0, 1, 'Failed', sanitizeErrorMessage(err)).catch(() => {});
            }

            return toErrorResponse(err, correlationId);
        }
    }
});
