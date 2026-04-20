/**
 * Tests for createBatchFromOrders — performance fixes
 *
 * Covers:
 *  1. N+1 elimination: find() called once per shop, not once per order
 *  2. shopName from populated shopId.name, not fallback `Shop ${shopId}`
 *  3. tracking_fakes items have no tracking field (no ValidationError)
 *  4. Multi-shop: separate batch per shop
 *  5. Input validation (400 on bad input)
 */

jest.mock('../../models', () => ({
  orderCustomProduct: { find: jest.fn(), findOne: jest.fn() },
  ShippingBatch: { create: jest.fn() },
  OrderStatusSnapshot: { exists: jest.fn() },
}));

jest.mock('../../service/orderStatusSync', () => ({}));

jest.mock('../../service/snapshotAutoSync', () => ({
  updateBatchSubmissionStatus: jest.fn().mockResolvedValue({}),
}));

const db = require('../../models');
const controller = require('../shippingBatch.contrller');

// Helper: build a chainable mock for .find().populate().lean()
function makeFindMock(orders) {
  const q = { populate: jest.fn(), lean: jest.fn() };
  q.populate.mockReturnValue(q);
  q.lean.mockResolvedValue(orders);
  return q;
}

// Helper: build a fake order document (populated)
function makeOrder(orderId, shopId, shopName, tracking = null) {
  return {
    orderId,
    shopId: shopName ? { _id: shopId, name: shopName } : shopId,
    items: tracking
      ? [{ tracking_info: { tracking } }]
      : [],
  };
}

function makeReq(body) {
  return {
    body,
    app: { get: jest.fn().mockReturnValue(null) },
  };
}

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.ShippingBatch.create.mockImplementation(async (data) => ({
    _id: 'batch-id-' + Math.random().toString(36).slice(2),
    ...data,
    save: jest.fn().mockResolvedValue(true),
  }));
});

// ─── Validation ────────────────────────────────────────────────────────────

describe('Input validation', () => {
  test('returns 400 when machineId is missing', async () => {
    const res = makeRes();
    await controller.createBatchFromOrders(
      makeReq({ orders: [{ orderId: 'O1', shopId: 'S1' }] }),
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  test('returns 400 when orders array is empty', async () => {
    const res = makeRes();
    await controller.createBatchFromOrders(
      makeReq({ machineId: 'M1', orders: [] }),
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when an order is missing shopId', async () => {
    const res = makeRes();
    await controller.createBatchFromOrders(
      makeReq({ machineId: 'M1', orders: [{ orderId: 'O1' }] }),
      res,
      jest.fn()
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ─── N+1 elimination ───────────────────────────────────────────────────────

describe('N+1 elimination', () => {
  test('find() called once for 3 orders in same shop', async () => {
    const shopId = 'shop1';
    const orders = [
      makeOrder('O1', shopId, 'Test Shop', 'TRK001'),
      makeOrder('O2', shopId, 'Test Shop', 'TRK002'),
      makeOrder('O3', shopId, 'Test Shop', 'TRK003'),
    ];

    db.orderCustomProduct.find.mockReturnValue(makeFindMock(orders));
    const res = makeRes();

    await controller.createBatchFromOrders(
      makeReq({
        machineId: 'M1',
        orders: [
          { orderId: 'O1', shopId },
          { orderId: 'O2', shopId },
          { orderId: 'O3', shopId },
        ],
      }),
      res,
      jest.fn()
    );

    // Single bulk query, not 3 individual queries
    expect(db.orderCustomProduct.find).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  test('find() called once per shop for 2 shops', async () => {
    const shopA = 'shopA';
    const shopB = 'shopB';

    db.orderCustomProduct.find
      .mockReturnValueOnce(makeFindMock([makeOrder('O1', shopA, 'Shop Alpha', 'TRK-A1')]))
      .mockReturnValueOnce(makeFindMock([makeOrder('O2', shopB, 'Shop Beta', 'TRK-B1')]));

    const res = makeRes();
    await controller.createBatchFromOrders(
      makeReq({
        machineId: 'M1',
        orders: [
          { orderId: 'O1', shopId: shopA },
          { orderId: 'O2', shopId: shopB },
        ],
      }),
      res,
      jest.fn()
    );

    // 2 shops → 2 find() calls
    expect(db.orderCustomProduct.find).toHaveBeenCalledTimes(2);
  });
});

// ─── shopName from populated data ─────────────────────────────────────────

describe('shopName from populated shopId', () => {
  test('batch label uses shop.name, not "Shop <id>"', async () => {
    const shopId = 'shop123';
    const shopName = 'My Awesome Shop';

    db.orderCustomProduct.find.mockReturnValue(
      makeFindMock([makeOrder('O1', shopId, shopName, 'TRK001')])
    );

    const res = makeRes();
    await controller.createBatchFromOrders(
      makeReq({ machineId: 'M1', orders: [{ orderId: 'O1', shopId }], label: 'Test' }),
      res,
      jest.fn()
    );

    const [batchData] = db.ShippingBatch.create.mock.calls[0];
    expect(batchData.label).toContain(shopName);
    expect(batchData.label).not.toContain(`Shop ${shopId}`);
  });

  test('falls back to shop.store when name is missing', async () => {
    const shopId = 'shop456';
    const storeValue = 'store-slug';

    const orderWithStore = {
      orderId: 'O1',
      shopId: { _id: shopId, store: storeValue },
      items: [{ tracking_info: { tracking: 'TRK001' } }],
    };

    db.orderCustomProduct.find.mockReturnValue(makeFindMock([orderWithStore]));

    const res = makeRes();
    await controller.createBatchFromOrders(
      makeReq({ machineId: 'M1', orders: [{ orderId: 'O1', shopId }] }),
      res,
      jest.fn()
    );

    const [batchData] = db.ShippingBatch.create.mock.calls[0];
    expect(batchData.label).toContain(storeValue);
  });
});

// ─── tracking_fakes schema safety ─────────────────────────────────────────

describe('tracking_fakes schema safety', () => {
  test('orders with no tracking go to tracking_fakes without tracking field', async () => {
    const shopId = 'shop1';
    const orderNoTracking = makeOrder('O1', shopId, 'Test Shop', null);

    db.orderCustomProduct.find.mockReturnValue(makeFindMock([orderNoTracking]));
    const res = makeRes();

    await controller.createBatchFromOrders(
      makeReq({ machineId: 'M1', orders: [{ orderId: 'O1', shopId }] }),
      res,
      jest.fn()
    );

    const [batchData] = db.ShippingBatch.create.mock.calls[0];
    expect(batchData.tracking_fakes).toHaveLength(1);
    expect(batchData.tracking_fakes[0]).not.toHaveProperty('tracking');
    expect(batchData.tracking_fakes[0].orderId).toBe('O1');
  });

  test('invalid tracking values (dash, empty) count as no tracking', async () => {
    const shopId = 'shop1';
    const dashes = ['-', '---', '  '];

    for (const badTracking of dashes) {
      jest.clearAllMocks();
      db.ShippingBatch.create.mockImplementation(async (data) => ({
        _id: 'id',
        ...data,
        save: jest.fn(),
      }));

      const orderBadTracking = {
        orderId: 'O1',
        shopId: { _id: shopId, name: 'Test Shop' },
        items: [{ tracking_info: { tracking: badTracking } }],
      };

      db.orderCustomProduct.find.mockReturnValue(makeFindMock([orderBadTracking]));
      const res = makeRes();

      await controller.createBatchFromOrders(
        makeReq({ machineId: 'M1', orders: [{ orderId: 'O1', shopId }] }),
        res,
        jest.fn()
      );

      const [batchData] = db.ShippingBatch.create.mock.calls[0];
      expect(batchData.tracking_fakes).toHaveLength(1);
      expect(batchData.completed).toHaveLength(0);
    }
  });
});

// ─── completed items structure ─────────────────────────────────────────────

describe('completed items structure', () => {
  test('orders with tracking → completed with correct fields', async () => {
    const shopId = 'shop1';
    const order = makeOrder('O1', shopId, 'Test Shop', 'TRK12345');

    db.orderCustomProduct.find.mockReturnValue(makeFindMock([order]));
    const res = makeRes();

    await controller.createBatchFromOrders(
      makeReq({ machineId: 'M1', orders: [{ orderId: 'O1', shopId }] }),
      res,
      jest.fn()
    );

    const [batchData] = db.ShippingBatch.create.mock.calls[0];
    expect(batchData.completed).toHaveLength(1);
    expect(batchData.completed[0]).toMatchObject({
      orderId: 'O1',
      tracking: 'TRK12345',
      isFake: false,
      source: 'system',
    });
  });

  test('stats match completed and tracking_fakes counts', async () => {
    const shopId = 'shop1';
    const orders = [
      makeOrder('O1', shopId, 'Test Shop', 'TRK001'),
      makeOrder('O2', shopId, 'Test Shop', null),
      makeOrder('O3', shopId, 'Test Shop', 'TRK003'),
    ];

    db.orderCustomProduct.find.mockReturnValue(makeFindMock(orders));
    const res = makeRes();

    await controller.createBatchFromOrders(
      makeReq({ machineId: 'M1', orders: orders.map(o => ({ orderId: o.orderId, shopId })) }),
      res,
      jest.fn()
    );

    const [batchData] = db.ShippingBatch.create.mock.calls[0];
    expect(batchData.stats.totalReal).toBe(2);
    expect(batchData.stats.totalFake).toBe(1);
    expect(batchData.stats.totalOrders).toBe(2);
  });
});

// ─── Multi-shop creates multiple batches ───────────────────────────────────

describe('multi-shop batch creation', () => {
  test('2 shops → 2 ShippingBatch.create calls', async () => {
    db.orderCustomProduct.find
      .mockReturnValueOnce(makeFindMock([makeOrder('O1', 'shopA', 'Alpha Store', 'TRK-A')]))
      .mockReturnValueOnce(makeFindMock([makeOrder('O2', 'shopB', 'Beta Store', 'TRK-B')]));

    const res = makeRes();
    await controller.createBatchFromOrders(
      makeReq({
        machineId: 'M1',
        orders: [
          { orderId: 'O1', shopId: 'shopA' },
          { orderId: 'O2', shopId: 'shopB' },
        ],
      }),
      res,
      jest.fn()
    );

    expect(db.ShippingBatch.create).toHaveBeenCalledTimes(2);

    const labels = db.ShippingBatch.create.mock.calls.map(c => c[0].label);
    expect(labels.some(l => l.includes('Alpha Store'))).toBe(true);
    expect(labels.some(l => l.includes('Beta Store'))).toBe(true);
  });

  test('response includes both batches in batches array', async () => {
    db.orderCustomProduct.find
      .mockReturnValueOnce(makeFindMock([makeOrder('O1', 'shopA', 'Shop A', 'TRK-A')]))
      .mockReturnValueOnce(makeFindMock([makeOrder('O2', 'shopB', 'Shop B', 'TRK-B')]));

    const res = makeRes();
    await controller.createBatchFromOrders(
      makeReq({
        machineId: 'M1',
        orders: [
          { orderId: 'O1', shopId: 'shopA' },
          { orderId: 'O2', shopId: 'shopB' },
        ],
      }),
      res,
      jest.fn()
    );

    const jsonArg = res.json.mock.calls[0]?.[0];
    expect(res.status).toHaveBeenCalledWith(201);
    expect(jsonArg.ok).toBe(true);
    expect(jsonArg.batches).toHaveLength(2);
    expect(jsonArg.totalShops).toBe(2);
  });
});
