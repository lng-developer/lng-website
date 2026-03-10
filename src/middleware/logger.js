const LogLevel = {
    INFO: "INFO",
    ERROR: "ERROR",
    WARN: "WARN",
    DEBUG: "DEBUG"
};

module.exports = LogLevel;

class Logger {
    constructor() {
        if (Logger.instance) {
            return Logger.instance;
        }

        this.logs = [];
        Logger.instance = this;
    }

    log(message, level = LogLevel.INFO) {
        const timestamp = new Date().toISOString();
        const logEntry = { timestamp, level, message };

        this.logs.push(logEntry);
        console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
    }

    info(message) {
        this.log(message, LogLevel.INFO);
    }

    error(message) {
        this.log(message, LogLevel.ERROR);
    }

    warn(message) {
        this.log(message, LogLevel.WARN);
    }

    debug(message) {
        this.log(message, LogLevel.DEBUG);
    }

    getLogs() {
        return this.logs;
    }
}

const logger = new Logger();
Object.freeze(logger);

module.exports = logger;