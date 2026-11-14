const { generateConflictResolutionToken } = require('./conflict-token');
const { logNotificationSent } = require('./audit-log');
require('../utils/config');

/**
 * Builds the HTML content for the conflict notification email.
 */
function buildConflictEmailHtml({
    fileName,
    documentId,
    modifiedByName,
    conflicts,
    acceptLink,
    keepLink
}) {
    const primaryConflict = conflicts[0] || {};
    const existingUploader = primaryConflict.existingUploader ||
        primaryConflict.fact1?.AuthorityType ||
        'Financial Reporting Authority';
    const existingFileName = primaryConflict.existingFileName ||
        primaryConflict.fact1?.SourceFileName ||
        'existing financial filing';

    const rowsHtml = conflicts.map(c => {
        const metric = c.metric || c.fact1?.Metric || 'N/A';
        const period = c.period || c.fact1?.PeriodLabel || 'N/A';
        const entity = c.entity || c.fact1?.Entity || 'General';
        const currency = c.currency || c.fact1?.Currency || '';

        const existingVal = c.existingValue ?? c.fact1?.NumericValue ?? 'N/A';
        const uploadedVal = c.uploadedValue ?? c.fact2?.NumericValue ?? 'N/A';
        const diff = c.difference !== undefined ? c.difference : (Number(uploadedVal) - Number(existingVal));
        const diffSign = diff > 0 ? `+${diff}` : `${diff}`;
        const source = c.existingFileName || c.fact1?.SourceFileName || 'Existing Record';
        const auth = c.existingUploader || c.fact1?.AuthorityType || 'Authority Record';

        return `
            <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 14px; font-weight: 600; color: #1e293b;">${metric}</td>
                <td style="padding: 10px 14px; color: #475569;">${period}<br><small style="color: #64748b;">${entity}</small></td>
                <td style="padding: 10px 14px; text-align: right; color: #334155; font-family: monospace;">${existingVal} ${currency}</td>
                <td style="padding: 10px 14px; text-align: right; font-weight: bold; color: #0284c7; font-family: monospace;">${uploadedVal} ${currency}</td>
                <td style="padding: 10px 14px; text-align: right; font-weight: bold; color: ${diff >= 0 ? '#16a34a' : '#dc2626'}; font-family: monospace;">${diffSign} ${currency}</td>
                <td style="padding: 10px 14px; color: #475569; font-size: 13px;">${source}<br><small style="color: #64748b;">${auth}</small></td>
            </tr>
        `;
    }).join('');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Action Required: Financial Conflict Detected</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b;">
    <div style="max-width: 720px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
        <!-- Header -->
        <div style="background-color: #0f172a; padding: 20px 28px; border-bottom: 3px solid #eab308;">
            <h1 style="color: #ffffff; margin: 0; font-size: 20px; letter-spacing: -0.02em;">
                ⚠️ FinChat Governance Alert: Conflict Detected
            </h1>
            <p style="color: #94a3b8; margin: 4px 0 0 0; font-size: 14px;">
                Confirmation required for uploaded document "${fileName}"
            </p>
        </div>

        <!-- Body Content -->
        <div style="padding: 28px;">
            <p style="font-size: 15px; line-height: 1.6; margin-top: 0;">
                Hello <strong>${modifiedByName || 'Finance Team'}</strong>,
            </p>

            <div style="background-color: #fefce8; border-left: 4px solid #eab308; padding: 14px 18px; border-radius: 4px; margin: 20px 0;">
                <p style="margin: 0; font-size: 15px; color: #713f12; line-height: 1.5;">
                    <strong>FinChat already has a document uploaded by ${existingUploader} with document name "${existingFileName}" which has conflicts with your uploaded document.</strong>
                </p>
            </div>

            <p style="font-size: 14px; color: #475569; margin-bottom: 12px;">
                Your uploaded document <strong>"${fileName}"</strong> (Document ID: ${documentId}) has been placed in <strong>Pending Review</strong> status. Below is the itemized discrepancy breakdown:
            </p>

            <!-- Discrepancy Table -->
            <div style="overflow-x: auto; margin: 20px 0;">
                <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; border: 1px solid #e2e8f0;">
                    <thead>
                        <tr style="background-color: #f1f5f9; border-bottom: 2px solid #cbd5e1;">
                            <th style="padding: 10px 14px; color: #334155;">Metric</th>
                            <th style="padding: 10px 14px; color: #334155;">Period & Entity</th>
                            <th style="padding: 10px 14px; text-align: right; color: #334155;">Existing Value</th>
                            <th style="padding: 10px 14px; text-align: right; color: #334155;">Uploaded Value</th>
                            <th style="padding: 10px 14px; text-align: right; color: #334155;">Variance</th>
                            <th style="padding: 10px 14px; color: #334155;">Existing Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>

            <!-- Action Section -->
            <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 20px; margin-top: 28px; text-align: center;">
                <h3 style="margin: 0 0 10px 0; font-size: 16px; color: #0f172a;">
                    How would you like to resolve this discrepancy?
                </h3>
                <p style="margin: 0 0 20px 0; font-size: 13px; color: #64748b;">
                    Click a confirmation button below to apply the authoritative figures in FinChat:
                </p>

                <div style="display: inline-flex; gap: 14px; justify-content: center; flex-wrap: wrap;">
                    <a href="${acceptLink}" style="display: inline-block; background-color: #16a34a; color: #ffffff; text-decoration: none; padding: 12px 22px; border-radius: 6px; font-weight: 600; font-size: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.1);">
                        ✅ Accept New Version (Supersede)
                    </a>
                    <a href="${keepLink}" style="display: inline-block; background-color: #ffffff; color: #dc2626; border: 1px solid #f87171; text-decoration: none; padding: 12px 22px; border-radius: 6px; font-weight: 600; font-size: 14px;">
                        ❌ Keep Existing Figures (Reject New)
                    </a>
                </div>

                <p style="margin: 18px 0 0 0; font-size: 12px; color: #94a3b8;">
                    These secure action links are valid for 7 days.
                </p>
            </div>
        </div>

        <!-- Footer -->
        <div style="background-color: #f1f5f9; padding: 14px 28px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center;">
            FinChat Automated Financial Governance Engine • Document ID: ${documentId}
        </div>
    </div>
</body>
</html>
    `;
}

/**
 * Builds plaintext version of the notification email.
 */
function buildConflictEmailText({
    fileName,
    documentId,
    conflicts,
    acceptLink,
    keepLink
}) {
    const primary = conflicts[0] || {};
    const existingUploader = primary.existingUploader || primary.fact1?.AuthorityType || 'Financial Reporting Authority';
    const existingFileName = primary.existingFileName || primary.fact1?.SourceFileName || 'existing financial filing';

    let text = `[FinChat Governance Alert] Conflict Detected in "${fileName}" (Document ID: ${documentId})\n\n`;
    text += `FinChat already has a document uploaded by ${existingUploader} with document name "${existingFileName}" which has conflicts with your uploaded document.\n\n`;
    text += `DISCREPANCY DETAILS:\n`;
    text += `------------------------------------------------------------\n`;

    for (const c of conflicts) {
        const metric = c.metric || c.fact1?.Metric || 'N/A';
        const period = c.period || c.fact1?.PeriodLabel || 'N/A';
        const existingVal = c.existingValue ?? c.fact1?.NumericValue ?? 'N/A';
        const uploadedVal = c.uploadedValue ?? c.fact2?.NumericValue ?? 'N/A';
        const diff = c.difference !== undefined ? c.difference : (Number(uploadedVal) - Number(existingVal));
        text += `- ${metric} (${period}): Existing = ${existingVal} vs Uploaded = ${uploadedVal} (Diff: ${diff})\n`;
    }

    text += `------------------------------------------------------------\n\n`;
    text += `ACTIONS REQUIRED:\n`;
    text += `To Accept the new figures and supersede previous records:\n${acceptLink}\n\n`;
    text += `To Keep existing records and reject the new figures:\n${keepLink}\n\n`;
    text += `(Links valid for 7 days.)\n`;

    return text;
}

/**
 * Sends a conflict notification email to the uploader / modified_user.
 */
async function sendConflictNotificationEmail({
    documentId,
    fileName,
    modifiedByEmail,
    modifiedByName = '',
    conflicts = [],
    baseUrl = null,
    correlationId = null,
    context = console
}) {
    const recipient = modifiedByEmail || process.env.FINCHAT_DEFAULT_NOTIFY_EMAIL || 'finance-alerts@local';
    const appBaseUrl = baseUrl || process.env.FINCHAT_BASE_URL || 'http://localhost:7071';
    const subject = `[FinChat Action Required] Conflict Detected in "${fileName}"`;

    // Generate secure HMAC resolution tokens
    const acceptToken = generateConflictResolutionToken({
        documentId,
        userEmail: recipient,
        action: 'ACCEPT_NEW',
        expiresInDays: 7
    });

    const keepToken = generateConflictResolutionToken({
        documentId,
        userEmail: recipient,
        action: 'KEEP_EXISTING',
        expiresInDays: 7
    });

    const acceptLink = `${appBaseUrl}/api/resolveConflict?token=${acceptToken}&action=ACCEPT_NEW&documentId=${documentId}`;
    const keepLink = `${appBaseUrl}/api/resolveConflict?token=${keepToken}&action=KEEP_EXISTING&documentId=${documentId}`;

    const htmlContent = buildConflictEmailHtml({
        fileName,
        documentId,
        modifiedByName,
        conflicts,
        acceptLink,
        keepLink
    });

    const textContent = buildConflictEmailText({
        fileName,
        documentId,
        conflicts,
        acceptLink,
        keepLink
    });

    const senderEmail = process.env.FINCHAT_NOTIFICATION_SENDER_EMAIL || process.env.NOTIFICATION_SENDER_EMAIL;
    const hasGraphCredentials = process.env.CLIENT_ID && process.env.CLIENT_SECRET && process.env.TENANT_ID && senderEmail;

    let deliveryStatus = 'Delivered (Mock)';
    let messageId = `msg-${Date.now()}`;

    if (hasGraphCredentials && !process.env.FINCHAT_MOCK_EMAIL) {
        try {
            const { ClientSecretCredential } = require('@azure/identity');
            const { Client } = require('@microsoft/microsoft-graph-client');
            const { TokenCredentialAuthenticationProvider } = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');

            const credential = new ClientSecretCredential(
                process.env.TENANT_ID,
                process.env.CLIENT_ID,
                process.env.CLIENT_SECRET
            );

            const authProvider = new TokenCredentialAuthenticationProvider(credential, {
                scopes: ['https://graph.microsoft.com/.default']
            });

            const client = Client.initWithMiddleware({ authProvider });

            const sendMailPayload = {
                message: {
                    subject,
                    body: {
                        contentType: 'HTML',
                        content: htmlContent
                    },
                    toRecipients: [
                        {
                            emailAddress: {
                                address: recipient
                            }
                        }
                    ]
                },
                saveToSentItems: false
            };

            await client.api(`/users/${senderEmail}/sendMail`).post(sendMailPayload);
            deliveryStatus = 'Delivered';
            context.log?.(`[${correlationId || 'email'}] Graph API email successfully sent to ${recipient}.`);
        } catch (mailErr) {
            context.warn?.(`[${correlationId || 'email'}] Graph sendMail encountered an issue: ${mailErr.message}. Falling back to logged notification.`);
            deliveryStatus = 'Fallback (Logged)';
        }
    } else {
        context.log?.(`[${correlationId || 'email'}] [Email Notification Mock]`);
        context.log?.(`  - To: ${recipient}`);
        context.log?.(`  - Subject: ${subject}`);
        context.log?.(`  - Accept Link: ${acceptLink}`);
        context.log?.(`  - Keep Link: ${keepLink}`);
    }

    await logNotificationSent({
        documentId,
        recipientEmail: recipient,
        subject,
        status: deliveryStatus,
        messageId,
        correlationId
    });

    return {
        success: true,
        recipient,
        subject,
        deliveryStatus,
        acceptLink,
        keepLink,
        messageId
    };
}

module.exports = {
    buildConflictEmailHtml,
    buildConflictEmailText,
    sendConflictNotificationEmail
};

