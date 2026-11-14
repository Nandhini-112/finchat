require('../src/utils/config');
const {
    readPendingQueueItems,
    validateQueueConfig,
    createGraphCredential,
    getGraphClient,
    resolveSite,
    resolveList
} = require('../src/services/sharepoint-queue');

async function inspectSharePointQueue() {
    console.log('\n========================================================');
    console.log('🔍 FINCHAT SHAREPOINT QUEUE INSPECTION TOOL');
    console.log('========================================================\n');

    let config;
    try {
        config = validateQueueConfig();
        console.log(`[Config Check] SharePoint Site: ${config.siteUrl}`);
        console.log(`[Config Check] Queue List Name: ${config.queueListName}`);
        console.log(`[Config Check] Tenant ID:       ${config.tenantId}`);
        console.log(`[Config Check] Client ID:       ${config.clientId}`);
    } catch (cfgErr) {
        console.error(`❌ Configuration Error: ${cfgErr.message}`);
        console.log('Please ensure TENANT_ID, CLIENT_ID, CLIENT_SECRET, SHAREPOINT_SITE_URL, and SHAREPOINT_QUEUE_LIST are configured in .env or local.settings.json.\n');
        process.exitCode = 1;
        return;
    }

    try {
        console.log('\n[Step 1] Connecting to Microsoft Graph and reading queue items...');
        const queueData = await readPendingQueueItems(console);
        const { items, siteId, listId, graphClient } = queueData;

        console.log(`\n✅ Connected successfully to site (ID: ${siteId}), list (ID: ${listId})`);
        console.log(`Found ${items.length} Pending item(s) in queue.\n`);

        if (items.length > 0) {
            console.log('--------------------------------------------------------');
            console.log('📋 PENDING QUEUE ITEMS (READY FOR INGESTION):');
            console.log('--------------------------------------------------------');
            items.forEach((item, idx) => {
                console.log(`\n[Item ${idx + 1}/${items.length}] SharePoint List Item ID: ${item.id}`);
                console.log(`  - File Name          : "${item.FileName}"`);
                console.log(`  - Title              : "${item.Title || 'N/A'}"`);
                console.log(`  - Processing Status  : "${item.ProcessingStatus}"`);
                console.log(`  - Authority Rank     : ${item.AuthorityRank} (1=Audited, 2=Final, 3=Draft, 4=Sample)`);
                console.log(`  - Modified Date      : ${item.ModifiedDate || 'N/A'}`);
                console.log(`  - Modified By Email  : ${item.ModifiedByEmail || 'N/A'}`);
                console.log(`  - Modified By Name   : ${item.ModifiedByName || 'N/A'}`);
                console.log(`  - Department         : ${item.CreatedByDepartment || 'N/A'}`);
                console.log(`  - Job Title          : ${item.CreatedByJobTitle || 'N/A'}`);
                console.log(`  - Allowed User Groups: ${item.AllowedUserGroups || 'N/A'}`);
                console.log(`  - Drive ID           : "${item.DriveId || 'N/A'}"`);
                console.log(`  - Drive Item ID      : "${item.DriveItemId || 'N/A'}"`);
                console.log(`  - File Link          : ${item.FileLink || 'N/A'}`);
                console.log(`  - Document Key       : ${item.DocumentKey || 'N/A'}`);
                console.log(`  - Queue Key          : ${item.QueueKey || 'N/A'}`);
            });
        } else {
            console.log('Notice: No items currently have ProcessingStatus = "Pending" (or blank).');
            console.log('Fetching the latest items in the list to inspect current statuses and field names...\n');

            const allRes = await graphClient
                .api(`/sites/${siteId}/lists/${listId}/items`)
                .expand('fields')
                .top(100)
                .get();

            const allListItems = allRes.value || [];
            console.log(`Total items retrieved from list: ${allListItems.length}`);

            // Sort descending by ID to show the newest uploaded items first
            allListItems.sort((a, b) => Number(b.id) - Number(a.id));
            const latestItems = allListItems.slice(0, 10);

            console.log(`Displaying the ${latestItems.length} latest item(s) in SharePoint:\n`);

            latestItems.forEach((raw, idx) => {
                const f = raw.fields || {};
                console.log(`[Latest Item ${idx + 1}] SharePoint ID: ${raw.id}`);
                console.log(`  - Title / File Name  : "${f.FileLeafRef || f.FileName || f.Title || 'N/A'}"`);
                console.log(`  - ProcessingStatus   : "${f.ProcessingStatus || '(empty/blank)'}"`);
                console.log(`  - ConflictDetected   : ${f.ConflictDetected !== undefined ? f.ConflictDetected : 'N/A'}`);
                console.log(`  - AuthorityRank      : ${f.AuthorityRank || 'N/A'}`);
                console.log(`  - Modified By (Graph): ${raw.lastModifiedBy?.user?.displayName || raw.lastModifiedBy?.user?.email || 'N/A'}`);
                console.log(`  - Modified Date      : ${f.Modified || f.ModifiedDate || raw.lastModifiedDateTime || 'N/A'}`);
                console.log(`  - ErrorSummary       : "${f.ErrorSummary || 'None'}"`);
                console.log(`  - All Field Names    : [${Object.keys(f).slice(0, 15).join(', ')}]\n`);
            });
        }

        console.log('\n========================================================');
        console.log('✅ Inspection completed successfully.');
        console.log('========================================================\n');

    } catch (err) {
        console.error(`\n❌ Inspection Failed: ${err.message}`);
        if (err.stack) console.error(err.stack);
        process.exitCode = 1;
    }
}

inspectSharePointQueue();

