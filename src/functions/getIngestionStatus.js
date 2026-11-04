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

            // 2. Fetch document record from SQL
            const doc = await getDocumentById(documentId);
            if (!doc) {
                throw new NotFoundError(`Document with identifier "${documentId}" was not found.`);
            }

            // 3. Fetch structured facts count for this document
            const facts = await getFinancialFacts(doc.DocumentId);

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
            context.error(`[${correlationId}] Status error: ${error.message}`);
            return toErrorResponse(error, correlationId);
        }
    }
});
