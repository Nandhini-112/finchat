const { ClientSecretCredential } = require('@azure/identity');
const { Client, ResponseType } = require('@microsoft/microsoft-graph-client');
const { TokenCredentialAuthenticationProvider } = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');
const { sanitizeErrorMessage } = require('../utils/errors');

/**
 * Validates and extracts required environment variables.
 */
function validateQueueConfig() {
    const required = [
        'TENANT_ID',
        'CLIENT_ID',
        'CLIENT_SECRET',
        'SHAREPOINT_SITE_URL',
        'SHAREPOINT_QUEUE_LIST'
    ];

    const missing = required.filter(key => !process.env[key] || !process.env[key].trim());
    if (missing.length > 0) {
        throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
    }

    return {
        tenantId: process.env.TENANT_ID.trim(),
        clientId: process.env.CLIENT_ID.trim(),
        clientSecret: process.env.CLIENT_SECRET.trim(),
        siteUrl: process.env.SHAREPOINT_SITE_URL.trim(),
        queueListName: process.env.SHAREPOINT_QUEUE_LIST.trim()
    };
}

/**
 * Initializes Microsoft Graph client using @azure/identity ClientSecretCredential.
 */
function getGraphClient(tenantId, clientId, clientSecret) {
    try {
        const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
        const authProvider = new TokenCredentialAuthenticationProvider(credential, {
            scopes: ['https://graph.microsoft.com/.default']
        });
        return Client.initWithMiddleware({ authProvider });
    } catch (err) {
        throw new Error(`Authentication initialization failure: ${sanitizeErrorMessage(err.message)}`);
    }
}

/**
 * Resolves a SharePoint site from its URL using Microsoft Graph.
 */
async function resolveSite(graphClient, siteUrl) {
    let parsedUrl;
    try {
        parsedUrl = new URL(siteUrl);
    } catch (err) {
        throw new Error(`Site lookup failure: Invalid SHAREPOINT_SITE_URL format "${siteUrl}". ${err.message}`);
    }

    const hostname = parsedUrl.hostname;
    const serverRelativePath = parsedUrl.pathname.replace(/\/+$/, '');
    const siteResource = `/sites/${hostname}:${serverRelativePath}`;

    try {
        const site = await graphClient.api(siteResource).get();
        if (!site || !site.id) {
            throw new Error(`Site lookup failure: Site resource "${siteResource}" did not return a valid site ID.`);
        }
        return site;
    } catch (err) {
        const safeMsg = sanitizeErrorMessage(err.message || 'Unknown error');
        const status = err.statusCode || err.status || 'unknown';

        if (safeMsg.includes('AADSTS7000215')) {
            throw new Error(`Authentication failure: Invalid client secret provided (AADSTS7000215). Please verify that CLIENT_SECRET contains the secret 'Value', not the 'Secret ID'.`);
        }
        if (safeMsg.includes('AADSTS')) {
            throw new Error(`Authentication failure: Entra ID rejected the credential: ${safeMsg}`);
        }

        throw new Error(`Site lookup failure: Unable to resolve SharePoint site at "${siteUrl}" (Status: ${status}): ${safeMsg}`);
    }
}

/**
 * Resolves the SharePoint queue list within the site.
 */
async function resolveList(graphClient, siteId, listName, siteUrl) {
    try {
        return await graphClient.api(`/sites/${siteId}/lists/${encodeURIComponent(listName)}`).get();
    } catch (directErr) {
        try {
            const response = await graphClient.api(`/sites/${siteId}/lists`).get();
            const lists = response.value || [];
            const found = lists.find(
                l => (l.displayName && l.displayName.toLowerCase() === listName.toLowerCase()) ||
                     (l.name && l.name.toLowerCase() === listName.toLowerCase()) ||
                     l.id === listName
            );

            if (!found) {
                const available = lists.map(l => `"${l.displayName || l.name}"`).join(', ');
                throw new Error(`List lookup failure: List "${listName}" not found in site "${siteUrl}". Available lists: [${available}]`);
            }
            return found;
        } catch (fallbackErr) {
            if (fallbackErr.message && fallbackErr.message.startsWith('List lookup failure:')) {
                throw fallbackErr;
            }
            const safeMsg = sanitizeErrorMessage(fallbackErr.message);
            throw new Error(`List lookup failure: Unable to query lists for site "${siteUrl}": ${safeMsg}`);
        }
    }
}

/**
 * Queries SharePoint list items with ProcessingStatus eq 'Pending'.
 */
async function getPendingQueueItems(graphClient, siteId, listId, listName) {
    const selectFields = [
        'Title',
        'FileName',
        'DriveId',
        'DriveItemId',
        'FilePath',
        'FileIdentifier',
        'FileVersion',
        'ProcessingStatus',
        'AuthorityRank',
        'AllowedUserGroups'
    ];

    let response;
    try {
        response = await graphClient
            .api(`/sites/${siteId}/lists/${listId}/items`)
            .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
            .expand(`fields($select=${selectFields.join(',')})`)
            .filter("fields/ProcessingStatus eq 'Pending'")
            .get();
    } catch (queryErr) {
        if (queryErr.statusCode === 400 && queryErr.message && queryErr.message.includes('select')) {
            try {
                response = await graphClient
                    .api(`/sites/${siteId}/lists/${listId}/items`)
                    .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly')
                    .expand('fields')
                    .filter("fields/ProcessingStatus eq 'Pending'")
                    .get();
            } catch (retryErr) {
                const safeMsg = sanitizeErrorMessage(retryErr.message);
                const status = retryErr.statusCode || retryErr.status || 'unknown';
                const bodyStr = retryErr.body ? sanitizeErrorMessage(JSON.stringify(retryErr.body)) : '';
                throw new Error(`Queue query failure: Failed to retrieve Pending items from list "${listName}" (Status: ${status}): ${safeMsg}${bodyStr ? ` - Details: ${bodyStr}` : ''}`);
            }
        } else {
            const safeMsg = sanitizeErrorMessage(queryErr.message);
            const status = queryErr.statusCode || queryErr.status || 'unknown';
            const bodyStr = queryErr.body ? sanitizeErrorMessage(JSON.stringify(queryErr.body)) : '';
            throw new Error(`Queue query failure: Failed to retrieve Pending items from list "${listName}" (Status: ${status}): ${safeMsg}${bodyStr ? ` - Details: ${bodyStr}` : ''}`);
        }
    }

    const items = (response && response.value) || [];

    return items.map(item => {
        const fields = item.fields || {};
        const getVal = (name) => {
            if (fields[name] !== undefined && fields[name] !== null) {
                return fields[name];
            }
            const lower = name.toLowerCase();
            const matchedKey = Object.keys(fields).find(k => k.toLowerCase() === lower);
            return (matchedKey && fields[matchedKey] !== undefined && fields[matchedKey] !== null)
                ? fields[matchedKey]
                : '';
        };

        return {
            id: item.id,
            Title: getVal('Title'),
            FileName: getVal('FileName'),
            DriveId: getVal('DriveId'),
            DriveItemId: getVal('DriveItemId'),
            FilePath: getVal('FilePath'),
            FileIdentifier: getVal('FileIdentifier'),
            FileVersion: getVal('FileVersion'),
            ProcessingStatus: getVal('ProcessingStatus'),
            AuthorityRank: Number(getVal('AuthorityRank')) || 4,
            AllowedUserGroups: getVal('AllowedUserGroups') || null
        };
    });
}

/**
 * Downloads binary buffer of a file from SharePoint Drive using Microsoft Graph.
 */
async function downloadDriveItemBuffer(graphClient, driveId, driveItemId) {
    if (!driveId || !driveItemId) {
        throw new Error('Both driveId and driveItemId are required to download file content.');
    }
    const endpoint = `/drives/${driveId}/items/${driveItemId}/content`;
    const arrayBuffer = await graphClient.api(endpoint).responseType(ResponseType.ARRAYBUFFER).get();
    return Buffer.from(arrayBuffer);
}

/**
 * Updates a SharePoint list item's ProcessingStatus and ErrorSummary.
 */
async function updateQueueItemStatus(graphClient, siteId, listId, listItemId, status, errorSummary = '') {
    const endpoint = `/sites/${siteId}/lists/${listId}/items/${listItemId}/fields`;
    await graphClient.api(endpoint).patch({
        ProcessingStatus: status,
        ErrorSummary: errorSummary ? String(errorSummary).slice(0, 500) : ''
    });
}

/**
 * Main coordinator function to validate, authenticate, resolve site and list,
 * and read pending items from the SharePoint queue.
 */
async function readPendingQueueItems(context) {
    const config = validateQueueConfig();
    const graphClient = getGraphClient(config.tenantId, config.clientId, config.clientSecret);
    const site = await resolveSite(graphClient, config.siteUrl);
    const list = await resolveList(graphClient, site.id, config.queueListName, config.siteUrl);
    const items = await getPendingQueueItems(graphClient, site.id, list.id, config.queueListName);

    return {
        config,
        graphClient,
        siteId: site.id,
        listId: list.id,
        items
    };
}

module.exports = {
    validateQueueConfig,
    getGraphClient,
    resolveSite,
    resolveList,
    getPendingQueueItems,
    downloadDriveItemBuffer,
    updateQueueItemStatus,
    readPendingQueueItems
};
