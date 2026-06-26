jest.mock('../../models', () => ({
  EtsyOrder: { findOne: jest.fn(), aggregate: jest.fn() },
  vendorProduct: { find: jest.fn() },
  user: {},
  role: {},
  shop: {},
}));

jest.mock('../../service/cloudflareR2/r2.service', () => ({
  uploadBufferToR2: jest.fn(),
  uploadFilePathToR2: jest.fn(),
}));

jest.mock('../../service/fulfillment', () => ({
  PROVIDERS: [{ key: 'lng' }, { key: 'merchize' }],
  send: jest.fn(),
}));

jest.mock('../../service/orderHistoryLogger', () => ({
  logOrderHistory: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../service/etsyTrackingResponse.service', () => ({
  buildEtsyTrackingInfoResponse: jest.fn(),
  buildEtsyTrackingSummary: jest.fn(),
}));

jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');
const db = require('../../models');
const FulfillmentService = require('../../service/fulfillment');
const { logOrderHistory } = require('../../service/orderHistoryLogger');
const controller = require('../etsyOrder.controller');

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function mockVendorProvider(name, fulfillmentType = name) {
  const lean = jest.fn().mockResolvedValue([
    { vendor_id: { name, fulfillment_type: fulfillmentType, status: 'active' } },
  ]);
  const populate = jest.fn().mockReturnValue({ lean });
  const select = jest.fn().mockReturnValue({ populate });
  db.vendorProduct.find.mockReturnValue({ select });
}

describe('resetBaseCostForEtsyOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 400 when orderId is missing', async () => {
    const req = {
      body: {},
      user: { _id: 'u1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.resetBaseCostForEtsyOrder(req, res);

    expect(db.EtsyOrder.findOne).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Missing orderId' });
  });

  test('returns 404 when Etsy order is not found', async () => {
    db.EtsyOrder.findOne.mockResolvedValue(null);

    const req = {
      body: { orderId: 'ETSY-404' },
      user: { _id: 'u1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.resetBaseCostForEtsyOrder(req, res);

    expect(db.EtsyOrder.findOne).toHaveBeenCalledWith({ orderId: 'ETSY-404' });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Etsy order not found' });
  });

  test('resets Etsy base cost and removes item cost breakdown successfully', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const computedAt = new Date('2026-04-23T01:17:11.313Z');
    const order = {
      _id: 'etsy-oid-1',
      orderId: 'ETSY-1001',
      base_cost: 18.75,
      base_cost_shipping_groups: [{ group_key: 'g1', shipping_total_for_group: 5 }],
      base_cost_computed_at: computedAt,
      items: [
        { transactionId: 't1', cost_breakdown: { matchedSku: 'SKU-1' } },
        { transactionId: 't2', cost_breakdown: null },
        { transactionId: 't3', cost_breakdown: { matchedSku: 'SKU-3' } },
      ],
      save,
    };
    db.EtsyOrder.findOne.mockResolvedValue(order);

    const req = {
      body: { orderId: 'ETSY-1001' },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.resetBaseCostForEtsyOrder(req, res);

    expect(order.base_cost).toBe(0);
    expect(order.base_cost_shipping_groups).toEqual([]);
    expect(order.base_cost_computed_at).toBeNull();
    expect(order.items[0].cost_breakdown).toBeUndefined();
    expect(order.items[1].cost_breakdown).toBeUndefined();
    expect(order.items[2].cost_breakdown).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(logOrderHistory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'UPDATE_BASE_COST',
      description: 'Etsy order base cost reset to 0 and item cost breakdown removed',
      changes: expect.arrayContaining([
        expect.objectContaining({ field: 'base_cost', from: 18.75, to: 0 }),
        expect.objectContaining({ field: 'base_cost_shipping_groups', to: [] }),
        expect.objectContaining({ field: 'base_cost_computed_at', from: computedAt, to: null }),
        expect.objectContaining({
          field: 'items.cost_breakdown',
          from: '2 item(s) had cost breakdown',
          to: 'removed',
        }),
      ]),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Etsy order base cost reset successfully',
      orderId: 'ETSY-1001',
      base_cost: 0,
      removedCostBreakdownCount: 2,
    });
  });
});

describe('resetEtsyScaleForOrdersBulk', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 400 when orderIds is empty', async () => {
    const req = {
      body: { orderIds: [] },
      user: { _id: 'u1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.resetEtsyScaleForOrdersBulk(req, res);

    expect(db.EtsyOrder.findOne).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'orderIds must be a non-empty array' });
  });

  test('returns failed result when Etsy order is not found', async () => {
    db.EtsyOrder.findOne.mockResolvedValue(null);

    const req = {
      body: { orderIds: ['ETSY-404'] },
      user: { _id: 'u1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.resetEtsyScaleForOrdersBulk(req, res);

    expect(db.EtsyOrder.findOne).toHaveBeenCalledWith({ orderId: 'ETSY-404' });
    expect(res.json).toHaveBeenCalledWith({
      message: 'Bulk reset completed',
      total: 1,
      results: [{ orderId: 'ETSY-404', status: 'failed', error: 'Etsy order not found' }],
    });
  });

  test('resets Etsy scale state for all items successfully', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const markModified = jest.fn();
    const order = {
      _id: 'etsy-oid-1',
      orderId: 'ETSY-1001',
      status: 'In progress',
      scale_overall_status: 'QC Rejected',
      scaleId: 'designer-1',
      items: [
        {
          transactionId: 't1',
          scale_status: 'QC Rejected',
          qc_note: 'bad art',
          fulfillment_file: new Map([['front', 'https://cdn/front.png']]),
        },
        {
          transactionId: 't2',
          scale_status: 'Complete',
          qc_note: '',
          fulfillment_file: { back: 'https://cdn/back.png' },
        },
      ],
      markModified,
      save,
    };
    db.EtsyOrder.findOne.mockResolvedValue(order);

    const req = {
      body: { orderIds: ['ETSY-1001'], note: 'redo' },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.resetEtsyScaleForOrdersBulk(req, res);

    expect(order.status).toBe('New');
    expect(order.scale_overall_status).toBe('Need Scale');
    expect(order.scaleId).toBeNull();
    expect(order.items[0].scale_status).toBe('Need Scale');
    expect(order.items[0].qc_note).toBe('redo');
    expect(order.items[0].fulfillment_file).toBeInstanceOf(Map);
    expect(Object.fromEntries(order.items[0].fulfillment_file)).toEqual({});
    expect(order.items[1].scale_status).toBe('Need Scale');
    expect(order.items[1].qc_note).toBe('redo');
    expect(order.items[1].fulfillment_file).toBeInstanceOf(Map);
    expect(markModified).toHaveBeenCalledWith('items');
    expect(save).toHaveBeenCalledTimes(1);
    expect(logOrderHistory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'RESET_SCALE_BULK',
      description: 'Etsy scale reset to Need Scale for all items',
      changes: expect.arrayContaining([
        expect.objectContaining({ field: 'scale_overall_status', from: 'QC Rejected', to: 'Need Scale' }),
        expect.objectContaining({ field: 'status', from: 'In progress', to: 'New' }),
        expect.objectContaining({ field: 'scaleId', from: 'designer-1', to: null }),
        expect.objectContaining({ field: 'items.scale' }),
      ]),
    }));
    expect(res.json).toHaveBeenCalledWith({
      message: 'Bulk reset completed',
      total: 1,
      results: [{ orderId: 'ETSY-1001', status: 'success', scale_overall_status: 'Need Scale' }],
    });
  });
});

describe('reopenEtsyQc', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reopens a failed Etsy order for QC while keeping scale files and submissions', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const markModified = jest.fn();
    const fulfillmentFile = new Map([['front', 'https://cdn/front.png']]);
    const costBreakdown = { matchedSku: 'MZ-SKU' };
    const vendorSubmissions = {
      merchize: {
        sent: false,
        attempt_count: 1,
        last_response: { error: 'Request failed with status code 403' },
      },
    };
    const order = {
      _id: 'etsy-oid-1',
      orderId: 'ETSY-1001',
      status: 'New',
      scale_overall_status: 'Failed',
      scaleId: 'designer-1',
      vendor_submissions: vendorSubmissions,
      items: [
        {
          transactionId: 't1',
          scale_status: 'Complete',
          qc_note: 'ok',
          fulfillment_file: fulfillmentFile,
          cost_breakdown: costBreakdown,
        },
      ],
      markModified,
      save,
    };
    db.EtsyOrder.findOne.mockResolvedValue(order);

    const req = {
      params: { orderId: 'ETSY-1001' },
      query: {},
      body: { reason: 'retry after vendor auth fix' },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.reopenEtsyQc(req, res);

    expect(order.status).toBe('New');
    expect(order.scale_overall_status).toBe('Pending');
    expect(order.scaleId).toBe('designer-1');
    expect(order.vendor_submissions).toBe(vendorSubmissions);
    expect(order.items[0].scale_status).toBe('Pending');
    expect(order.items[0].fulfillment_file).toBe(fulfillmentFile);
    expect(order.items[0].cost_breakdown).toBe(costBreakdown);
    expect(markModified).toHaveBeenCalledWith('items');
    expect(save).toHaveBeenCalledTimes(1);
    expect(logOrderHistory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'UPDATE_SCALE_STATUS',
      description: 'Etsy order reopened for QC without clearing scale files',
      changes: expect.arrayContaining([
        expect.objectContaining({ field: 'scale_overall_status', from: 'Failed', to: 'Pending' }),
        expect.objectContaining({ field: 'items.scale_status' }),
      ]),
    }));
    expect(res.json).toHaveBeenCalledWith({
      message: 'Etsy order reopened for QC',
      orderId: 'ETSY-1001',
      scale_overall_status: 'Pending',
    });
  });

  test('blocks reopen QC for shipped Etsy orders', async () => {
    db.EtsyOrder.findOne.mockResolvedValue({
      orderId: 'ETSY-1001',
      status: 'Shipped',
      scale_overall_status: 'Failed',
      items: [{ transactionId: 't1', scale_status: 'Complete', fulfillment_file: { front: 'https://cdn/front.png' } }],
    });

    const req = {
      params: { orderId: 'ETSY-1001' },
      query: {},
      body: {},
      user: { _id: 'u1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.reopenEtsyQc(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Cannot reopen QC for order status Shipped',
      status: 'Shipped',
    });
  });
});

describe('getEtsyQCList filters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('matches Etsy QC status directly before lookup stages', async () => {
    db.EtsyOrder.aggregate
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const req = {
      query: { scale_status: 'Ready' },
      user: { _id: 'u1', role: 'Admin' },
    };
    const res = makeRes();

    await controller.getEtsyQCList(req, res);

    const pipeline = db.EtsyOrder.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({
      $match: expect.objectContaining({
        scale_overall_status: { $in: ['Ready'] },
      }),
    });
    expect(pipeline.findIndex((stage) => stage.$lookup)).toBeGreaterThan(0);
  });

  test('matches Etsy Pending item status early for scale list', async () => {
    db.EtsyOrder.aggregate
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const req = {
      query: { scale_status: 'Pending' },
      user: { _id: 'u1', role: 'Admin' },
    };
    const res = makeRes();

    await controller.getEtsyScaleList(req, res);

    const pipeline = db.EtsyOrder.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({
      $match: expect.objectContaining({
        scale_overall_status: { $in: ['Pending'] },
        'items.scale_status': 'Pending',
      }),
    });
  });

  test('uses exact Etsy orderId search before broad regex search', async () => {
    db.EtsyOrder.aggregate
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const req = {
      query: { search: '4094616499' },
      user: { _id: 'u1', role: 'Admin' },
    };
    const res = makeRes();

    await controller.getEtsyQCList(req, res);

    const pipeline = db.EtsyOrder.aggregate.mock.calls[0][0];
    const lookupIndex = pipeline.findIndex((stage) => stage.$lookup);
    const exactSearchIndex = pipeline.findIndex((stage) => stage.$match?.orderId === '4094616499');

    expect(exactSearchIndex).toBeGreaterThanOrEqual(0);
    expect(exactSearchIndex).toBeLessThan(lookupIndex);
  });

  test('passes advanced QC filters into the aggregation pipeline', async () => {
    db.EtsyOrder.aggregate
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);

    const req = {
      query: {
        vendor: 'merchize',
        failureReason: '403',
        orderStatus: 'New',
        scaleBy: '68b93ed3f02eed8dec002ee7',
        qcBy: '68b93ed3f02eed8dec002ee8',
        hasScaleFile: 'true',
      },
      user: { _id: 'u1', role: 'Admin' },
    };
    const res = makeRes();

    await controller.getEtsyQCList(req, res);

    const pipelineText = JSON.stringify(db.EtsyOrder.aggregate.mock.calls[0][0]);
    expect(pipelineText).toContain('merchize');
    expect(pipelineText).toContain('403');
    expect(pipelineText).toContain('New');
    expect(pipelineText).toContain('scaleId');
    expect(pipelineText).toContain('csAssigneeId');
    expect(pipelineText).toContain('allItemsHaveScaleFile');
  });
});

describe('retrySendEtsyFulfillment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('blocks retry vendor send for shipped Etsy orders', async () => {
    db.EtsyOrder.findOne.mockResolvedValue({
      orderId: 'ETSY-1001',
      status: 'Shipped',
      scale_overall_status: 'Failed',
      items: [{ transactionId: 't1', scale_status: 'Complete', fulfillment_file: { front: 'https://cdn/front.png' } }],
    });

    const req = {
      params: { orderId: 'ETSY-1001' },
      query: { provider: 'lenful' },
      body: {},
      user: { _id: 'u1', role: 'Admin' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.retrySendEtsyFulfillment(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Cannot retry vendor send for order status Shipped',
      status: 'Shipped',
    });
  });
});

describe('confirmEtsyScaleForItem', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      FULFILLMENT_API_BASE_URL: 'https://fulfillment.example',
      FULFILLMENT_TENANT_API_KEY: 'tenant-key',
      FULFILLMENT_API_TIMEOUT_MS: '15000',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('auto pushes LNG orders to the same fulfillment platform flow when QC approval makes order ready', async () => {
    axios.post.mockResolvedValue({
      data: { success: true, received: 1, inserted: 1, updated: 0, skipped: 0 },
    });
    mockVendorProvider('LNG Group', 'lng');

    const save = jest.fn().mockResolvedValue(true);
    const markModified = jest.fn();
    const order = {
      _id: 'etsy-oid-1',
      orderId: 'ETSY-1001',
      status: 'New',
      scale_overall_status: 'Pending',
      shopId: { _id: 'shop-1', name: 'Etsy Shop' },
      buyer: { email: 'buyer@example.com', fullName: 'Jane Doe' },
      shipping: { name: 'Jane Doe', address1: '1 Main', city: 'Austin', state: 'TX', zipcode: '73301', country: 'US' },
      items: [
        {
          transactionId: 't1',
          scale_status: 'Pending',
          fulfillment_file: { front: 'https://cdn/front.png' },
          cost_breakdown: { matchedSku: 'LNG-SKU', vendorProductId: '507f1f77bcf86cd799439011' },
        },
      ],
      markModified,
      save,
    };
    db.EtsyOrder.findOne.mockResolvedValue(order);

    const req = {
      params: { orderId: 'ETSY-1001', transactionId: 't1' },
      query: {},
      body: { decision: 'approve' },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.confirmEtsyScaleForItem(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://fulfillment.example/api/portal/orders',
      expect.objectContaining({
        data: [expect.objectContaining({ orderId: 'ETSY-1001', sourceChannel: 'ETSY' })],
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer tenant-key' }),
        timeout: 15000,
      })
    );
    expect(order.scale_overall_status).toBe('Sent');
    expect(order.status).toBe('Fulfilled');
    expect(FulfillmentService.send).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Approved and pushed Etsy order to Fulfillment Platform v2.',
      order_scale_overall_status: 'Sent',
      fulfillment: expect.objectContaining({ success: true }),
    }));
  });

  test('auto sends Merchize orders through the vendor provider when QC approval makes order ready', async () => {
    mockVendorProvider('Merchize', 'merchize');
    FulfillmentService.send.mockResolvedValue({
      alreadySent: false,
      vendorKey: 'merchize',
      response: { ok: true },
    });

    const save = jest.fn().mockResolvedValue(true);
    const markModified = jest.fn();
    const order = {
      _id: 'etsy-oid-2',
      orderId: 'ETSY-2002',
      status: 'New',
      scale_overall_status: 'Pending',
      items: [
        {
          transactionId: 't1',
          scale_status: 'Pending',
          fulfillment_file: { front: 'https://cdn/front.png' },
          cost_breakdown: { matchedSku: 'MZ-SKU', vendorProductId: '507f1f77bcf86cd799439012' },
        },
      ],
      markModified,
      save,
    };
    db.EtsyOrder.findOne.mockResolvedValue(order);

    const req = {
      params: { orderId: 'ETSY-2002', transactionId: 't1' },
      query: {},
      body: { decision: 'approve' },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.confirmEtsyScaleForItem(req, res);

    expect(axios.post).not.toHaveBeenCalled();
    expect(FulfillmentService.send).toHaveBeenCalledWith(order, 'merchize');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Approved and Etsy order sent to merchize.',
      submission_vendor: 'merchize',
      submission_response: { ok: true },
    }));
  });
});

describe('updateEtsyOrderItemQuantity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('updates Etsy item quantity and numberOfItems successfully', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const markModified = jest.fn();
    const order = {
      orderId: 'ETSY-1001',
      numberOfItems: 3,
      items: [
        { transactionId: 't1', quantity: 1 },
        { transactionId: 't2', quantity: 2 },
      ],
      markModified,
      save,
    };
    db.EtsyOrder.findOne.mockResolvedValue(order);

    const req = {
      params: { orderId: 'ETSY-1001', transactionId: 't1' },
      body: { quantity: 4 },
      user: { _id: 'u1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.updateEtsyOrderItemQuantity(req, res);

    expect(order.items[0].quantity).toBe(4);
    expect(order.numberOfItems).toBe(6);
    expect(markModified).toHaveBeenCalledWith('items');
    expect(save).toHaveBeenCalledTimes(1);
    expect(logOrderHistory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'UPDATE_ITEM_QUANTITY',
      orderItemId: 't1',
      changes: expect.arrayContaining([
        expect.objectContaining({ field: 'items.quantity', from: 1, to: 4 }),
        expect.objectContaining({ field: 'numberOfItems', to: 6 }),
      ]),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Etsy order item quantity updated successfully',
      data: {
        orderId: 'ETSY-1001',
        transactionId: 't1',
        orderItemId: 't1',
        quantity: 4,
        numberOfItems: 6,
      },
    });
  });
});

describe('openCaseInEtsyOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('appends new case ids successfully', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const order = {
      orderId: 'ETSY-1001',
      case: ['507f1f77bcf86cd799439011'],
      save,
    };
    db.EtsyOrder.findOne.mockResolvedValue(order);

    const req = {
      body: {
        orderId: 'ETSY-1001',
        caseIds: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
      },
      user: { _id: 'u1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.openCaseInEtsyOrder(req, res);

    expect(order.case).toEqual(['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012']);
    expect(save).toHaveBeenCalledTimes(1);
    expect(logOrderHistory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'OPEN_CASE',
      changes: expect.arrayContaining([
        expect.objectContaining({
          field: 'case',
          from: ['507f1f77bcf86cd799439011'],
          to: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
        }),
      ]),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Case field appended successfully',
      orderId: 'ETSY-1001',
      case: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
    });
  });
});

describe('removeCaseFromEtsyOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('removes case ids successfully', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const order = {
      orderId: 'ETSY-1001',
      case: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
      save,
    };
    db.EtsyOrder.findOne.mockResolvedValue(order);

    const req = {
      body: {
        orderId: 'ETSY-1001',
        caseIds: ['507f1f77bcf86cd799439011'],
      },
      user: { _id: 'u1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.removeCaseFromEtsyOrder(req, res);

    expect(order.case).toEqual(['507f1f77bcf86cd799439012']);
    expect(save).toHaveBeenCalledTimes(1);
    expect(logOrderHistory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'REMOVE_CASE',
      changes: expect.arrayContaining([
        expect.objectContaining({
          field: 'case',
          from: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
          to: ['507f1f77bcf86cd799439012'],
        }),
      ]),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Case(s) removed successfully',
      orderId: 'ETSY-1001',
      case: ['507f1f77bcf86cd799439012'],
    });
  });
});
