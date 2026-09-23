const ExtensionTask = require("../models/extensionTask.model");
const { buildTaskId, emitTaskToMachine } = require("./taskEmitter");

jest.mock("../models/extensionTask.model", () => ({
  findOneAndUpdate: jest.fn(),
}));

describe("taskEmitter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("buildTaskId", () => {
    test("ETSY_UPLOAD_TRACKING with orderId and trackingNumber is stable", () => {
      const input = {
        type: "ETSY_UPLOAD_TRACKING",
        shopId: "6881aba9c1bbdfc541b5cd4d",
        machineId: "6881aba9c1bbdfc541b5cd4d",
        payload: {
          orderId: "1234567890",
          trackingNumber: "YT1234567891234567",
        },
      };

      const first = buildTaskId(input);
      const second = buildTaskId(input);

      expect(first).toBe("etsy_upload_tracking:6881aba9c1bbdfc541b5cd4d:1234567890_YT1234567891234567");
      expect(second).toBe(first);
    });

    test("UPLOAD_TRACKING still prefers batchId", () => {
      const taskId = buildTaskId({
        type: "UPLOAD_TRACKING",
        shopId: "shop-1",
        payload: {
          batchId: "batch-1",
          orderId: "order-1",
          trackingNumber: "tracking-1",
        },
      });

      expect(taskId).toBe("upload_tracking:shop-1:batch-1");
    });

    test("UPLOAD_TRACKING falls back to orderId and trackingNumber when batchId is missing", () => {
      const taskId = buildTaskId({
        type: "UPLOAD_TRACKING",
        shopId: "shop-1",
        payload: {
          orderId: "order-1",
          trackingNumber: "tracking-1",
        },
      });

      expect(taskId).toBe("upload_tracking:shop-1:order-1_tracking-1");
    });

    test("SYNC_ETSY_LISTINGS with date is stable", () => {
      const input = {
        type: "SYNC_ETSY_LISTINGS",
        shopId: "shop-1",
        payload: { date: "2026-05-21" },
      };

      expect(buildTaskId(input)).toBe("sync_etsy_listings:shop-1:2026-05-21");
      expect(buildTaskId(input)).toBe(buildTaskId(input));
    });

    test("ETSY_SYNC_LISTINGS with date is stable", () => {
      const input = {
        type: "ETSY_SYNC_LISTINGS",
        shopId: "shop-1",
        payload: { date: "2026-05-21" },
      };

      expect(buildTaskId(input)).toBe("etsy_sync_listings:shop-1:2026-05-21");
      expect(buildTaskId(input)).toBe(buildTaskId(input));
    });

    test("ETSY_SYNC_LISTINGS with mode is stable when date is missing", () => {
      const input = {
        type: "ETSY_SYNC_LISTINGS",
        shopId: "shop-1",
        payload: { mode: "if_stale" },
      };

      expect(buildTaskId(input)).toBe("etsy_sync_listings:shop-1:if_stale");
      expect(buildTaskId(input)).toBe(buildTaskId(input));
    });

    test("IMPORT_ADS_SPEND keeps separate scheduled runs for the same data day", () => {
      const common = {
        type: "IMPORT_ADS_SPEND",
        shopId: "shop-1",
        payload: { startDate: "2026-09-22", endDate: "2026-09-22" },
      };

      expect(buildTaskId({ ...common, payload: { ...common.payload, runKey: "2026-09-23T03:30:00.000Z" } }))
        .not.toBe(buildTaskId({ ...common, payload: { ...common.payload, runKey: "2026-09-23T11:30:00.000Z" } }));
    });

    test("unknown type uses timestamp key and is not idempotent", () => {
      jest.spyOn(Date, "now")
        .mockReturnValueOnce(1779300000000)
        .mockReturnValueOnce(1779300000001);

      expect(buildTaskId({ type: "UNKNOWN_TASK", shopId: "shop-1", payload: {} }))
        .toBe("unknown_task:shop-1:1779300000000");
      expect(buildTaskId({ type: "UNKNOWN_TASK", shopId: "shop-1", payload: {} }))
        .toBe("unknown_task:shop-1:1779300000001");

      Date.now.mockRestore();
    });
  });

  describe("emitTaskToMachine", () => {
    test("persists ExtensionTask and emits server:task to machine room", async () => {
      ExtensionTask.findOneAndUpdate.mockResolvedValue({});
      const emit = jest.fn();
      const to = jest.fn(() => ({ emit }));
      const io = { to };

      const task = await emitTaskToMachine(io, {
        type: "ETSY_UPLOAD_TRACKING",
        shopId: "6881aba9c1bbdfc541b5cd4d",
        machineId: "6881aba9c1bbdfc541b5cd4d",
        payload: {
          machineId: "6881aba9c1bbdfc541b5cd4d",
          mongoShopId: "6881aba9c1bbdfc541b5cd4d",
          shopId: "6881aba9c1bbdfc541b5cd4d",
          orderId: "1234567890",
          trackingNumber: "YT1234567891234567",
        },
      });

      expect(task.taskId).toBe("etsy_upload_tracking:6881aba9c1bbdfc541b5cd4d:1234567890_YT1234567891234567");
      expect(task.type).toBe("ETSY_UPLOAD_TRACKING");
      expect(task.payload.taskId).toBe(task.taskId);
      expect(to).toHaveBeenCalledWith("machine:6881aba9c1bbdfc541b5cd4d");
      expect(emit).toHaveBeenCalledWith("server:task", task);
      expect(ExtensionTask.findOneAndUpdate).toHaveBeenCalledWith(
        { taskId: task.taskId },
        expect.objectContaining({
          $set: expect.objectContaining({
            taskId: task.taskId,
            type: "ETSY_UPLOAD_TRACKING",
            shopId: "6881aba9c1bbdfc541b5cd4d",
            machineId: "6881aba9c1bbdfc541b5cd4d",
            payload: task.payload,
            status: "sent",
          }),
        }),
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    });
  });
});
