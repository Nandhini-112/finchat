const { app } = require('@azure/functions');
const { validateDocumentId } = require('../utils/validation');
const { toErrorResponse, NotFoundError } = require('../utils/errors');
const { getDocumentById, getFinancialFacts } = require('../services/sql');

app.http('getIngestionStatus', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const correlationId = `status-${Date.now()}`;
        context.log(`[${correlationId}] Ingestion status requested for url: ${request.url}`);

        try {
            // 1. Extract and validate documentId query parameter
            const rawId = request.query.get('documentId');
            const documentId = validateDocumentId(rawId);
            context.log(`[${correlationId}] Step 1 Output: Validated documentId: "${documentId}"`);

            // 2. Fetch document record from SQL
            const doc = await getDocumentById(documentId);
            if (!doc) {
                throw new NotFoundError(`Document with identifier "${documentId}" was not found.`);
            }
            context.log(`[${correlationId}] Step 2 Output: Found document "${doc.FileName}" (ID: ${doc.DocumentId}, Status: "${doc.IngestionStatus}", Source: "${doc.SourceType}")`);

            // 3. Fetch structured facts count for this document
            const facts = await getFinancialFacts(doc.DocumentId);
            context.log(`[${correlationId}] Step 3 Output: Structured facts count in database: ${facts.length}`);

            // 4. Return clean status response
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    documentId: doc.DocumentId,
                    fileName: doc.FileName,
                    sourceType: doc.SourceType,
                    authorityRank: doc.AuthorityRank,
                    ingestionStatus: doc.IngestionStatus,
                    createdAt: doc.CreatedAt,
                    lastProcessedAt: doc.LastProcessedAt,
                    factsCount: facts.length,
                    correlationId
                })
            };
        } catch (error) {
            context.error(`[${correlationId}] Status retrieval failed: ${error.message}`);
            if (error.stack) {
                context.error(`[${correlationId}] Error stack trace: ${error.stack}`);
            }
            return toErrorResponse(error, correlationId);
        }
    }
});
