const { extractDocumentLocally } = require('./local-extractor');

/**
 * Document Intelligence Service
 * 
 * NOTE: Azure AI Document Intelligence REST API code is temporarily commented out 
 * below due to tier page limitations and quotas. 
 * The system currently runs on the high-performance local extractor (pdf-parse / xlsx) 
 * which supports unlimited pages, table extraction, and text normalization with zero API latency.
 * 
 * To re-enable Azure Document Intelligence in the future:
 * 1. Uncomment the azureAnalyzeDocument function and the call inside analyzeDocument.
 * 2. Ensure AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and AZURE_DOCUMENT_INTELLIGENCE_KEY are set.
 */

/*
// ============================================================================
// AZURE AI DOCUMENT INTELLIGENCE (COMMENTED OUT TEMPORARILY DUE TO PAGE LIMITS)
// ============================================================================
async function azureAnalyzeDocument(fileBuffer, fileName = '') {
    const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    const apiKey = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
    const fn = (fileName || '').toLowerCase();
    const isPdf = fileBuffer.length >= 4 && fileBuffer.toString('utf8', 0, 4) === '%PDF';

    if (!endpoint || !apiKey) return null;
    if (!isPdf && !fn.endsWith('.pdf') && !fn.endsWith('.png') && !fn.endsWith('.jpg') && !fn.endsWith('.jpeg') && !fn.endsWith('.docx') && !fn.endsWith('.tiff')) {
        return null;
    }

    try {
        const cleanEndpoint = endpoint.replace(/\/+$/, '');
        const analyzeUrl = `${cleanEndpoint}/formrecognizer/documentModels/prebuilt-layout:analyze?api-version=2023-07-31`;

        let contentType = 'application/pdf';
        if (fn.endsWith('.png')) contentType = 'image/png';
        else if (fn.endsWith('.jpg') || fn.endsWith('.jpeg')) contentType = 'image/jpeg';
        else if (fn.endsWith('.tiff')) contentType = 'image/tiff';
        else if (fn.endsWith('.docx')) contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

        const response = await fetch(analyzeUrl, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': apiKey,
                'Content-Type': contentType
            },
            body: fileBuffer
        });

        if (response.status === 202) {
            const opLocation = response.headers.get('Operation-Location') || response.headers.get('operation-location');
            if (opLocation) {
                for (let attempt = 0; attempt < 30; attempt++) {
                    await new Promise(r => setTimeout(r, 1000));
                    const pollRes = await fetch(opLocation, {
                        headers: { 'Ocp-Apim-Subscription-Key': apiKey }
                    });
                    const pollData = await pollRes.json();

                    if (pollData.status === 'succeeded' && pollData.analyzeResult) {
                        const res = pollData.analyzeResult;
                        const pages = (res.pages || []).map(p => ({
                            pageNumber: p.pageNumber,
                            text: (p.lines || []).map(l => l.content).join('\n')
                        }));
                        const tables = (res.tables || []).map(t => ({
                            rowCount: t.rowCount,
                            columnCount: t.columnCount,
                            cells: (t.cells || []).map(c => ({
                                rowIndex: c.rowIndex,
                                columnIndex: c.columnIndex,
                                content: c.content
                            })),
                            boundingRegions: t.boundingRegions || []
                        }));
                        const paragraphs = (res.paragraphs || []).map(p => ({
                            content: p.content,
                            boundingRegions: p.boundingRegions || []
                        }));

                        return {
                            content: res.content || pages.map(p => p.text).join('\n\n'),
                            pages,
                            tables,
                            paragraphs,
                            parser: 'azure-document-intelligence'
                        };
                    } else if (pollData.status === 'failed') {
                        break;
                    }
                }
            }
        }
    } catch (err) {
        console.warn('[DocIntelligence] Azure Document Intelligence failed:', err.message);
    }
    return null;
}
*/

/**
 * Main analyzeDocument function used by ingestDocument and processDocumentQueue.
 * Uses local extraction (pdf-parse + xlsx) to bypass page limits and avoid extra cloud cost.
 */
async function analyzeDocument(fileBuffer, fileName = '') {
    // -------------------------------------------------------------------------
    // If you want to use Azure Document Intelligence in future, uncomment:
    // const azureResult = await azureAnalyzeDocument(fileBuffer, fileName);
    // if (azureResult) return azureResult;
    // -------------------------------------------------------------------------

    // Use local extraction directly (handles PDF, Excel, CSV, text without page limits)
    return await extractDocumentLocally(fileBuffer, fileName);
}

module.exports = {
    analyzeDocument
};
