/* Fixed scheduler tạo Job theo mốc 0h,4h,8h… */
const db = require("../models");
const Job = db.Job;
const { addLog } = require("./realtime.service");

const scheduler = {
  enabled: false,
  everyHours: Number(process.env.FIXED_EVERY_HOURS || 4),
  baseHour: Number(process.env.FIXED_BASE_HOUR || 0), // 0 = 00:00
  tzMin: Number(process.env.SCHED_TZ_MINUTES || 0), // ví dụ VN = 420
  timer: null,
};

const toLocalByOffset = (ts) => ts + scheduler.tzMin * 60000;
const toUTCFromLocal = (ts) => ts - scheduler.tzMin * 60000;

function nextAlignedTs(fromUTC = Date.now()) {
  const d = new Date(toLocalByOffset(fromUTC));
  d.setMinutes(0, 0, 0);
  let h = d.getHours();
  const mod =
    (((h - scheduler.baseHour) % scheduler.everyHours) + scheduler.everyHours) %
    scheduler.everyHours;
  if (mod !== 0 || toLocalByOffset(fromUTC) >= d.getTime()) {
    h = h + (scheduler.everyHours - mod);
    d.setHours(h, 0, 0, 0);
  }
  return toUTCFromLocal(d.getTime());
}

async function createJobForTick(prevUTC, thisUTC) {
  const job = await Job.create({
    type: "import",
    dueAt: thisUTC,
    window: { from: prevUTC, to: thisUTC },
  });
  addLog("RUN_SCHEDULED", {
    jobId: String(job._id),
    dueAt: thisUTC,
    window: { from: prevUTC, to: thisUTC },
  });
  return job;
}

async function backfillMissedJobs(fromUTC, toUTC) {
  const step = scheduler.everyHours * 3600 * 1000;
  for (let t = fromUTC + step; t <= toUTC; t += step) {
    const prev = t - step;
    const exists = await Job.findOne({ type: "import", dueAt: t }).lean();
    if (!exists) await createJobForTick(prev, t);
  }
}

async function planNext() {
  const nextUTC = nextAlignedTs(Date.now());
  const prevUTC = nextUTC - scheduler.everyHours * 3600 * 1000;

  await backfillMissedJobs(
    prevUTC - scheduler.everyHours * 3600 * 1000,
    nextUTC
  );

  const delay = Math.max(1000, nextUTC - Date.now());
  scheduler.timer = setTimeout(async () => {
    scheduler.timer = null;
    await createJobForTick(prevUTC, nextUTC);
    await planNext();
  }, delay);

  console.log(
    `[SCHEDULER] next tick at ${new Date(nextUTC).toLocaleString()} (tzOffset=${
      scheduler.tzMin
    }m)`
  );
}

function start() {
  if (!scheduler.enabled || scheduler.timer) return;
  planNext();
}
function stop() {
  if (scheduler.timer) {
    clearTimeout(scheduler.timer);
    scheduler.timer = null;
  }
}

function configure({ enabled, everyHours, baseHour, tzMin }) {
  if (typeof enabled === "boolean") scheduler.enabled = enabled;
  if (Number.isFinite(everyHours))
    scheduler.everyHours = Math.max(1, Number(everyHours));
  if (Number.isFinite(baseHour))
    scheduler.baseHour = Math.min(23, Math.max(0, Number(baseHour)));
  if (Number.isFinite(tzMin)) scheduler.tzMin = Number(tzMin);
  stop();
  if (scheduler.enabled) start();
  return {
    enabled: scheduler.enabled,
    everyHours: scheduler.everyHours,
    baseHour: scheduler.baseHour,
    tzMin: scheduler.tzMin,
  };
}

module.exports = { scheduler, configure, start, stop, nextAlignedTs };
