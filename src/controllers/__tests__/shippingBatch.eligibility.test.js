jest.mock("../../models", () => ({
  orderCustomProduct: { find: jest.fn(), updateOne: jest.fn() },
  ShippingBatch: { create: jest.fn(), find: jest.fn(), findById: jest.fn(), findByIdAndDelete: jest.fn() },
  ExtensionTask: { find: jest.fn() },
  RealtimeLog: { create: jest.fn() },
  shop: { findById: jest.fn() },
}));

jest.mock("../../lib/taskEmitter", () => ({ emitTaskToMachine: jest.fn(), buildTaskId: jest.fn() }));
jest.mock("../../service/amazonConfirmationReservation.service", () => ({
  reserveAmazonConfirmation: jest.fn(),
  releaseAmazonConfirmationReservation: jest.fn(),
  markAmazonConfirmationSubmitted: jest.fn(),
}));

const db = require("../../models");
const reservations = require("../../service/amazonConfirmationReservation.service");
const { emitTaskToMachine } = require("../../lib/taskEmitter");
const controller = require("../shippingBatch.contrller");

function findChain(rows) {
  const query = { populate: jest.fn(), lean: jest.fn() };
  query.populate.mockReturnValue(query);
  query.lean.mockResolvedValue(rows);
  return query;
}

function validOrder() {
  return {
    orderId: "112-0319169-1534648",
    shopId: { _id: "shop-1", name: "Store One" },
    status: "Shipped",
    shipByDate: new Date("2026-09-26T07:00:00.000Z"),
    items: [{
      orderItemId: "item-1",
      quantity: 1,
      tracking_info: {
        tracking: "9234690339407902297338",
        carrier: "USPS",
        actualShipAt: new Date("2026-09-25T05:00:00.000Z"),
      },
    }],
  };
}

function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.ShippingBatch.create.mockImplementation(async (data) => ({ _id: data._id || "batch-1", ...data }));
  db.ShippingBatch.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  reservations.reserveAmazonConfirmation.mockResolvedValue({ reserved: true, order: validOrder() });
});

describe("Amazon confirmation eligibility guards", () => {
  test("returns the server eligibility object for each tracking row", () => {
    const [row] = controller._test.extractOrderDetails([validOrder()]);

    expect(row.eligibility).toEqual(expect.objectContaining({
      readyForReview: true,
      reasons: [],
      shipDate: "2026-09-24",
    }));
  });

  test("re-evaluates and reserves a selected order before creating its batch", async () => {
    db.orderCustomProduct.find.mockReturnValue(findChain([validOrder()]));
    const res = response();

    await controller.createBatchFromOrders({
      body: {
        machineId: "machine-1",
        orders: [{ orderId: "112-0319169-1534648", shopId: "shop-1" }],
      },
      app: { get: jest.fn() },
    }, res, jest.fn());

    expect(reservations.reserveAmazonConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      OrderModel: db.orderCustomProduct,
      orderId: "112-0319169-1534648",
      shopId: "shop-1",
    }));
    expect(db.ShippingBatch.create).toHaveBeenCalledTimes(1);
    expect(db.ShippingBatch.create).toHaveBeenCalledWith(expect.objectContaining({ shopId: "shop-1" }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test("reopens an exact unsubmitted draft without reserving or creating another batch", async () => {
    const draftId = "draft-1";
    const order = {
      ...validOrder(),
      amazonConfirmation: { state: "reserved", batchId: draftId },
    };
    const draft = {
      _id: draftId,
      shopId: "shop-1",
      type: "CONFIRM",
      uploadTaskSent: false,
      review: {},
      completed: [{
        orderId: order.orderId,
        tracking: order.items[0].tracking_info.tracking,
        carrier: "USPS",
        trackingReceivedAt: order.items[0].tracking_info.actualShipAt,
        shipDate: "2026-09-24",
        isFake: false,
        source: "system",
      }],
    };
    db.orderCustomProduct.find.mockReturnValue(findChain([order]));
    db.ShippingBatch.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([draft]) });
    const res = response();

    await controller.createBatchFromOrders({
      body: {
        machineId: "machine-1",
        orders: [{ orderId: order.orderId, shopId: "shop-1" }],
      },
      app: { get: jest.fn() },
    }, res, jest.fn());

    expect(reservations.reserveAmazonConfirmation).not.toHaveBeenCalled();
    expect(db.ShippingBatch.create).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      batches: [expect.objectContaining({
        batchId: draftId,
        reused: true,
        uploadPreview: expect.objectContaining({
          headers: expect.arrayContaining(["order-id", "tracking-number", "ship-method"]),
        }),
      })],
    }));
  });

  test("creates separate confirmation batches for different Los Angeles ship dates", async () => {
    const laterOrder = {
      ...validOrder(),
      orderId: "113-9610826-6633041",
      items: [{
        ...validOrder().items[0],
        tracking_info: {
          ...validOrder().items[0].tracking_info,
          tracking: "9214490411397506097029",
          actualShipAt: new Date("2026-09-26T05:00:00.000Z"),
        },
      }],
    };
    db.orderCustomProduct.find.mockReturnValue(findChain([validOrder(), laterOrder]));
    const res = response();

    await controller.createBatchFromOrders({
      body: {
        machineId: "machine-1",
        orders: [
          { orderId: "112-0319169-1534648", shopId: "shop-1" },
          { orderId: "113-9610826-6633041", shopId: "shop-1" },
        ],
      },
      app: { get: jest.fn() },
    }, res, jest.fn());

    expect(db.ShippingBatch.create).toHaveBeenCalledTimes(2);
    expect(db.ShippingBatch.create).toHaveBeenCalledWith(expect.objectContaining({
      completed: [expect.objectContaining({ orderId: "112-0319169-1534648", shipDate: "2026-09-24" })],
    }));
    expect(db.ShippingBatch.create).toHaveBeenCalledWith(expect.objectContaining({
      completed: [expect.objectContaining({ orderId: "113-9610826-6633041", shipDate: "2026-09-25" })],
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      successfulBatches: 2,
      failedBatches: 0,
    }));
  });

  test("rejects a review ship date that differs from the carrier-confirmed date", async () => {
    const batch = {
      _id: "batch-1",
      uploadTaskSent: false,
      tracking_fakes: [],
      completed: [{ orderId: "112-0319169-1534648", shipDate: "2026-09-24" }],
      save: jest.fn(),
    };
    db.ShippingBatch.findById.mockResolvedValue(batch);
    const res = response();

    await controller.approveTrackingReview({
      params: { batchId: "batch-1" },
      body: {
        shipDate: "2026-09-25",
        confirmedSingleShipment: true,
        confirmedNoTransparency: true,
      },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(batch.save).not.toHaveBeenCalled();
  });

  test("releases reservations acquired by this request when one cannot be reserved", async () => {
    const secondOrder = { ...validOrder(), orderId: "113-9610826-6633041" };
    db.orderCustomProduct.find.mockReturnValue(findChain([validOrder(), secondOrder]));
    reservations.reserveAmazonConfirmation
      .mockResolvedValueOnce({ reserved: true, order: validOrder() })
      .mockResolvedValueOnce({ reserved: false, order: null });
    const res = response();

    await controller.createBatchFromOrders({
      body: {
        machineId: "machine-1",
        orders: [
          { orderId: "112-0319169-1534648", shopId: "shop-1" },
          { orderId: "113-9610826-6633041", shopId: "shop-1" },
        ],
      },
      app: { get: jest.fn() },
    }, res, jest.fn());

    expect(reservations.releaseAmazonConfirmationReservation).toHaveBeenCalledWith(expect.objectContaining({
      OrderModel: db.orderCustomProduct,
      orderId: "112-0319169-1534648",
      shopId: "shop-1",
    }));
    expect(db.ShippingBatch.create).not.toHaveBeenCalled();
  });

  test("discards only an unsubmitted batch and releases its owned reservations", async () => {
    const batch = {
      _id: "batch-1",
      shopId: "shop-1",
      uploadTaskSent: false,
      completed: [{ orderId: "112-0319169-1534648" }],
      deleteOne: jest.fn().mockResolvedValue(true),
    };
    db.ShippingBatch.findById.mockResolvedValue(batch);
    reservations.releaseAmazonConfirmationReservation.mockResolvedValue(true);
    const res = response();

    await controller.discardShippingBatch({ params: { batchId: "batch-1" } }, res, jest.fn());

    expect(reservations.releaseAmazonConfirmationReservation).toHaveBeenCalledWith(expect.objectContaining({
      OrderModel: db.orderCustomProduct,
      orderId: "112-0319169-1534648",
      shopId: "shop-1",
      batchId: "batch-1",
    }));
    expect(batch.deleteOne).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, releasedOrders: 1 }));
  });

  test("does not discard a submitted batch", async () => {
    db.ShippingBatch.findById.mockResolvedValue({ _id: "batch-1", uploadTaskSent: true });
    const res = response();

    await controller.discardShippingBatch({ params: { batchId: "batch-1" } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(reservations.releaseAmazonConfirmationReservation).not.toHaveBeenCalled();
  });

  test("does not dispatch when the assigned extension is offline", async () => {
    const batch = {
      _id: "batch-1",
      shopId: "shop-1",
      machineId: "machine-1",
      uploadTaskSent: false,
      label: "Batch 1",
      completed: [{ orderId: "112-0319169-1534648", tracking: "9234690339407902297338", carrier: "USPS" }],
      review: { approvedAt: new Date(), confirmedSingleShipment: true, confirmedNoTransparency: true, shipDate: "2026-09-24" },
      save: jest.fn(),
    };
    db.ShippingBatch.findById.mockResolvedValue(batch);
    emitTaskToMachine.mockResolvedValue({ taskId: "upload_tracking:shop-1:batch-1" });
    const io = { sockets: { sockets: new Map(), adapter: { rooms: new Map() } } };
    const res = response();

    await controller.manualUploadTask({
      body: { batchId: "batch-1", shopId: "shop-1" },
      app: { get: jest.fn((key) => key === "io" ? io : { getByMachine: () => null }) },
    }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(emitTaskToMachine).not.toHaveBeenCalled();
  });
});
