require('../utils/config');
const { app } = require('@azure/functions');
const {
    readPendingQueueItems,
    downloadDriveItemBuffer,
    updateQueueItemStatus
} = require('../services/sharepoint-queue');
const { processDocumentIngestion } = require('../services/ingestion-pipeline');

// Dynamically bind schedule to environment variable %DOCUMENT_QUEUE_CRON% with fallback to monthly schedule
const timerSchedule = process.env.DOCUMENT_QUEUE_CRON ? process.env.DOCUMENT_QUEUE_CRON : '%DOCUMENT_QUEUE_CRON%';

app.timer('processDocumentQueue', {
    schedule: timerSchedule,
    handler: async (myTimer, context) => {
        const timeStamp = new Date().toISOString();
        context.log(`[QueueProcessor] Monthly/Scheduled Timer triggered at: ${timeStamp}`);

        if (myTimer.isPastDue) {
            context.log('[QueueProcessor] Notice: Timer schedule is running past due.');
        }

        let processedCount = 0;
        let failedCount = 0;

        try {
            // 1. Fetch pending document records from SharePoint queue list
            const queueData = await readPendingQueueItems(context);
            const { graphClient, siteId, listId, items } = queueData;
            const pendingItems = items || [];

            context.log(`[QueueProcessor] Found ${pendingItems.length} pending record(s) in SharePoint queue list.`);

            if (pendingItems.length === 0) {
                context.log('[QueueProcessor] No pending documents to ingest.');
                return;
            }

            // 2. Process each queued file end-to-end
            for (const [index, record] of pendingItems.entries()) {
                const itemCorrelationId = `sp-ingest-${Date.now()}-${record.id}`;
                context.log(
                    `[QueueProcessor] [Item ${index + 1}/${pendingItems.length}] ` +
                    `FileName: "${record.FileName}", ` +
                    `DriveId: "${record.DriveId}", ` +
                    `ItemId: "${record.DriveItemId}", ` +
                    `Rank: ${record.AuthorityRank || 4}`
                );

                try {
                    // Step A: Download binary file content from SharePoint Drive
                    context.log(`[QueueProcessor] Downloading binary buffer from SharePoint DriveItem ${record.DriveItemId}...`);
                    const fileBuffer = await downloadDriveItemBuffer(graphClient, record.DriveId, record.DriveItemId);
                    context.log(`[QueueProcessor] Downloaded ${(fileBuffer.length / 1024).toFixed(1)} KB for "${record.FileName}".`);

                    // Step B: Run 10-step enterprise ingestion pipeline
                    const ingestionResult = await processDocumentIngestion({
                        fileBuffer,
                        fileName: record.FileName,
                        sourceType: 'SharePoint',
                        authorityRank: record.AuthorityRank || 4,
                        allowedUserGroups: record.AllowedUserGroups || null,
                        correlationId: itemCorrelationId,
                        context
                    });

                    // Step C: Update SharePoint Queue List Item status to 'Processed'
                    await updateQueueItemStatus(graphClient, siteId, listId, record.id, 'Processed', '');
                    context.log(`[QueueProcessor] SharePoint List Item ${record.id} marked as "Processed" (DocumentId=${ingestionResult.documentId}).`);
                    processedCount++;

                } catch (itemErr) {
                    context.error(`[QueueProcessor] Failed processing SharePoint file "${record.FileName}" (Item ${record.id}): ${itemErr.message}`);

                    // Update SharePoint List Item status to 'Failed' with error summary
                    await updateQueueItemStatus(graphClient, siteId, listId, record.id, 'Failed', itemErr.message).catch(e => {
                        context.error(`[QueueProcessor] Failed to update item status in SharePoint: ${e.message}`);
                    });

                    failedCount++;
                }
            }

        } catch (error) {
            context.error(`[QueueProcessorError] Queue processing cycle failed: ${error.message}`);
        }

        context.log(`[QueueProcessor] Queue cycle finished. Succeeded=${processedCount}, Failed=${failedCount}.`);
    }
});
