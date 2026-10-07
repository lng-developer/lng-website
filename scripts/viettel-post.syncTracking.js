#!/usr/bin/env node
// Usage: node scripts/viettel-post.syncTracking.js [--since-days 7] [--max 1000] [--apply]

const loadEnv = require("../src/config/env.config");
const { runViettelPostTrackingSync } = require("../src/service/viettelPostTrackingSync.service");

const argv = process.argv.slice(2);

function numberFlag(name, fallback, min, max) {
  const index = argv.indexOf(name);
  const value = Number(index < 0 ? fallback : argv[index + 1]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

loadEnv();
runViettelPostTrackingSync({
  sinceDays: numberFlag("--since-days", 7, 1, 31),
  max: numberFlag("--max", 1000, 1, 5000),
  apply: argv.includes("--apply"),
})
  .then((summary) => console.log(JSON.stringify(summary, null, 2)))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
