require('../utils/config');
const { app } = require('@azure/functions');
const { readPendingQueueItems } = require('../services/sharepoint-queue');

// Dynamically bind schedule to environment variable %DOCUMENT_QUEUE_CRON% with fallback
const timerSchedule = process.env.DOCUMENT_QUEUE_CRON ? process.env.DOCUMENT_QUEUE_CRON : '%DOCUMENT_QUEUE_CRON%';

app.timer('processDocumentQueue', {
    schedule: timerSchedule,
    handler: async (myTimer, context) => {
        const timeStamp = new Date().toISOString();
        context.log(`[QueueProcessor] Timer triggered at: ${timeStamp}`);

        // Prevent execution overlap if previous invocation is still running
        if (myTimer.isPastDue) {
            context.log('[QueueProcessor] Notice: Timer schedule is running past due.');
        }

        try {
            // 1. Fetch pending document records from SharePoint queue list
            const pendingItems = await readPendingQueueItems(context);
            context.log(`[QueueProcessor] Found ${pendingItems.length} pending record(s) in queue.`);

            if (pendingItems.length === 0) {
                context.log('[QueueProcessor] No pending documents to ingest.');
                return;
            }

            // 2. Process each queued file
            for (const [index, record] of pendingItems.entries()) {
                context.log(
                    `[QueueProcessor] [Item ${index + 1}/${pendingItems.length}] ` +
                    `FileName: "${record.FileName}", ` +
                    `DriveId: "${record.DriveId}", ` +
                    `ItemId: "${record.DriveItemId}", ` +
                    `Status: "${record.ProcessingStatus}"`
                );

                // Document binary download and processing is invoked here
            }
        } catch (error) {
            context.error(`[QueueProcessorError] Queue processing failed: ${error.message}`);
        }

        context.log('[QueueProcessor] Queue processing cycle finished.');
    }
});
