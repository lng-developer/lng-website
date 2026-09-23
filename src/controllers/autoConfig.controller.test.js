const { nextFixedRunAt, nextRunAt, nextScheduledRun, taskForConfig } = require("./autoConfig.controller");

test("supports intervals longer than one hour", () => {
  expect(nextRunAt(240, new Date("2026-09-21T01:10:00.000Z")).toISOString())
    .toBe("2026-09-21T04:00:00.000Z");
});

test("uses the next configured Vietnam hour", () => {
  expect(nextFixedRunAt([5, 10, 15, 20], new Date("2026-09-21T02:30:00.000Z")).toISOString())
    .toBe("2026-09-21T03:00:00.000Z");
});

test("builds an Ads range from Vietnam data days", () => {
  const task = taskForConfig(
    { _id: "cfg-ads", type: "IMPORT_ADS", adsStartDaysAgo: 3, adsEndDaysAgo: 1 },
    new Date("2026-09-23T18:00:00.000Z")
  );
  expect(task.payload).toMatchObject({
    startDate: "2026-09-21",
    endDate: "2026-09-23",
    date: "2026-09-23",
  });
});

test("marks a manually dispatched task without changing its payload shape", () => {
  const task = taskForConfig(
    { _id: "cfg-order", type: "IMPORT_ORDER" },
    new Date("2026-09-23T18:00:00.000Z"),
    "manual"
  );
  expect(task).toMatchObject({ type: "IMPORT_ORDERS", payload: { autoConfigId: "cfg-order", source: "manual" } });
});

test("runs the Saturday reconciliation in Vietnam time with its own data range", () => {
  const rule = { hour: 10, minute: 30, daysOfWeek: [6], startDaysAgo: 7, endDaysAgo: 2 };
  const next = nextScheduledRun({ type: "IMPORT_ADS", adsScheduleRules: [rule] }, new Date("2026-09-25T04:00:00.000Z"));
  expect(next.at.toISOString()).toBe("2026-09-26T03:30:00.000Z");
  expect(taskForConfig({ _id: "cfg-ads", type: "IMPORT_ADS" }, next.at, "auto_scheduler", next.rule).payload).toMatchObject({
    startDate: "2026-09-19", endDate: "2026-09-24"
  });
});
