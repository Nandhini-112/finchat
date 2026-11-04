const { extractDocumentLocally } = require('./local-extractor');

async function analyzeDocument(fileBuffer, fileName = '') {
    return await extractDocumentLocally(fileBuffer, fileName);
}

module.exports = {
    analyzeDocument
};
