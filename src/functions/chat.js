const { app } = require('@azure/functions');
const { validateChatRequest } = require('../utils/validation');
const { toErrorResponse, NotFoundError } = require('../utils/errors');
const { getDocumentById } = require('../services/sql');
const { processRetrievalPipeline } = require('../services/retrieval-pipeline');

app.http('chat', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const correlationId = `chat-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        context.log(`[${correlationId}] >>> START CHAT REQUEST <<< URL=${request.url}`);

        let currentStep = 'INITIALIZATION';

        try {
            // =========================================================================
            // STEP 0: REQUEST PARSING & DOCUMENT AUTHORIZATION
            // =========================================================================
            currentStep = 'STEP 0: REQUEST PARSING & VALIDATION';
            const body = await request.json().catch(() => null);
            const { question, documentId } = validateChatRequest(body);
            const userGroupsHeader = request.headers.get('x-user-groups') || (body && body.userGroups) || null;

            context.log(`[${correlationId}] Step 0 Output: Question="${question}", TargetDocument=${documentId || 'ALL'}, UserGroups=${userGroupsHeader || 'Public'}`);

            let targetDoc = null;
            let searchFilter = null;

            if (documentId) {
                targetDoc = await getDocumentById(documentId);
                if (!targetDoc) {
                    throw new NotFoundError(`Document with ID or name "${documentId}" was not found.`);
                }

                // Check document-level access permissions if configured
                if (targetDoc.AllowedUserGroups && userGroupsHeader) {
                    const allowed = targetDoc.AllowedUserGroups.split(',').map(g => g.trim().toLowerCase());
                    const userGroups = userGroupsHeader.split(',').map(g => g.trim().toLowerCase());
                    const hasAccess = userGroups.some(ug => allowed.includes(ug)) || allowed.includes('*');
                    if (!hasAccess) {
                        return {
                            status: 403,
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                status: 'FORBIDDEN',
                                answer: 'Access denied: You do not have the required permissions to access this document.',
                                documentId: targetDoc.DocumentId,
                                insufficientEvidence: true,
                                correlationId
                            })
                        };
                    }
                }

                if (targetDoc.IngestionStatus === 'Processing') {
                    return {
                        status: 409,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            status: 'PROCESSING',
                            answer: `Document "${targetDoc.FileName}" is currently being processed. Please try again shortly.`,
                            documentId: targetDoc.DocumentId,
                            sources: [],
                            insufficientEvidence: true,
                            correlationId
                        })
                    };
                }

                if (targetDoc.IngestionStatus === 'Failed') {
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            status: 'FAILED',
                            answer: `Ingestion previously failed for document "${targetDoc.FileName}". Please re-ingest the document.`,
                            documentId: targetDoc.DocumentId,
                            sources: [],
                            insufficientEvidence: true,
                            correlationId
                        })
                    };
                }

                searchFilter = `source eq '${targetDoc.FileName.replace(/'/g, "''")}'`;
            }

            // =========================================================================
            // EXECUTE COMPLETE 11-STAGE RETRIEVAL PIPELINE
            // =========================================================================
            currentStep = 'EXECUTE RETRIEVAL PIPELINE (STAGES 1 - 11)';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            const pipelineResult = await processRetrievalPipeline({
                question,
                targetDocument: targetDoc,
                searchFilter,
                conversationHistory: (body && (body.conversationHistory || body.messages || body.history)) || null,
                correlationId,
                logger: context
            });

            // =========================================================================
            // RESPONSE DELIVERY (PRESERVING EXACT API RESPONSE CONTRACT)
            // =========================================================================
            context.log(`[${correlationId}] >>> CHAT REQUEST COMPLETED SUCCESSFULLY <<< Route=${pipelineResult.routeUsed}, Sources=${pipelineResult.sources.length}`);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: pipelineResult.status || 'success',
                    routeUsed: pipelineResult.routeUsed,
                    intentType: pipelineResult.intentType,
                    entitiesDetected: pipelineResult.entitiesDetected || [],
                    periodsDetected: pipelineResult.periodsDetected || [],
                    metricsDetected: pipelineResult.metricsDetected || [],
                    answer: pipelineResult.answer,
                    language: pipelineResult.language,
                    grounded: pipelineResult.grounded,
                    hasUnresolvedConflict: pipelineResult.hasUnresolvedConflict,
                    documentId: pipelineResult.documentId,
                    document_name: pipelineResult.document_name,
                    page: pipelineResult.page,
                    sources: pipelineResult.sources || [],
                    factsUsed: pipelineResult.factsUsed || [],
                    calculations: pipelineResult.calculations || [],
                    insufficientEvidence: pipelineResult.insufficientEvidence,
                    correlationId: pipelineResult.correlationId
                })
            };

        } catch (error) {
            context.error(`[${correlationId}] !!! CHAT FAILED AT [${currentStep}] !!!`);
            context.error(`[${correlationId}] Error: ${error.message}`);
            if (error.stack) context.error(`[${correlationId}] Stack: ${error.stack}`);
            return toErrorResponse(error, correlationId);
        }
    }
});
