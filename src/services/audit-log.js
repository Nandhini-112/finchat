const { insertAuditLog, getAuditLogsForDocument } = require('./sql');

/**
 * Audit Logging Service for FinChat Document Lifecycle & Governance.
 * Guarantees resilient, non-blocking recording into dbo.AuditLogs.
 */

async function logConflictDetected({
    documentId,
    conflicts = [],
    correlationId = null
}) {
    const summary = conflicts.map(c => ({
        metric: c.fact1?.Metric || c.metric,
        entity: c.fact1?.Entity || c.entity,
        period: c.fact1?.PeriodLabel || c.period,
        existingSource: c.fact1?.SourceFileName || c.existingFileName,
        existingValue: c.fact1?.NumericValue ?? c.existingValue,
        uploadedValue: c.fact2?.NumericValue ?? c.uploadedValue,
        difference: c.difference
    }));

    return insertAuditLog({
        eventType: 'CONFLICT_DETECTED',
        documentId,
        actionBy: 'SYSTEM',
        actionRole: 'System',
        previousStatus: 'Processing',
        newStatus: 'Pending Review',
        details: {
            conflictCount: conflicts.length,
            conflicts: summary
        },
        correlationId
    });
}

async function logNotificationSent({
    documentId,
    recipientEmail,
    subject = '',
    status = 'Delivered',
    messageId = null,
    correlationId = null
}) {
    return insertAuditLog({
        eventType: status === 'Failed' ? 'NOTIFICATION_FAILED' : 'NOTIFICATION_SENT',
        documentId,
        actionBy: recipientEmail || 'SYSTEM',
        actionRole: 'System',
        details: {
            recipientEmail,
            subject,
            deliveryStatus: status,
            messageId
        },
        correlationId
    });
}

async function logConflictResolution({
    documentId,
    conflictId = null,
    action,
    reviewerEmail = 'SYSTEM',
    previousStatus = 'Pending Review',
    newStatus = 'Succeeded',
    notes = '',
    correlationId = null
}) {
    return insertAuditLog({
        eventType: action === 'REJECT' ? 'CONFLICT_REJECTED' : 'CONFLICT_RESOLVED',
        documentId,
        conflictId,
        actionBy: reviewerEmail,
        actionRole: 'Reviewer',
        previousStatus,
        newStatus,
        details: {
            action,
            notes
        },
        correlationId
    });
}

async function logDocumentStatusChange({
    documentId,
    previousStatus,
    newStatus,
    reason = '',
    actionBy = 'SYSTEM',
    correlationId = null
}) {
    return insertAuditLog({
        eventType: 'DOCUMENT_STATUS_CHANGED',
        documentId,
        actionBy,
        actionRole: 'System',
        previousStatus,
        newStatus,
        details: { reason },
        correlationId
    });
}

module.exports = {
    logConflictDetected,
    logNotificationSent,
    logConflictResolution,
    logDocumentStatusChange,
    getAuditLogsForDocument
};

