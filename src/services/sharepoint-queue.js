const { ClientSecretCredential } = require('@azure/identity');
const { Client, ResponseType } = require('@microsoft/microsoft-graph-client');
const {
    TokenCredentialAuthenticationProvider
} = require('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials');
const { randomUUID } = require('crypto');
const { sanitizeErrorMessage } = require('../utils/errors');

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

const VALID_GRAPH_AUDIENCES = [
    'https://graph.microsoft.com',
    '00000003-0000-0000-c000-000000000000'
];

/**
 * Validate required environment variables.
 */
function validateQueueConfig() {
    const required = [
        'TENANT_ID',
        'CLIENT_ID',
        'CLIENT_SECRET',
        'SHAREPOINT_SITE_URL',
        'SHAREPOINT_QUEUE_LIST'
    ];

    const missing = required.filter(
        key => !process.env[key] || !process.env[key].trim()
    );

    if (missing.length) {
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}`
        );
    }

    const siteUrl = process.env.SHAREPOINT_SITE_URL.trim();

    let parsedUrl;

    try {
        parsedUrl = new URL(siteUrl);
    } catch {
        throw new Error('Invalid SHAREPOINT_SITE_URL.');
    }

    if (
        parsedUrl.protocol !== 'https:' ||
        !parsedUrl.hostname.toLowerCase().endsWith('.sharepoint.com') ||
        parsedUrl.search ||
        parsedUrl.hash
    ) {
        throw new Error(
            'SHAREPOINT_SITE_URL must be a valid HTTPS SharePoint site URL.'
        );
    }

    return {
        tenantId: process.env.TENANT_ID.trim(),
        clientId: process.env.CLIENT_ID.trim(),
        clientSecret: process.env.CLIENT_SECRET.trim(),
        siteUrl,
        queueListName: process.env.SHAREPOINT_QUEUE_LIST.trim()
    };
}

/**
 * Create Microsoft Entra application credential.
 */
function createGraphCredential(config) {
    return new ClientSecretCredential(
        config.tenantId,
        config.clientId,
        config.clientSecret
    );
}

/**
 * Obtain Microsoft Graph access token.
 */
async function getGraphAccessToken(credential) {
    try {
        const tokenResponse = await credential.getToken(GRAPH_SCOPE);

        if (!tokenResponse?.token) {
            throw new Error(
                'Microsoft Graph access token was not returned.'
            );
        }

        return tokenResponse;
    } catch (error) {
        throw new Error(
            `Graph token acquisition failed: ${sanitizeErrorMessage(error.message)}`
        );
    }
}

/**
 * Decode JWT claims for diagnostics.
 *
 * IMPORTANT:
 * This only decodes the token for debugging.
 * It does not validate the JWT signature.
 * Never log the actual access token or client secret.
 */
function getTokenDiagnostics(token, config) {
    const parts = token.split('.');

    if (parts.length !== 3) {
        throw new Error(
            'Unexpected Microsoft Graph token format.'
        );
    }

    let header;
    let claims;

    try {
        header = JSON.parse(
            Buffer.from(parts[0], 'base64url').toString('utf8')
        );

        claims = JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf8')
        );
    } catch {
        throw new Error(
            'Unable to decode Microsoft Graph JWT claims.'
        );
    }

    const tokenClientId = claims.appid || claims.azp;

    const rolesClaim =
        claims.roles ??
        claims.role ??
        claims[
        'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'
        ];

    const applicationRoles = Array.isArray(rolesClaim)
        ? rolesClaim
        : typeof rolesClaim === 'string'
            ? [rolesClaim]
            : [];

    return {
        tokenType: 'JWT',

        algorithm: header.alg || 'Unavailable',

        tokenVersion: claims.ver || 'Unavailable',

        tenantMatches: claims.tid === config.tenantId,

        clientMatches: tokenClientId === config.clientId,

        tenantId: claims.tid || 'Unavailable',

        clientId: tokenClientId || 'Unavailable',

        audience: claims.aud || 'Unavailable',

        issuer: claims.iss || 'Unavailable',

        identityType: claims.idtyp || 'Unavailable',

        applicationRoles,

        rolesClaimExists: rolesClaim !== undefined,

        rolesClaimType: Array.isArray(rolesClaim)
            ? 'array'
            : typeof rolesClaim,

        delegatedScopes: claims.scp || null,

        expiresAt: claims.exp
            ? new Date(claims.exp * 1000).toISOString()
            : 'Unavailable',

        claimNames: Object.keys(claims)
    };
}

/**
 * Log safe token diagnostics.
 */
function logTokenDiagnostics(context, diagnostics) {
    context?.log?.(
        '========== GRAPH TOKEN DIAGNOSTICS =========='
    );

    context?.log?.(
        `Token tenant matches: ${diagnostics.tenantMatches}`
    );

    context?.log?.(
        `Token client ID matches: ${diagnostics.clientMatches}`
    );

    context?.log?.(
        `Token tenant ID: ${diagnostics.tenantId}`
    );

    context?.log?.(
        `Token client ID: ${diagnostics.clientId}`
    );

    context?.log?.(
        `Token audience: ${diagnostics.audience}`
    );

    context?.log?.(
        `Token issuer: ${diagnostics.issuer}`
    );

    context?.log?.(
        `Token version: ${diagnostics.tokenVersion}`
    );

    context?.log?.(
        `Token identity type: ${diagnostics.identityType}`
    );

    context?.log?.(
        `Roles claim exists: ${diagnostics.rolesClaimExists}`
    );

    context?.log?.(
        `Roles claim type: ${diagnostics.rolesClaimType}`
    );

    context?.log?.(
        `Actual application roles: ${JSON.stringify(diagnostics.applicationRoles)}`
    );

    context?.log?.(
        `Available JWT claim names: ${JSON.stringify(diagnostics.claimNames)}`
    );

    context?.log?.(
        `Delegated scopes: ${diagnostics.delegatedScopes || 'None'}`
    );

    context?.log?.(
        `Token expiry: ${diagnostics.expiresAt}`
    );

    context?.log?.(
        '============================================'
    );
}

/**
 * Create Microsoft Graph SDK client.
 */
function getGraphClient(
    credentialOrTenantId,
    clientId,
    clientSecret
) {
    const credential =
        credentialOrTenantId &&
            typeof credentialOrTenantId.getToken === 'function'
            ? credentialOrTenantId
            : new ClientSecretCredential(
                credentialOrTenantId,
                clientId,
                clientSecret
            );

    const authProvider =
        new TokenCredentialAuthenticationProvider(
            credential,
            {
                scopes: [GRAPH_SCOPE]
            }
        );

    return Client.initWithMiddleware({
        authProvider
    });
}

/**
 * Convert SharePoint site URL into Microsoft Graph site endpoint.
 *
 * Example:
 * https://idealtechlab.sharepoint.com/sites/ITL-Trainee
 *
 * Graph:
 * /sites/idealtechlab.sharepoint.com:/sites/ITL-Trainee
 */
function getSiteGraphPath(siteUrl) {
    const parsedUrl = new URL(siteUrl);

    const hostname = parsedUrl.hostname;

    const serverRelativePath =
        parsedUrl.pathname.replace(/\/+$/, '');

    if (
        !serverRelativePath ||
        serverRelativePath === '/'
    ) {
        throw new Error(
            'Provide the actual SharePoint site URL, not the tenant root URL.'
        );
    }

    const encodedPath = serverRelativePath
        .split('/')
        .filter(Boolean)
        .map(segment => encodeURIComponent(segment))
        .join('/');

    return `/sites/${hostname}:/${encodedPath}`;
}

/**
 * Perform direct Microsoft Graph GET request.
 */
async function graphFetch(url, accessToken, context) {
    const clientRequestId = randomUUID();

    let response;

    try {
        response = await fetch(url, {
            method: 'GET',

            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                'client-request-id': clientRequestId,
                'return-client-request-id': 'true'
            }
        });
    } catch (error) {
        throw new Error(
            `Graph network request failed: ${sanitizeErrorMessage(error.message)}. Client Request ID: ${clientRequestId}`
        );
    }

    const responseText = await response.text();

    let body = {};

    try {
        body = responseText
            ? JSON.parse(responseText)
            : {};
    } catch {
        body = {
            rawResponse: responseText
        };
    }

    const result = {
        ok: response.ok,

        status: response.status,

        body,

        requestId:
            response.headers.get('request-id') ||
            'Unavailable',

        clientRequestId:
            response.headers.get('client-request-id') ||
            clientRequestId,

        wwwAuthenticate:
            response.headers.get('www-authenticate') ||
            'Unavailable'
    };

    context?.log?.(
        `Graph HTTP status: ${result.status}`
    );

    context?.log?.(
        `Graph request ID: ${result.requestId}`
    );

    context?.log?.(
        `Graph client request ID: ${result.clientRequestId}`
    );

    context?.log?.(
        `Graph WWW-Authenticate: ${result.wwwAuthenticate}`
    );

    if (!result.ok) {
        context?.log?.(
            `Graph error response: ${JSON.stringify(
                result.body?.error || result.body
            )}`
        );
    }

    return result;
}

/**
 * Resolve SharePoint site using Graph.
 */
async function resolveSite(
    graphClient,
    siteUrl,
    credential,
    context
) {
    let sitePath;

    try {
        sitePath = getSiteGraphPath(siteUrl);
    } catch (error) {
        throw new Error(
            `Invalid SharePoint site URL: ${sanitizeErrorMessage(error.message)}`
        );
    }

    const graphUrl = `${GRAPH_BASE_URL}${sitePath}`;

    context?.log?.(
        `Configured SharePoint site: ${siteUrl}`
    );

    context?.log?.(
        `SharePoint Graph endpoint: ${graphUrl}`
    );

    try {
        if (credential) {
            // Obtain a fresh token through the configured credential.
            const tokenResponse =
                await getGraphAccessToken(credential);

            const diagnostics = getTokenDiagnostics(
                tokenResponse.token,
                {
                    tenantId: process.env.TENANT_ID.trim(),
                    clientId: process.env.CLIENT_ID.trim()
                }
            );

            // Print safe diagnostic information.
            logTokenDiagnostics(
                context,
                diagnostics
            );

            if (!diagnostics.tenantMatches) {
                throw new Error(
                    'Graph token tenant does not match TENANT_ID.'
                );
            }

            if (!diagnostics.clientMatches) {
                throw new Error(
                    'Graph token application does not match CLIENT_ID.'
                );
            }

            if (
                !VALID_GRAPH_AUDIENCES.includes(
                    diagnostics.audience
                )
            ) {
                throw new Error(
                    `Unexpected Graph token audience: ${diagnostics.audience}`
                );
            }

            // This is the actual authorization test.
            // Do not rely only on decoded JWT claims.
            const result = await graphFetch(
                graphUrl,
                tokenResponse.token,
                context
            );

            if (!result.ok) {
                const graphError =
                    result.body?.error || {};

                throw new Error(
                    `Microsoft Graph site lookup failed. ` +
                    `HTTP Status: ${result.status}; ` +
                    `Code: ${graphError.code || 'Unknown'}; ` +
                    `Message: ${sanitizeErrorMessage(
                        graphError.message ||
                        'No Graph error message'
                    )}; ` +
                    `Request ID: ${result.requestId}; ` +
                    `Client Request ID: ${result.clientRequestId}; ` +
                    `WWW-Authenticate: ${sanitizeErrorMessage(
                        result.wwwAuthenticate
                    )}`
                );
            }

            if (!result.body?.id) {
                throw new Error(
                    'Graph returned success but no SharePoint site ID.'
                );
            }

            context?.log?.(
                `SharePoint site resolved successfully: ${result.body.displayName ||
                result.body.name ||
                result.body.id
                }`
            );

            return result.body;
        }

        // Fallback: use Graph SDK authentication provider.
        const site = await graphClient
            .api(sitePath)
            .get();

        if (!site?.id) {
            throw new Error(
                'Graph did not return a valid SharePoint site ID.'
            );
        }

        return site;

    } catch (error) {
        throw new Error(
            `Site lookup failure: Unable to resolve SharePoint site at "${siteUrl}". ${sanitizeErrorMessage(error.message)}`
        );
    }
}

/**
 * Resolve queue list by display name or internal name.
 */
async function resolveList(
    graphClient,
    siteId,
    listName,
    siteUrl
) {
    try {
        const response = await graphClient
            .api(`/sites/${siteId}/lists`)
            .top(200)
            .get();

        const lists = response.value || [];

        const found = lists.find(list =>
            (list.displayName || '')
                .toLowerCase() === listName.toLowerCase() ||

            (list.name || '')
                .toLowerCase() === listName.toLowerCase() ||

            list.id === listName
        );

        if (!found) {
            const available = lists
                .map(list =>
                    `"${list.displayName || list.name}"`
                )
                .join(', ');

            throw new Error(
                `Queue list "${listName}" was not found in "${siteUrl}". Available lists: [${available}]`
            );
        }

        return found;

    } catch (error) {
        throw new Error(
            `List lookup failure: ${sanitizeErrorMessage(error.message)}`
        );
    }
}

/**
 * Retrieve all pages from a Graph collection.
 */
async function getAllPages(graphClient, request) {
    let response = await request.get();

    const results = [
        ...(response.value || [])
    ];

    while (response['@odata.nextLink']) {
        response = await graphClient
            .api(response['@odata.nextLink'])
            .get();

        results.push(
            ...(response.value || [])
        );
    }

    return results;
}

/**
 * Read a SharePoint field safely.
 */
function getField(fields, name) {
    if (!fields) {
        return '';
    }

    if (
        fields[name] !== undefined &&
        fields[name] !== null
    ) {
        return fields[name];
    }

    const matchedKey = Object.keys(fields).find(
        key => key.toLowerCase() === name.toLowerCase()
    );

    return matchedKey &&
        fields[matchedKey] !== undefined &&
        fields[matchedKey] !== null
        ? fields[matchedKey]
        : '';
}

/**
 * Retrieve Pending queue items.
 */
async function getPendingQueueItems(
    graphClient,
    siteId,
    listId,
    listName,
    listDriveId = null
) {
    let items;

    try {
        items = await getAllPages(
            graphClient,

            graphClient
                .api(
                    `/sites/${siteId}/lists/${listId}/items`
                )
                .expand('fields')
                .top(200)
        );

    } catch (error) {
        throw new Error(
            `Queue query failure: Unable to retrieve items from "${listName}". ${sanitizeErrorMessage(error.message)}`
        );
    }

    const mappedItems = items
        .map(item => {
            const fields = item.fields || {};

            return {
                id: item.id,

                Title: getField(fields, 'Title'),

                FileName: (() => {
                    const rawFn = getField(fields, 'FileName') || 
                                  getField(fields, 'FileLeafRef') || 
                                  getField(fields, 'Title') || '';
                    try {
                        return decodeURIComponent(rawFn);
                    } catch (_) {
                        return rawFn;
                    }
                })(),

                DriveId: getField(fields, 'DriveId') || listDriveId || '',

                DriveItemId: getField(fields, 'DriveItemId'),

                FilePath: getField(fields, 'FilePath') || getField(fields, 'FileRef') || '',

                FileIdentifier: getField(fields, 'FileIdentifier'),

                FileVersion: getField(fields, 'FileVersion'),

                DocumentKey: getField(fields, 'DocumentKey'),

                QueueKey: getField(fields, 'QueueKey'),

                FileLink: getField(fields, 'FileLinkText') || getField(fields, 'FileLink'),

                ModifiedDate: getField(fields, 'ModifiedDate'),

                CreatedByDepartment: getField(fields, 'CreatedByDepartment'),

                CreatedByJobTitle: getField(fields, 'CreatedByJobTitle'),

                ProcessingStatus: getField(
                    fields,
                    'ProcessingStatus'
                ),

                AuthorityRank:
                    Number(
                        getField(fields, 'AuthorityRank')
                    ) || 4,

                AllowedUserGroups:
                    getField(fields, 'AllowedUserGroups') ||
                    null
            };
        })
        .filter(item =>
            String(item.ProcessingStatus)
                .trim()
                .toLowerCase() === 'pending'
        );

    // If list is a Document Library and DriveItemId was not provided as a custom column,
    // resolve driveItem.id from Graph API for each pending item.
    if (listDriveId && mappedItems.some(i => !i.DriveItemId)) {
        for (const record of mappedItems) {
            if (!record.DriveItemId) {
                try {
                    const di = await graphClient
                        .api(`/sites/${siteId}/lists/${listId}/items/${record.id}/driveItem`)
                        .select('id,name')
                        .get();
                    if (di?.id) {
                        record.DriveItemId = di.id;
                        if (!record.FileName && di.name) {
                            record.FileName = di.name;
                        }
                    }
                } catch (_) {
                    // Item driveItem resolution failed; processDocumentQueue will report missing DriveItemId
                }
            }
        }
    }

    return mappedItems;
}

/**
 * Download actual file bytes from SharePoint.
 */
async function downloadDriveItemBuffer(
    graphClient,
    driveId,
    driveItemId
) {
    if (!driveId || !driveItemId) {
        throw new Error(
            'Both driveId and driveItemId are required.'
        );
    }

    try {
        const endpoint =
            `/drives/${encodeURIComponent(driveId)}` +
            `/items/${encodeURIComponent(driveItemId)}/content`;

        const arrayBuffer = await graphClient
            .api(endpoint)
            .responseType(ResponseType.ARRAYBUFFER)
            .get();

        const buffer = Buffer.from(arrayBuffer);

        if (!buffer.length) {
            throw new Error(
                'Downloaded SharePoint file is empty (0 bytes).'
            );
        }

        return buffer;

    } catch (error) {
        const safeMsg = sanitizeErrorMessage(error.message);
        if (error.statusCode === 404 || error.status === 404 || safeMsg.toLowerCase().includes('itemnotfound')) {
            const notFoundErr = new Error('SharePoint file not found (404): The file was moved or deleted from SharePoint.');
            notFoundErr.statusCode = 404;
            throw notFoundErr;
        }
        throw new Error(
            `SharePoint file download failure: ${safeMsg}`
        );
    }
}

/**
 * Update SharePoint queue item status (e.g. 'In Progress', 'Processed', 'Failed')
 * and records truncated ErrorSummary on failure.
 */
async function updateQueueItemStatus(
    graphClient,
    siteId,
    listId,
    listItemId,
    status,
    errorSummary = ''
) {
    if (!status) {
        throw new Error('ProcessingStatus is required.');
    }

    try {
        const endpoint =
            `/sites/${siteId}/lists/${listId}` +
            `/items/${listItemId}/fields`;

        const patchPayload = {
            ProcessingStatus: status
        };

        if (status === 'Failed' || errorSummary) {
            patchPayload.ErrorSummary = errorSummary ? String(errorSummary).slice(0, 500) : '';
        } else if (status === 'Processed' || status === 'In Progress') {
            patchPayload.ErrorSummary = '';
        }

        try {
            await graphClient.api(endpoint).patch(patchPayload);
        } catch (patchErr) {
            // Graceful fallback: If SharePoint list does not have an ErrorSummary column created yet,
            // retry patching just ProcessingStatus so locking/status transitions never fail.
            const errMsg = String(patchErr.message || '').toLowerCase();
            if (patchPayload.ErrorSummary !== undefined && (errMsg.includes('errorsummary') || errMsg.includes('field') || errMsg.includes('property') || errMsg.includes('does not exist'))) {
                await graphClient.api(endpoint).patch({ ProcessingStatus: status });
            } else {
                throw patchErr;
            }
        }

    } catch (error) {
        throw new Error(
            `SharePoint queue status update failure: ${sanitizeErrorMessage(error.message)}`
        );
    }
}

/**
 * Main SharePoint queue coordinator.
 */
async function readPendingQueueItems(context) {
    const config = validateQueueConfig();

    const credential = createGraphCredential(config);

    const graphClient = getGraphClient(credential);

    // Step 1: Resolve SharePoint site.
    const site = await resolveSite(
        graphClient,
        config.siteUrl,
        credential,
        context
    );

    // Step 2: Resolve queue list.
    const list = await resolveList(
        graphClient,
        site.id,
        config.queueListName,
        config.siteUrl
    );

    context?.log?.(
        `SharePoint queue list resolved: ${list.displayName || list.name
        }`
    );

    // If list is backed by a document library, resolve its driveId
    let listDriveId = null;
    try {
        const driveRes = await graphClient.api(`/sites/${site.id}/lists/${list.id}/drive`).select('id').get();
        if (driveRes?.id) {
            listDriveId = driveRes.id;
            context?.log?.(`Associated Document Library drive resolved: ${listDriveId}`);
        }
    } catch (_) {
        // Normal for custom generic lists
    }

    // Step 3: Retrieve Pending items.
    const items = await getPendingQueueItems(
        graphClient,
        site.id,
        list.id,
        config.queueListName,
        listDriveId
    );

    context?.log?.(
        `Pending SharePoint queue items found: ${items.length}`
    );

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
    createGraphCredential,
    getGraphAccessToken,
    getTokenDiagnostics,
    logTokenDiagnostics,
    getGraphClient,
    getSiteGraphPath,
    resolveSite,
    resolveList,
    getPendingQueueItems,
    downloadDriveItemBuffer,
    updateQueueItemStatus,
    readPendingQueueItems
};
