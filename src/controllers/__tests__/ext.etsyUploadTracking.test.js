jest.mock("../../models", () => ({
  shop: { find: jest.fn() },
  RealtimeLog: { create: jest.fn().mockResolvedValue({}) },
  ExtensionTask: { findOne: jest.fn() },
  orderCustomProduct: {},
  vendorProduct: {},
  vendor: {},
}));

jest.mock("../../lib/taskEmitter", () => ({
  buildTaskId: jest.fn(({ type, shopId, payload }) =>
    `${String(type).toLowerCase()}:${shopId}:${payload.orderId}_${payload.trackingNumber}`
  ),
  emitTaskToMachine: jest.fn(async (_io, { taskId, type, payload }) => ({
    taskId,
    type,
    payload: { ...payload, taskId },
    sentAt: "2026-05-21T00:00:00.000Z",
  })),
}));

const db = require("../../models");
const taskEmitter = require("../../lib/taskEmitter");
const controller = require("../ext.controller");

const SHOP_ID = "6881aba9c1bbdfc541b5cd4d";
const ORDER_ID = "1234567890";
const TRACKING_NUMBER = "YT1234567891234567";

function makeReq(body) {
  return {
    body,
    headers: { "user-agent": "jest" },
    app: {
      get: jest.fn((key) => {
        if (key === "io") return { to: jest.fn() };
        return null;
      }),
    },
  };
}

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function mockExistingTask(status) {
  db.ExtensionTask.findOne.mockReturnValue({
    lean: jest.fn().mockResolvedValue(status ? { status } : null),
  });
}

function expectedOkResponse() {
  return {
    ok: true,
    taskId: `etsy_upload_tracking:${SHOP_ID}:${ORDER_ID}_${TRACKING_NUMBER}`,
    type: "ETSY_UPLOAD_TRACKING",
    machineId: SHOP_ID,
    shopId: SHOP_ID,
  };
}

describe("ext Etsy upload tracking task", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.RealtimeLog.create.mockResolvedValue({});
    mockExistingTask(null);
  });

  test("POST /api/ext/command style request emits normalized ETSY_UPLOAD_TRACKING task", async () => {
    const res = makeRes();

    await controller.requestExtension(
      makeReq({
        shopId: SHOP_ID,
        machineId: SHOP_ID,
        action: "click",
        label: "Upload Etsy Tracking",
        type: "ETSY_UPLOAD_TRACKING",
        payload: {
          machineId: ` ${SHOP_ID} `,
          shopId: SHOP_ID,
          orderId: ` ${ORDER_ID} `,
          trackingNumber: ` ${TRACKING_NUMBER} `,
        },
      }),
      res
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expectedOkResponse());
    expect(taskEmitter.buildTaskId).toHaveBeenCalledWith({
      type: "ETSY_UPLOAD_TRACKING",
      shopId: SHOP_ID,
      machineId: SHOP_ID,
      payload: {
        machineId: SHOP_ID,
        mongoShopId: SHOP_ID,
        shopId: SHOP_ID,
        orderId: ORDER_ID,
        trackingNumber: TRACKING_NUMBER,
      },
    });
    expect(taskEmitter.emitTaskToMachine).toHaveBeenCalledWith(
      expect.anything(),
      {
        taskId: `etsy_upload_tracking:${SHOP_ID}:${ORDER_ID}_${TRACKING_NUMBER}`,
        type: "ETSY_UPLOAD_TRACKING",
        shopId: SHOP_ID,
        machineId: SHOP_ID,
        payload: {
          machineId: SHOP_ID,
          mongoShopId: SHOP_ID,
          shopId: SHOP_ID,
          orderId: ORDER_ID,
          trackingNumber: TRACKING_NUMBER,
        },
      }
    );
    expect(db.RealtimeLog.create).toHaveBeenCalledWith(expect.objectContaining({
      shopId: SHOP_ID,
      machineId: SHOP_ID,
      message: "Start Etsy upload tracking ...",
    }));
  });

  test.each(["UPLOAD_TRACKING", "etsy_upload_tracking", "upload_tracking"])(
    "POST /api/ext/command normalizes alias type %s",
    async (type) => {
      const res = makeRes();

      await controller.requestExtension(
        makeReq({
          type,
          payload: {
            machineId: SHOP_ID,
            orderId: ORDER_ID,
            trackingNumber: TRACKING_NUMBER,
          },
        }),
        res
      );

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expectedOkResponse());
      expect(taskEmitter.emitTaskToMachine).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "ETSY_UPLOAD_TRACKING",
          shopId: SHOP_ID,
          machineId: SHOP_ID,
        })
      );
    }
  );

  test("dedicated endpoint accepts minimal payload and fills shopId and mongoShopId", async () => {
    const res = makeRes();

    await controller.etsyUploadTracking(
      makeReq({
        machineId: SHOP_ID,
        orderId: ORDER_ID,
        trackingNumber: TRACKING_NUMBER,
      }),
      res
    );

    expect(db.ExtensionTask.findOne).toHaveBeenCalledWith({
      taskId: `etsy_upload_tracking:${SHOP_ID}:${ORDER_ID}_${TRACKING_NUMBER}`,
    });
    expect(res.json).toHaveBeenCalledWith(expectedOkResponse());
    expect(taskEmitter.emitTaskToMachine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskId: `etsy_upload_tracking:${SHOP_ID}:${ORDER_ID}_${TRACKING_NUMBER}`,
        type: "ETSY_UPLOAD_TRACKING",
        shopId: SHOP_ID,
        machineId: SHOP_ID,
        payload: expect.objectContaining({
          machineId: SHOP_ID,
          mongoShopId: SHOP_ID,
          shopId: SHOP_ID,
          orderId: ORDER_ID,
          trackingNumber: TRACKING_NUMBER,
        }),
      })
    );
  });

  test("dedicated endpoint accepts payload.machineId instead of body.machineId", async () => {
    const res = makeRes();

    await controller.etsyUploadTracking(
      makeReq({
        payload: {
          machineId: SHOP_ID,
          orderId: ORDER_ID,
          trackingNumber: TRACKING_NUMBER,
        },
      }),
      res
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expectedOkResponse());
  });

  test("rejects missing orderId", async () => {
    const res = makeRes();

    await controller.etsyUploadTracking(
      makeReq({
        machineId: SHOP_ID,
        trackingNumber: TRACKING_NUMBER,
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, message: "orderId is required" });
    expect(taskEmitter.emitTaskToMachine).not.toHaveBeenCalled();
  });

  test("rejects missing trackingNumber", async () => {
    const res = makeRes();

    await controller.etsyUploadTracking(
      makeReq({
        machineId: SHOP_ID,
        orderId: ORDER_ID,
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, message: "trackingNumber is required" });
    expect(taskEmitter.emitTaskToMachine).not.toHaveBeenCalled();
  });

  test("rejects invalid ObjectId", async () => {
    const res = makeRes();

    await controller.etsyUploadTracking(
      makeReq({
        machineId: "not-an-object-id",
        orderId: ORDER_ID,
        trackingNumber: TRACKING_NUMBER,
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, message: "machineId must be a valid ObjectId" });
    expect(taskEmitter.emitTaskToMachine).not.toHaveBeenCalled();
  });

  test("rejects mismatched shopId machineId and mongoShopId", async () => {
    const res = makeRes();

    await controller.requestExtension(
      makeReq({
        shopId: SHOP_ID,
        machineId: "6881aba9c1bbdfc541b5cd4e",
        type: "ETSY_UPLOAD_TRACKING",
        payload: {
          mongoShopId: SHOP_ID,
          orderId: ORDER_ID,
          trackingNumber: TRACKING_NUMBER,
        },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      message: "shopId, machineId, and mongoShopId must match for Etsy upload tracking",
    });
    expect(taskEmitter.emitTaskToMachine).not.toHaveBeenCalled();
  });

  test.each(["sent", "received"])(
    "dedicated endpoint returns 409 when existing task is %s",
    async (status) => {
      mockExistingTask(status);
      const res = makeRes();

      await controller.etsyUploadTracking(
        makeReq({
          machineId: SHOP_ID,
          orderId: ORDER_ID,
          trackingNumber: TRACKING_NUMBER,
        }),
        res
      );

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        ok: false,
        reason: "TASK_ALREADY_RUNNING",
        taskId: `etsy_upload_tracking:${SHOP_ID}:${ORDER_ID}_${TRACKING_NUMBER}`,
        status,
        message: "Etsy upload tracking task is already pending/running",
      });
      expect(taskEmitter.emitTaskToMachine).not.toHaveBeenCalled();
    }
  );

  test("dedicated endpoint skips when existing task is completed", async () => {
    mockExistingTask("completed");
    const res = makeRes();

    await controller.etsyUploadTracking(
      makeReq({
        machineId: SHOP_ID,
        orderId: ORDER_ID,
        trackingNumber: TRACKING_NUMBER,
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      skipped: true,
      reason: "TASK_ALREADY_COMPLETED",
      taskId: `etsy_upload_tracking:${SHOP_ID}:${ORDER_ID}_${TRACKING_NUMBER}`,
      status: "completed",
      message: "Etsy upload tracking task already completed",
    });
    expect(taskEmitter.emitTaskToMachine).not.toHaveBeenCalled();
  });

  test("dedicated endpoint re-emits failed task by default", async () => {
    mockExistingTask("failed");
    const res = makeRes();

    await controller.etsyUploadTracking(
      makeReq({
        machineId: SHOP_ID,
        orderId: ORDER_ID,
        trackingNumber: TRACKING_NUMBER,
      }),
      res
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expectedOkResponse());
    expect(taskEmitter.emitTaskToMachine).toHaveBeenCalled();
  });

  test("dedicated endpoint force=true re-emits pending task and sends force in payload", async () => {
    mockExistingTask("sent");
    const res = makeRes();

    await controller.etsyUploadTracking(
      makeReq({
        machineId: SHOP_ID,
        orderId: ORDER_ID,
        trackingNumber: TRACKING_NUMBER,
        force: true,
      }),
      res
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expectedOkResponse());
    expect(taskEmitter.emitTaskToMachine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({ force: true }),
      })
    );
  });
});
