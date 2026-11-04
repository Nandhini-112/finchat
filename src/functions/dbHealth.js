require('../utils/config');
const { app } = require('@azure/functions');
const { getPool } = require('../services/sql');
const { sanitizeErrorMessage } = require('../utils/errors');

app.http('dbHealth', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const correlationId = `health-${Date.now()}`;

        try {
            // Connect to SQL pool and automatically ensure schema
            const pool = await getPool();

            // Fetch current database name and table list
            const result = await pool.request().query(`
                SELECT DB_NAME() AS databaseName;
                SELECT name FROM sys.tables ORDER BY name;
            `);

            const databaseName = result.recordsets[0][0]?.databaseName || process.env.AZURE_SQL_DATABASE;
            const tables = (result.recordsets[1] || []).map(r => r.name);

            context.log(`[${correlationId}] Azure SQL health check succeeded. Tables (${tables.length}): ${tables.join(', ')}`);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'healthy',
                    database: databaseName,
                    connected: true,
                    tablesFound: tables.length,
                    tables,
                    timestamp: new Date().toISOString()
                })
            };

        } catch (error) {
            const safeMsg = sanitizeErrorMessage(error.message);
            context.error(`[${correlationId}] Azure SQL health check failed: ${safeMsg}`);

            return {
                status: 503,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'unhealthy',
                    connected: false,
                    message: 'Database connection failed or timed out.',
                    details: safeMsg,
                    timestamp: new Date().toISOString()
                })
            };
        }
    }
});
