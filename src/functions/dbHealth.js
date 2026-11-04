require('../utils/config');
const { app } = require('@azure/functions');
const sql = require('mssql');
const { sanitizeErrorMessage } = require('../utils/errors');

app.http('dbHealth', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const correlationId = `health-${Date.now()}`;
        let probePool = null;

        try {
            // 1. Configure lightweight database probe with strict 15-second timeout
            const config = {
                server: process.env.AZURE_SQL_SERVER,
                database: process.env.AZURE_SQL_DATABASE,
                user: process.env.AZURE_SQL_USER,
                password: process.env.AZURE_SQL_PASSWORD,
                options: {
                    encrypt: process.env.AZURE_SQL_ENCRYPT !== 'false',
                    trustServerCertificate: false
                },
                connectionTimeout: 15000,
                requestTimeout: 15000,
                pool: {
                    max: 2,
                    min: 0,
                    idleTimeoutMillis: 10000
                }
            };

            // 2. Attempt connection
            probePool = await sql.connect(config);

            // 3. Execute lightweight verification query
            const result = await probePool.request().query(
                'SELECT DB_NAME() AS databaseName, 1 AS connected'
            );

            context.log(`[${correlationId}] Azure SQL health check succeeded.`);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'healthy',
                    database: result.recordset[0].databaseName,
                    connected: true,
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

        } finally {
            // 4. Always close the probe connection to free Azure SQL socket slots
            if (probePool) {
                await probePool.close().catch(() => {});
            }
        }
    }
});
