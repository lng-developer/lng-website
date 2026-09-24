const TaskStatusEvent = require("../models/taskStatusEvent.model");
const ExtensionTask = require("../models/extensionTask.model");
const { expireUnacknowledgedTasks, findPendingTasks, upsertByEventId } = require("./taskStatus.service");

jest.mock("../models/taskStatusEvent.model", () => ({ create: jest.fn() }));
jest.mock("../models/autoConfig.model", () => ({ updateOne: jest.fn() }));
jest.mock("../models/extensionTask.model", () => ({ find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn() }));

test("findPendingTasks limits reconnect replay to fresh sent tasks", async () => {
  const sentAfter = new Date("2026-09-23T02:50:00.000Z");
  const lean = jest.fn().mockResolvedValue([]);
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  ExtensionTask.find.mockReturnValue({ sort });

  await findPendingTasks({ shopId: "shop-1", machineId: "machine-1", statuses: ["sent"], sentAfter });

  expect(ExtensionTask.find).toHaveBeenCalledWith({
    shopId: "shop-1",
    machineId: "machine-1",
    status: { $in: ["sent"] },
    sentAt: { $gte: sentAfter },
  });
});

test("expires sent tasks that were never acknowledged after the replay window", async () => {
  ExtensionTask.updateMany.mockResolvedValue({ modifiedCount: 1 });

  const result = await expireUnacknowledgedTasks({ now: new Date("2026-09-24T10:30:00.000Z") });

  expect(ExtensionTask.updateMany).toHaveBeenCalledWith(
    { status: "sent", sentAt: { $lt: new Date("2026-09-23T10:30:00.000Z") } },
    { $set: { status: "expired", completedAt: new Date("2026-09-24T10:30:00.000Z"), lastError: "Extension did not acknowledge task within 24 hours" } }
  );
  expect(result).toBe(1);
});

test("completed Ads task persists only the compact business summary", async () => {
  TaskStatusEvent.create.mockResolvedValue({ _id: "event-1" });
  ExtensionTask.updateOne.mockResolvedValue({ acknowledged: true });
  ExtensionTask.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ payload: {} }) });

  await upsertByEventId({
    eventId: "task-1:completed",
    taskId: "task-1",
    type: "IMPORT_ADS_SPEND",
    status: "completed",
    result: { startDate: "2026-09-22", endDate: "2026-09-22", days: [{ day: "2026-09-22", importedRows: 8, sellersAffected: 2, shopSpend: 43.56, message: "Ads imported", ignored: "do-not-store" }] },
  });

  expect(ExtensionTask.updateOne).toHaveBeenCalledWith({ taskId: "task-1" }, expect.objectContaining({
    $set: expect.objectContaining({ result: { startDate: "2026-09-22", endDate: "2026-09-22", days: [{ day: "2026-09-22", importedRows: 8, sellersAffected: 2, shopSpend: 43.56, skipped: false, message: "Ads imported" }] } }),
  }));
});

test("completed tracking task persists the Amazon upload confirmation", async () => {
  TaskStatusEvent.create.mockResolvedValue({ _id: "event-2" });
  ExtensionTask.updateOne.mockResolvedValue({ acknowledged: true });
  ExtensionTask.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ payload: {} }) });

  await upsertByEventId({
    eventId: "tracking-1:completed",
    taskId: "tracking-1",
    type: "UPLOAD_TRACKING",
    status: "completed",
    result: { upload: { ok: true, batchId: "batch-1", ordersCount: 2, ignored: "do-not-store" } },
  });

  expect(ExtensionTask.updateOne).toHaveBeenCalledWith({ taskId: "tracking-1" }, expect.objectContaining({
    $set: expect.objectContaining({ result: { upload: { ok: true, batchId: "batch-1", ordersCount: 2 } } }),
  }));
});
