const LogLevel = {
  ERROR: "ERROR",
  WARN: "WARN",
  INFO: "INFO",
  DEBUG: "DEBUG",
};

const rank = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

const normalizeLevel = (level) => {
  const normalized = String(level || "").toUpperCase();
  return rank[normalized] == null ? LogLevel.INFO : normalized;
};

const currentLevel = () => {
  const configured = process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "warn" : "info");
  return normalizeLevel(configured);
};

const serialize = (value) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
};

class Logger {
  constructor() {
    if (Logger.instance) return Logger.instance;
    this.logs = [];
    this.maxLogs = Number(process.env.LOG_BUFFER_SIZE || 200);
    Logger.instance = this;
  }

  log(message, level = LogLevel.INFO) {
    const logLevel = normalizeLevel(level);
    if (rank[logLevel] > rank[currentLevel()]) return;

    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${logLevel}] ${serialize(message)}`;
    this.logs.push({ timestamp, level: logLevel, message });
    if (this.logs.length > this.maxLogs) this.logs.shift();

    if (logLevel === LogLevel.ERROR) return console.error(line);
    if (logLevel === LogLevel.WARN) return console.warn(line);
    return console.log(line);
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

module.exports = new Logger();
