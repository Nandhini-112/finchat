require('../utils/config');
const { app } = require('@azure/functions');
const {
    readPendingQueueItems,
    downloadDriveItemBuffer,
    updateQueueItemStatus
} = require('../services/sharepoint-queue');
const { processDocumentIngestion } = require('../services/ingestion-pipeline');
const { resolveDocumentKey, resolveQueueKey, blankToNull } = require('../services/search-document');
const {
    startIngestionRun,
    updateIngestionRunProgress,
    completeIngestionRun
} = require('../services/sql');

/// Dynamically bind schedule to environment variable %DOCUMENT_QUEUE_CRON% with fallback to monthly schedule
const timerSchedule = process.env.DOCUMENT_QUEUE_CRON ? process.env.DOCUMENT_QUEUE_CRON : '%DOCUMENT_QUEUE_CRON%';
const CONCURRENCY_LIMIT = 3;

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
        let batchRunId = null;
        const errors = [];

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

            // 2. Start consolidated Ingestion Run in Azure SQL outside the loop
            try {
                batchRunId = await startIngestionRun(pendingItems.length);
                context.log(`[QueueProcessor] Initialized batch IngestionRun ID=${batchRunId} for ${pendingItems.length} file(s).`);
            } catch (runErr) {
                context.warn?.(`[QueueProcessor] Failed to register IngestionRun in SQL: ${runErr.message}`);
            }

            // 3. Worker task for individual document processing
            async function processRecord(record, index) {
                const itemCorrelationId = `sp-ingest-${Date.now()}-${record.id}`;
                context.log(`[QueueProcessor] ========================================================`);
                context.log(`[QueueProcessor] === RETRIEVED SHAREPOINT RECORD [${index + 1}/${pendingItems.length}] ===`);
                context.log(`[QueueProcessor]   - SharePoint Item ID : ${record.id}`);
                context.log(`[QueueProcessor]   - File Name          : "${record.FileName}"`);
                context.log(`[QueueProcessor]   - Title              : "${record.Title || 'N/A'}"`);
                context.log(`[QueueProcessor]   - Processing Status  : "${record.ProcessingStatus}"`);
                context.log(`[QueueProcessor]   - Authority Rank     : ${record.AuthorityRank || 4}`);
                context.log(`[QueueProcessor]   - Modified Date      : ${record.ModifiedDate || 'N/A'}`);
                context.log(`[QueueProcessor]   - Modified By Email  : ${record.ModifiedByEmail || 'N/A'}`);
                context.log(`[QueueProcessor]   - Modified By Name   : ${record.ModifiedByName || 'N/A'}`);
                context.log(`[QueueProcessor]   - Department         : ${record.CreatedByDepartment || 'N/A'}`);
                context.log(`[QueueProcessor]   - Job Title          : ${record.CreatedByJobTitle || 'N/A'}`);
                context.log(`[QueueProcessor]   - Allowed User Groups: ${record.AllowedUserGroups || 'N/A'}`);
                context.log(`[QueueProcessor]   - Drive ID           : "${record.DriveId || 'N/A'}"`);
                context.log(`[QueueProcessor]   - Drive Item ID      : "${record.DriveItemId || 'N/A'}"`);
                context.log(`[QueueProcessor]   - File Link          : ${record.FileLink || 'N/A'}`);
                context.log(`[QueueProcessor]   - Document Key       : ${record.DocumentKey || 'N/A'}`);
                context.log(`[QueueProcessor]   - Queue Key          : ${record.QueueKey || 'N/A'}`);
                context.log(`[QueueProcessor] ========================================================`);

                try {
                    // Step 0: Immediate Concurrency Lock -> 'Processing'
                    // Prevents duplicate processing by concurrent timer invocations or scale-out instances
                    await updateQueueItemStatus(graphClient, siteId, listId, record.id, 'Processing');
                    context.log(`[QueueProcessor] Item ${record.id} locked as "Processing".`);

                    // Step 0B: Validate required metadata
                    if (!record.DriveId || !record.DriveItemId) {
                        throw new Error('Queue item is missing required DriveId or DriveItemId from SharePoint.');
                    }
                    if (!record.FileName || !record.FileName.trim()) {
                        throw new Error('Queue item has an empty or missing FileName.');
                    }

                    // Validate & sanitize Authority Rank (1 to 4)
                    let authorityRank = Number(record.AuthorityRank);
                    if (isNaN(authorityRank) || authorityRank < 1 || authorityRank > 4) {
                        authorityRank = 4;
                    }

                    // Step A: Download binary file content from SharePoint Drive
                    context.log(`[QueueProcessor] Downloading binary buffer from SharePoint DriveItem ${record.DriveItemId}...`);
                    const fileBuffer = await downloadDriveItemBuffer(graphClient, record.DriveId, record.DriveItemId);
                    context.log(`[QueueProcessor] Downloaded ${(fileBuffer.length / 1024).toFixed(1)} KB for "${record.FileName}".`);

                    // Step B: Run 10-step enterprise ingestion pipeline (linked to batchRunId)
                    const ingestionResult = await processDocumentIngestion({
                        fileBuffer,
                        fileName: record.FileName,
                        sourceType: 'SharePoint',
                        authorityRank,
                        allowedUserGroups: record.AllowedUserGroups || null,
                        correlationId: itemCorrelationId,
                        context,
                        existingRunId: batchRunId,
                        documentKey: resolveDocumentKey(record),
                        queueKey: resolveQueueKey(record),
                        fileLink: blankToNull(record.FileLink),
                        department: blankToNull(record.CreatedByDepartment),
                        jobTitle: blankToNull(record.CreatedByJobTitle),
                        modifiedDate: blankToNull(record.ModifiedDate),
                        modifiedByEmail: blankToNull(record.ModifiedByEmail),
                        modifiedByName: blankToNull(record.ModifiedByName)
                    });

                    // Step C: Update SharePoint Queue List Item status
                    if (ingestionResult.status === 'pending') {
                        const conflictMsg = ingestionResult.conflictSummary || 'Financial discrepancies detected requiring review.';
                        await updateQueueItemStatus(graphClient, siteId, listId, record.id, 'Pending Review', conflictMsg, true);
                        context.log(`[QueueProcessor] SharePoint List Item ${record.id} marked as "Pending Review" (ConflictDetected=Yes, DocumentId=${ingestionResult.documentId}).`);
                    } else {
                        await updateQueueItemStatus(graphClient, siteId, listId, record.id, 'Processed', '', false);
                        context.log(`[QueueProcessor] SharePoint List Item ${record.id} marked as "Processed" (ConflictDetected=No, DocumentId=${ingestionResult.documentId}).`);
                        processedCount++;
                    }

                    // Step D: Dynamically update IngestionRun progress in Azure SQL
                    if (batchRunId) {
                        await updateIngestionRunProgress(batchRunId, true).catch(e => {
                            context.warn?.(`[QueueProcessor] Failed to update IngestionRun progress (success): ${e.message}`);
                        });
                    }

                } catch (itemErr) {
                    context.error(`[QueueProcessor] Failed processing SharePoint file "${record.FileName}" (Item ${record.id}): ${itemErr.message}`);
                    if (itemErr.stack) {
                        context.error(`[QueueProcessor] Item error stack trace: ${itemErr.stack}`);
                    }

                    // Update SharePoint List Item status to 'Failed' with truncated error summary
                    await updateQueueItemStatus(graphClient, siteId, listId, record.id, 'Failed', itemErr.message).catch(e => {
                        context.error(`[QueueProcessor] Failed to update item status in SharePoint: ${e.message}`);
                    });

                    failedCount++;
                    errors.push(`${record.FileName}: ${itemErr.message}`);

                    // Step D: Dynamically update IngestionRun progress in Azure SQL
                    if (batchRunId) {
                        await updateIngestionRunProgress(batchRunId, false, `${record.FileName}: ${itemErr.message}`).catch(e => {
                            context.warn?.(`[QueueProcessor] Failed to update IngestionRun progress (failure): ${e.message}`);
                        });
                    }
                }
            }

            // 4. Launch concurrent async worker pool (concurrency = 3)
            let cursor = 0;
            const poolSize = Math.min(CONCURRENCY_LIMIT, pendingItems.length);
            context.log(`[QueueProcessor] Spawning worker pool: ${poolSize} concurrent worker(s) for ${pendingItems.length} file(s)...`);

            const workers = Array.from({ length: poolSize }, async () => {
                while (cursor < pendingItems.length) {
                    const currentIndex = cursor++;
                    await processRecord(pendingItems[currentIndex], currentIndex);
                }
            });

            await Promise.all(workers);

            // 5. Finalize batch IngestionRun status in Azure SQL
            if (batchRunId) {
                const overallStatus = failedCount === 0 ? 'Succeeded' : (processedCount === 0 ? 'Failed' : 'CompletedWithErrors');
                const summary = errors.length > 0 ? errors.slice(0, 5).join(' | ') : null;
                await completeIngestionRun(batchRunId, processedCount, failedCount, overallStatus, summary).catch(e => {
                    context.warn?.(`[QueueProcessor] Failed to complete IngestionRun in SQL: ${e.message}`);
                });
            }

        } catch (error) {
            context.error(`[QueueProcessorError] Queue processing cycle failed: ${error.message}`);
            if (batchRunId) {
                await completeIngestionRun(batchRunId, processedCount, failedCount, 'Failed', error.message).catch(() => null);
            }
        }

        context.log(`[QueueProcessor] Queue cycle finished. Succeeded=${processedCount}, Failed=${failedCount}.`);
    }
});
