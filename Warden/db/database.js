const { botIdent } = require('../../functions')

if (botIdent().activeBot.botName == 'Warden') {
    const mysql = require('mysql2')
    const {
        isRetryableDatabaseRead,
        retryTransientDatabaseOperation,
    } = require('./errorPolicy')
    require("dotenv").config({ path: `../../${botIdent().activeBot.env}` })

    const DB_ACQUIRE_TIMEOUT_MS = 10_000
    const DB_QUERY_TIMEOUT_MS = 15_000
    const DB_KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000
    const DB_KEEPALIVE_RETRY_DELAY_MS = 1_000

    const dbConfig = {
        host: process.env.DATABASE_URL,
        user: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD,
        database: process.env.DATABASE_DBASE,
        multipleStatements: true,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        connectTimeout: 20000,
        connectionLimit: 10,
        waitForConnections: true,
        queueLimit: 100,
        charset: 'utf8mb4'
    }

    const testdbConfig = {
        host: process.env.DATABASE_URL,
        user: process.env.DATABASE_TESTUSER,
        password: process.env.DATABASE_TESTPASSWORD,
        database: process.env.DATABASE_TESTDBASE,
        multipleStatements: true,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        connectTimeout: 20000,
        connectionLimit: 10,
        waitForConnections: true,
        queueLimit: 100,
        charset: 'utf8mb4'
    }

    let pool

    if (process.env.MODE == 'PROD') {
        console.log("[STARTUP]".yellow,`${botIdent().activeBot.botName}`.green,"Loading Database Functions:".magenta,'✅')
        pool = createPool(dbConfig)
    } else {
        console.log("[STARTUP]".yellow,`${botIdent().activeBot.botName}`.green,"Loading Test Server Database Functions:".cyan,'✅')
        pool = createPool(testdbConfig)
    }

    let keepAliveUnavailable = false
    const keepAliveTimer = setInterval(() => {
        void runDatabaseKeepAlive()
    }, DB_KEEPALIVE_INTERVAL_MS)
    keepAliveTimer.unref?.()

    function formatDuration(ms) {
        return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`
    }

    async function runDatabaseKeepAlive() {
        const startedAt = Date.now()
        try {
            const result = await retryTransientDatabaseOperation(
                () => query('SELECT 1', undefined, { retryTransientReads: false }),
                { retryDelayMs: DB_KEEPALIVE_RETRY_DELAY_MS },
            )
            const duration = formatDuration(Date.now() - startedAt)
            if (result.retried) {
                console.info(`[DATABASE] Keepalive connection recovered after retry (${duration}).`)
            } else if (keepAliveUnavailable) {
                console.info('[DATABASE] Keepalive connection restored.')
            }
            keepAliveUnavailable = false
        }
        catch (err) {
            keepAliveUnavailable = true
            if (err?.databaseRetryAttempted) {
                console.error('[DATABASE] Keepalive connection failed after retry:', err)
            } else {
                console.error('[DATABASE] Keepalive connection failed:', err)
            }
        }
    }

    function createPool(config) {
        const createdPool = mysql.createPool(config)
        createdPool.on('error', (err) => {
            // mysql2 pools discard failed connections and establish replacements
            // for later acquisitions. Throwing here would terminate the bot.
            console.error('Database pool error:', err)
        })
        return createdPool
    }

    function acquireConnection(targetPool) {
        return new Promise((resolve, reject) => {
            let expired = false
            const timer = setTimeout(() => {
                expired = true
                const err = new Error(`Database connection acquisition timed out after ${DB_ACQUIRE_TIMEOUT_MS}ms.`)
                err.code = 'WARDEN_DB_ACQUIRE_TIMEOUT'
                reject(err)
            }, DB_ACQUIRE_TIMEOUT_MS)
            timer.unref?.()

            try {
                targetPool.getConnection((err, acquiredConnection) => {
                    if (expired) {
                        acquiredConnection?.release()
                        return
                    }
                    clearTimeout(timer)
                    if (err) return reject(err)
                    resolve(acquiredConnection)
                })
            }
            catch (err) {
                clearTimeout(timer)
                reject(err)
            }
        })
    }

    async function executeQueryOnce(sql, values) {
        const targetPool = pool
        const acquiredConnection = await acquireConnection(targetPool)
        return new Promise((resolve, reject) => {
            try {
                acquiredConnection.query({ sql, values, timeout: DB_QUERY_TIMEOUT_MS }, (err, res) => {
                    if (err?.fatal || err?.code === 'PROTOCOL_SEQUENCE_TIMEOUT') acquiredConnection.destroy()
                    else acquiredConnection.release()
                    if (err) return reject(err)
                    resolve(res)
                })
            }
            catch (err) {
                acquiredConnection.release()
                reject(err)
            }
        })
    }

    async function query(sql, values, options = {}) {
        if (options.retryTransientReads === false || !isRetryableDatabaseRead(sql)) {
            return executeQueryOnce(sql, values)
        }
        const result = await retryTransientDatabaseOperation(
            () => executeQueryOnce(sql, values),
            { retryDelayMs: options.retryDelayMs ?? DB_KEEPALIVE_RETRY_DELAY_MS },
        )
        return result.value
    }

    //! ##############################
    //! ##############################
    //! ##############################
    //! #######STARTUP CHECKS#########

    

    //! ##############################
    //! ##############################
    //! ##############################
    //! ##############################

    module.exports = {
        get pool() { return pool },
        query,
    }
}
