const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const installed = Symbol.for("lng.consoleGuard.installed");

function currentLevel(env = process.env) {
  const configured = env.LOG_LEVEL || (env.NODE_ENV === "production" ? "warn" : "info");
  const normalized = String(configured).toLowerCase();
  return levels[normalized] == null ? levels.info : levels[normalized];
}

function installConsoleGuard(target = console, env = process.env) {
  if (target[installed]) return;
  Object.defineProperty(target, installed, { value: true });

  const level = () => currentLevel(env);
  const wrap = (method, requiredLevel) => {
    const original = target[method].bind(target);
    target[method] = (...args) => {
      if (level() >= requiredLevel) original(...args);
    };
  };

  wrap("log", levels.info);
  wrap("info", levels.info);
  wrap("debug", levels.debug);
}

module.exports = { installConsoleGuard, currentLevel };
