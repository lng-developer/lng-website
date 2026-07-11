const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

let loaded = false;

function getEnvFile() {
  const explicit = process.env.ENV_FILE || process.env.DOTENV_CONFIG_PATH;
  if (explicit) return explicit;

  const envName = String(process.env.NODE_ENV || "").trim().toLowerCase();
  if (envName === "test") return ".env.test";
  if (envName === "production") return ".env.production";
  return ".env";
}

function loadEnv() {
  if (loaded) return process.env;

  const envFile = getEnvFile();
  const envPath = path.resolve(process.cwd(), envFile);
  const fallbackPath = path.resolve(process.cwd(), ".env");
  const envName = String(process.env.NODE_ENV || "").trim().toLowerCase();

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
  } else if (envName === "production") {
    if (!process.env.MONGO_URI || !process.env.DB_NAME) {
      throw new Error(`${envFile} not found and MONGO_URI/DB_NAME are not set`);
    }
  } else if (envPath !== fallbackPath && fs.existsSync(fallbackPath)) {
    dotenv.config({ path: fallbackPath, quiet: true });
  } else {
    dotenv.config({ quiet: true });
  }

  loaded = true;
  return process.env;
}

module.exports = loadEnv;
