const { app } = require('@azure/functions');
const { verifyConflictResolutionToken } = require('../services/conflict-token');
const { resolveDocumentConflict, getDocumentById } = require('../services/sql');
const { logConflictResolution } = require('../services/audit-log');
const { toErrorResponse, ValidationError, NotFoundError } = require('../utils/errors');
require('../utils/config');

/**
 * Builds a clean, responsive HTML response for browser clicks.
 */
function buildConfirmationPageHtml({
    isSuccess,
    title,
    message,
    fileName = '',
    documentId = '',
    action = '',
    reviewerEmail = ''
}) {
    const primaryColor = isSuccess ? '#16a34a' : '#dc2626';
    const icon = isSuccess ? '✅' : '❌';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - FinChat Governance</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background-color: #f8fafc;
            color: #0f172a;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 16px;
        }
        .card {
            background: #ffffff;
            border-radius: 12px;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.08);
            border: 1px solid #e2e8f0;
            max-width: 520px;
            width: 100%;
            padding: 32px;
            text-align: center;
        }
        .icon {
            font-size: 48px;
            margin-bottom: 16px;
        }
        h1 {
            font-size: 22px;
            margin: 0 0 12px 0;
            color: ${primaryColor};
        }
        p {
            font-size: 15px;
            color: #475569;
            line-height: 1.6;
            margin: 0 0 20px 0;
        }
        .meta-box {
            background: #f1f5f9;
            border-radius: 8px;
            padding: 14px 18px;
            text-align: left;
            font-size: 13px;
            color: #334155;
            margin-bottom: 24px;
        }
        .meta-row {
            display: flex;
            justify-content: space-between;
            padding: 4px 0;
        }
        .meta-row strong {
            color: #0f172a;
        }
        .footer {
            font-size: 12px;
            color: #94a3b8;
            border-top: 1px solid #f1f5f9;
            padding-top: 16px;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">${icon}</div>
        <h1>${title}</h1>
        <p>${message}</p>

        ${fileName ? `
        <div class="meta-box">
            <div class="meta-row"><span>Document:</span><strong>${fileName}</strong></div>
            <div class="meta-row"><span>Document ID:</span><strong>${documentId}</strong></div>
            <div class="meta-row"><span>Action Applied:</span><strong>${action}</strong></div>
            ${reviewerEmail ? `<div class="meta-row"><span>Confirmed By:</span><strong>${reviewerEmail}</strong></div>` : ''}
            <div class="meta-row"><span>Status:</span><strong style="color: ${primaryColor};">Active / Succeeded</strong></div>
        </div>
        ` : ''}

        <div class="footer">
            FinChat Automated Financial Governance Engine • Discrepancy Audited
        </div>
    </div>
</body>
</html>
    `;
}

async function resolveConflictHandler(request, context) {
    const correlationId = `res-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    context.log(`[${correlationId}] >>> CONFLICT RESOLUTION REQUEST <<< Method=${request.method}`);

        const isBrowserGet = request.method === 'GET';

        try {
            let documentId = null;
            let conflictId = null;
            let action = null;
            let token = null;
            let reviewerEmail = null;
            let notes = '';

            if (isBrowserGet) {
                token = request.query.get('token');
                action = request.query.get('action');
                documentId = request.query.get('documentId');
                notes = request.query.get('notes') || '';
            } else {
                const jsonBody = await request.json().catch(() => ({}));
                token = jsonBody.token || request.query.get('token');
                action = jsonBody.action || request.query.get('action');
                documentId = jsonBody.documentId || request.query.get('documentId');
                conflictId = jsonBody.conflictId || request.query.get('conflictId');
                reviewerEmail = jsonBody.reviewerEmail || request.query.get('reviewerEmail');
                notes = jsonBody.notes || request.query.get('notes') || '';
            }

            // Normalize action
            const cleanAction = String(action || 'ACCEPT_NEW').trim().toUpperCase();
            if (!['ACCEPT_NEW', 'KEEP_EXISTING', 'REJECT'].includes(cleanAction)) {
                throw new ValidationError(`Unsupported resolution action: "${action}". Valid actions are: ACCEPT_NEW, KEEP_EXISTING, REJECT.`);
            }

            // Verify token if supplied
            if (token) {
                const tokenResult = verifyConflictResolutionToken(token);
                if (!tokenResult.valid) {
                    throw new ValidationError(`Token validation failed: ${tokenResult.error}`);
                }

                // If documentId wasn't in URL, populate from token
                documentId = documentId || tokenResult.payload.documentId;
                reviewerEmail = reviewerEmail || tokenResult.payload.userEmail;
            }

            if (!documentId) {
                throw new ValidationError('documentId is required to resolve a conflict.');
            }

            const docIdNum = Number(documentId);
            const doc = await getDocumentById(docIdNum);
            if (!doc) {
                throw new NotFoundError(`Document with identifier "${documentId}" was not found.`);
            }

            reviewerEmail = reviewerEmail || doc.ModifiedByEmail;

            context.log(`[${correlationId}] Resolving conflict for Document ID: ${docIdNum} ("${doc.FileName}"), Action: ${cleanAction}, Reviewer: ${reviewerEmail}`);

            // Apply resolution in SQL
            const resolutionResult = await resolveDocumentConflict({
                documentId: docIdNum,
                conflictId,
                action: cleanAction,
                reviewerEmail,
                notes
            });

            // Write audit log
            await logConflictResolution({
                documentId: docIdNum,
                conflictId,
                action: cleanAction,
                reviewerEmail,
                previousStatus: 'Pending Review',
                newStatus: resolutionResult.status,
                notes: resolutionResult.notes,
                correlationId
            });

            context.log(`[${correlationId}] Conflict successfully resolved in SQL. Status updated to: ${resolutionResult.status}`);

            if (isBrowserGet) {
                const actionLabel = cleanAction === 'ACCEPT_NEW'
                    ? 'New Version Accepted (Previous Superseded)'
                    : cleanAction === 'KEEP_EXISTING'
                        ? 'Existing Version Retained (New Rejected)'
                        : 'Document Rejected';

                const html = buildConfirmationPageHtml({
                    isSuccess: true,
                    title: 'Conflict Resolved Successfully',
                    message: `Your confirmation has been recorded. Document figures have been updated and validated.`,
                    fileName: doc.FileName,
                    documentId: doc.DocumentId,
                    action: actionLabel,
                    reviewerEmail
                });

                return {
                    status: 200,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    body: html
                };
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    message: `Conflict successfully resolved for document ${docIdNum}.`,
                    resolution: resolutionResult,
                    correlationId
                })
            };

        } catch (err) {
            context.error(`[${correlationId}] Conflict resolution error: ${err.message}`);

            if (isBrowserGet) {
                const errorHtml = buildConfirmationPageHtml({
                    isSuccess: false,
                    title: 'Resolution Request Failed',
                    message: err.message || 'An error occurred while confirming this conflict.'
                });

                return {
                    status: err.statusCode || 400,
                    headers: { 'Content-Type': 'text/html; charset=utf-8' },
                    body: errorHtml
                };
            }

            return toErrorResponse(err, correlationId);
        }
    }

app.http('resolveConflict', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: resolveConflictHandler
});

module.exports = {
    resolveConflictHandler,
    buildConfirmationPageHtml
};

