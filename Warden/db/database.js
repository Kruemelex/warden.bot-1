const { botIdent } = require('../../functions')

if (botIdent().activeBot.botName == 'Warden') {
    const mysql = require('mysql2')
    const {
        createConsoleReporter,
        logConsoleStartupStatus,
    } = require('../../logging/consoleReporting')
    const {
        isRetryableDatabaseRead,
        retryTransientDatabaseOperation,
    } = require('./errorPolicy')
    require("dotenv").config({ path: `../../${botIdent().activeBot.env}` })

    const DB_ACQUIRE_TIMEOUT_MS = 10_000
    const DB_QUERY_TIMEOUT_MS = 15_000
    const DB_KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000
    const DB_KEEPALIVE_RETRY_DELAY_MS = 1_000
    const DB_READ_MAX_ATTEMPTS = 3
    const report = createConsoleReporter('Database').forSubsystem('Connection')

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
        logConsoleStartupStatus(botIdent().activeBot.botName, 'Loading Database Functions', '✅')
        pool = createPool(dbConfig)
    } else {
        logConsoleStartupStatus(botIdent().activeBot.botName, 'Loading Test Server Database Functions', '✅')
        pool = createPool(testdbConfig)
    }

    let keepAliveUnavailable = false
    const keepAliveTimer = setInterval(() => {
        void runDatabaseKeepAlive()
    }, DB_KEEPALIVE_INTERVAL_MS)
    keepAliveTimer.unref?.()

    async function runDatabaseKeepAlive() {
        try {
            await retryTransientDatabaseOperation(
                () => query('SELECT 1', undefined, { retryTransientReads: false }),
                {
                    retryDelayMs: DB_KEEPALIVE_RETRY_DELAY_MS,
                    maxAttempts: DB_READ_MAX_ATTEMPTS,
                    backoffMultiplier: 2,
                },
            )
            if (keepAliveUnavailable) report.success('Keepalive connection restored')
            keepAliveUnavailable = false
        }
        catch (err) {
            if (!keepAliveUnavailable) {
                report.error('Keepalive connection unavailable after retries', err, {
                    attempts: err?.databaseRetryAttempts ?? 1,
                })
            }
            keepAliveUnavailable = true
        }
    }

    function createPool(config) {
        const createdPool = mysql.createPool(config)
        createdPool.on('error', (err) => {
            // mysql2 pools discard failed connections and establish replacements
            // for later acquisitions. Throwing here would terminate the bot.
            report.error('Connection pool error', err)
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
            {
                retryDelayMs: options.retryDelayMs ?? DB_KEEPALIVE_RETRY_DELAY_MS,
                maxAttempts: options.maxAttempts ?? DB_READ_MAX_ATTEMPTS,
                backoffMultiplier: options.backoffMultiplier ?? 2,
            },
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
