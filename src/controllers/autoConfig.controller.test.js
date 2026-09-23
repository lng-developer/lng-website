jest.mock("../models/autoConfig.model", () => ({ findById: jest.fn(), findByIdAndUpdate: jest.fn(), updateOne: jest.fn() }));

const AutoConfig = require("../models/autoConfig.model");
const { nextFixedRunAt, nextRunAt, nextScheduledRun, taskForConfig, update } = require("./autoConfig.controller");

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

test("uses a manually selected Ads date range instead of the schedule range", () => {
  const task = taskForConfig(
    { _id: "cfg-ads", type: "IMPORT_ADS", adsStartDaysAgo: 1, adsEndDaysAgo: 1 },
    new Date("2026-09-23T18:00:00.000Z"),
    "manual",
    null,
    { startDate: "2026-09-01", endDate: "2026-09-07" }
  );
  expect(task.payload).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-07", date: "2026-09-07", source: "manual" });
});

test("runs the Saturday reconciliation in Vietnam time with its own data range", () => {
  const rule = { hour: 10, minute: 30, daysOfWeek: [6], startDaysAgo: 7, endDaysAgo: 2 };
  const next = nextScheduledRun({ type: "IMPORT_ADS", adsScheduleRules: [rule] }, new Date("2026-09-25T04:00:00.000Z"));
  expect(next.at.toISOString()).toBe("2026-09-26T03:30:00.000Z");
  expect(taskForConfig({ _id: "cfg-ads", type: "IMPORT_ADS" }, next.at, "auto_scheduler", next.rule).payload).toMatchObject({
    startDate: "2026-09-19", endDate: "2026-09-24"
  });
});

test("allows Ads rules to replace legacy empty scheduleHours", async () => {
  const rules = [{ hour: 7, minute: 30, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startDaysAgo: 1, endDaysAgo: 1 }];
  AutoConfig.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: "cfg-ads", type: "IMPORT_ADS" }) });
  AutoConfig.findByIdAndUpdate.mockResolvedValue({ _id: "cfg-ads", type: "IMPORT_ADS", status: false, scheduleHours: [], adsScheduleRules: rules });
  AutoConfig.updateOne.mockResolvedValue({ acknowledged: true });
  const res = { status: jest.fn(function status() { return this; }), json: jest.fn() };

  await update({ params: { id: "cfg-ads" }, body: { scheduleHours: [], status: false, adsScheduleRules: rules }, app: { get: jest.fn() } }, res);

  expect(AutoConfig.findByIdAndUpdate).toHaveBeenCalledWith("cfg-ads", expect.objectContaining({ scheduleHours: [], adsScheduleRules: rules }), expect.any(Object));
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
});
