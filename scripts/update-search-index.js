require('../src/utils/config');
const { resetSearchIndexSchemaCache, ensureSearchIndexFields } = require('../src/services/search-index');

resetSearchIndexSchemaCache();

ensureSearchIndexFields()
    .then(result => {
        console.log(JSON.stringify({
            ready: result.ready,
            updated: result.updated,
            indexName: result.indexName,
            added: result.added || [],
            reason: result.reason || null
        }));
        if (!result.ready) process.exitCode = 1;
    })
    .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
