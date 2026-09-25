jest.mock('../../models', () => ({
  EtsyOrder: { find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), findById: jest.fn(), updateOne: jest.fn(), aggregate: jest.fn() },
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
jest.mock('../../service/orderLifecycleLogger', () => ({
  logOrderLifecycleEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../service/etsyTrackingResponse.service', () => ({
  buildEtsyTrackingInfoResponse: jest.fn(),
  buildEtsyTrackingSummary: jest.fn(),
}));

jest.mock('../../models/extensionTask.model', () => ({
  findOne: jest.fn(),
}));

jest.mock('../../lib/taskEmitter', () => ({
  buildTaskId: jest.fn(({ type, shopId, payload }) =>
    `${String(type).toLowerCase()}:${shopId}:${payload.orderId}_${payload.trackingNumber}`
  ),
  emitTaskToMachine: jest.fn(),
}));

jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');
const db = require('../../models');
const FulfillmentService = require('../../service/fulfillment');
const { uploadFilePathToR2 } = require('../../service/cloudflareR2/r2.service');
const { logOrderHistory } = require('../../service/orderHistoryLogger');
const { logOrderLifecycleEvent } = require('../../service/orderLifecycleLogger');
const ExtensionTask = require('../../models/extensionTask.model');
const { emitTaskToMachine } = require('../../lib/taskEmitter');
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

function mockFindChain(result) {
  const chain = {
    populate: jest.fn(() => chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (reject) => Promise.resolve(result).catch(reject),
  };
  db.EtsyOrder.find.mockReturnValue(chain);
  return chain;
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
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'etsy',
      orderId: 'ETSY-1001',
      stage: 'RESET',
      eventType: 'ORDER_RESET_COST',
      status: 'success',
      metadata: expect.objectContaining({
        oldBaseCost: 18.75,
        newBaseCost: 0,
        removedCostBreakdownCount: 2,
      }),
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

describe('uploadEtsyFulfillmentFileForItem response diagnostics', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns uploaded file details and timing diagnostics', async () => {
    uploadFilePathToR2.mockResolvedValue({
      provider: 'cloudflare-r2',
      bucket: 'bucket',
      key: 'fulfillment_files/etsy-ETSY-1001-t1-front.png',
      url: 'https://cdn.example/fulfillment_files/etsy-ETSY-1001-t1-front.png',
      folder: 'fulfillment_files',
      mimeType: 'image/png',
      size: 2048,
    });

    const save = jest.fn().mockResolvedValue(true);
    const markModified = jest.fn();
    const order = {
      orderId: 'ETSY-1001',
      items: [{ transactionId: 't1', scale_status: 'Need Scale', fulfillment_file: {} }],
      markModified,
      save,
    };
    db.EtsyOrder.findOne.mockResolvedValue(order);

    const req = {
      params: { orderId: 'ETSY-1001', transactionId: 't1' },
      query: {},
      body: { meta: JSON.stringify([{ position: 'front' }]) },
      files: [{
        path: 'tmp_uploads/etsy_fulfillment/test-front.png',
        originalname: 'front.png',
        mimetype: 'image/png',
        size: 2048,
      }],
      user: { _id: 'not-objectid', role: 'Admin' },
    };
    const res = makeRes();

    await controller.uploadEtsyFulfillmentFileForItem[1](req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Uploaded Etsy fulfillment files successfully',
      uploaded_files: [expect.objectContaining({
        position: 'front',
        originalName: 'front.png',
        size: 2048,
        key: 'fulfillment_files/etsy-ETSY-1001-t1-front.png',
        url: 'https://cdn.example/fulfillment_files/etsy-ETSY-1001-t1-front.png',
        durationMs: expect.any(Number),
      })],
      diagnostics: expect.objectContaining({
        orderId: 'ETSY-1001',
        transactionId: 't1',
        receivedFiles: 1,
        uploadedFiles: 1,
        totalBytes: 2048,
        stage: 'completed',
        durationMs: expect.any(Number),
      }),
    }));
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

describe('updateEtsyOrderTrackingForAllItems lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('logs ORDER_STATUS_CHANGED when tracking update ships the Etsy order', async () => {
    const beforeDoc = { _id: 'etsy-oid-1', orderId: 'ETSY-TRACK-1', status: 'New' };
    const updated = {
      _id: 'etsy-oid-1',
      orderId: 'ETSY-TRACK-1',
      status: 'New',
      scale_overall_status: 'Sent',
      items: [
        { transactionId: 't1', tracking_info: { status: 'Shipped', tracking: 'YT123' } },
      ],
    };
    db.EtsyOrder.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(beforeDoc) });
    db.EtsyOrder.findOneAndUpdate.mockResolvedValue(updated);
    db.EtsyOrder.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const req = {
      params: { orderId: 'ETSY-TRACK-1' },
      body: { tracking: 'YT123', fulfillment: 'Merchize' },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.updateEtsyOrderTrackingForAllItems(req, res);

    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'etsy',
      orderId: 'ETSY-TRACK-1',
      stage: 'ORDER_STATUS',
      eventType: 'ORDER_STATUS_CHANGED',
      status: 'success',
      metadata: { fromStatus: 'New', toStatus: 'Shipped' },
    }));
  });

  test('stores the first valid carrier handoff date for every Etsy item', async () => {
    const beforeDoc = { _id: 'etsy-oid-2', orderId: 'ETSY-HANDOFF-1', status: 'Shipped' };
    const actualShipAt = new Date('2026-09-25T03:00:00.000Z');
    const updated = {
      _id: 'etsy-oid-2',
      orderId: 'ETSY-HANDOFF-1',
      status: 'Shipped',
      items: [{ transactionId: 't1', tracking_info: { status: 'Shipped', tracking: 'YT456', actualShipAt } }],
    };
    db.EtsyOrder.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(beforeDoc) });
    db.EtsyOrder.findOneAndUpdate.mockResolvedValue(updated);

    const req = {
      params: { orderId: 'ETSY-HANDOFF-1' },
      body: { tracking: 'YT456', actualShipAt: actualShipAt.toISOString() },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.updateEtsyOrderTrackingForAllItems(req, res);

    expect(db.EtsyOrder.findOneAndUpdate).toHaveBeenCalledWith(
      { orderId: 'ETSY-HANDOFF-1' },
      {
        $set: expect.objectContaining({
          'items.$[].tracking_info.tracking': 'YT456',
          'items.$[carrierPending].tracking_info.actualShipAt': actualShipAt,
        }),
      },
      {
        new: true,
        arrayFilters: [{ 'carrierPending.tracking_info.actualShipAt': null }],
      }
    );
  });

  test('queues a new Etsy tracking number once for the shop extension', async () => {
    const shopId = '6881aba9c1bbdfc541b5cd4d';
    const beforeDoc = { _id: 'etsy-oid-3', orderId: 'ETSY-UPLOAD-1', shopId, status: 'New' };
    const updated = {
      _id: 'etsy-oid-3',
      orderId: 'ETSY-UPLOAD-1',
      status: 'New',
      items: [{ transactionId: 't1', tracking_info: { status: 'Shipped', tracking: '9200190339407916396940' } }],
    };
    db.EtsyOrder.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(beforeDoc) });
    db.EtsyOrder.findOneAndUpdate.mockResolvedValue(updated);
    db.EtsyOrder.updateOne.mockResolvedValue({ modifiedCount: 1 });
    ExtensionTask.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    emitTaskToMachine.mockResolvedValue({ taskId: `etsy_upload_tracking:${shopId}:ETSY-UPLOAD-1_9200190339407916396940` });

    const req = {
      params: { orderId: 'ETSY-UPLOAD-1' },
      body: { tracking: '9200190339407916396940' },
      app: { get: jest.fn(() => ({ to: jest.fn() })) },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.updateEtsyOrderTrackingForAllItems(req, res);

    expect(emitTaskToMachine).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'ETSY_UPLOAD_TRACKING',
        shopId,
        machineId: shopId,
        payload: expect.objectContaining({
          mongoShopId: shopId,
          shopId,
          machineId: shopId,
          orderId: 'ETSY-UPLOAD-1',
          trackingNumber: '9200190339407916396940',
        }),
      })
    );
  });

  test('does not re-queue an Etsy tracking task that is already completed', async () => {
    const shopId = '6881aba9c1bbdfc541b5cd4d';
    const beforeDoc = { _id: 'etsy-oid-4', orderId: 'ETSY-UPLOAD-2', shopId, status: 'Shipped' };
    const updated = {
      _id: 'etsy-oid-4',
      orderId: 'ETSY-UPLOAD-2',
      status: 'Shipped',
      items: [{ transactionId: 't1', tracking_info: { status: 'Shipped', tracking: 'YT123' } }],
    };
    db.EtsyOrder.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(beforeDoc) });
    db.EtsyOrder.findOneAndUpdate.mockResolvedValue(updated);
    ExtensionTask.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: 'completed' }) });

    const req = {
      params: { orderId: 'ETSY-UPLOAD-2' },
      body: { tracking: 'YT123' },
      app: { get: jest.fn(() => ({ to: jest.fn() })) },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.updateEtsyOrderTrackingForAllItems(req, res);

    expect(emitTaskToMachine).not.toHaveBeenCalled();
  });

  test('rejects an invalid Etsy carrier handoff date', async () => {
    const req = {
      params: { orderId: 'ETSY-HANDOFF-2' },
      body: { tracking: 'YT789', actualShipAt: 'not-a-date' },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.updateEtsyOrderTrackingForAllItems(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'actualShipAt must be a valid ISO date' });
    expect(db.EtsyOrder.findOneAndUpdate).not.toHaveBeenCalled();
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
          baseImageUrl: 'https://i.etsystatic.com/66742086/r/il/17d71c/8301789845/il_75x75.8301789845_hl6n.jpg',
          snapshotImageUrl: 'https://i.etsystatic.com/66742086/r/il/17d71c/8301789845/il_75x75.8301789845_hl6n.jpg',
          customized_url: 'https://i.etsystatic.com/66742086/r/il/17d71c/8301789845/il_75x75.8301789845_hl6n.jpg',
          fulfillment_file: { front: 'https://i.etsystatic.com/66742086/r/il/17d71c/8301789845/il_75x75.8301789845_hl6n.jpg' },
          customFiles: [
            { url: 'https://i.etsystatic.com/66742086/r/il/17d71c/8301789845/il_75x75.8301789845_hl6n.jpg' },
          ],
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

    expect(axios.post).not.toHaveBeenCalled();
    expect(order.scale_overall_status).toBe('Ready');
    expect(order.status).toBe('New');
    expect(FulfillmentService.send).not.toHaveBeenCalled();
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'etsy',
      orderId: 'ETSY-1001',
      stage: 'SCALE',
      eventType: 'SCALE_ITEM_APPROVED',
      status: 'success',
    }));
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'etsy',
      orderId: 'ETSY-1001',
      stage: 'QC',
      eventType: 'QC_APPROVED',
      status: 'success',
      metadata: { orderItemId: 't1', note: '' },
    }));
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'etsy',
      orderId: 'ETSY-1001',
      stage: 'SCALE',
      eventType: 'SCALE_ORDER_READY',
      status: 'success',
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Approved and Etsy order is ready for production.',
      order_scale_overall_status: 'Ready',
    }));
  });

  test('does not auto send Merchize orders when QC approval makes order ready', async () => {
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
    expect(FulfillmentService.send).not.toHaveBeenCalled();
    expect(order.scale_overall_status).toBe('Ready');
    expect(order.status).toBe('New');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Approved and Etsy order is ready for production.',
      order_scale_overall_status: 'Ready',
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

describe('pushEtsyPlatformOrders production gate', () => {
  const oldEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...oldEnv,
      FULFILLMENT_API_BASE_URL: 'https://platform.example',
      FULFILLMENT_TENANT_API_KEY: 'tenant-key',
      FULFILLMENT_API_TIMEOUT_MS: '15000',
    };
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  test('blocks Etsy production push when order has a blocking case', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const order = {
      orderId: 'ETSY-BLOCKED',
      status: 'New',
      scale_overall_status: 'Ready',
      case: [{ _id: 'case-1', name: 'Customer Change Request', blocksProduction: true }],
      seller: {},
      items: [{
        transactionId: 'tx-1',
        fulfillment_file: { front: 'https://cdn.example/front.png' },
        cost_breakdown: { vendorProductId: 'vendor-product-1' },
      }],
      save,
    };
    mockFindChain([order]);

    const req = {
      body: { orderIds: ['ETSY-BLOCKED'] },
      user: { role: 'Admin', _id: 'user-1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.pushEtsyPlatformOrders(req, res);

    expect(axios.post).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Some Etsy orders have blocking case(s) and cannot be pushed to production',
      orders: [{
        orderId: 'ETSY-BLOCKED',
        cases: [{ id: 'case-1', name: 'Customer Change Request' }],
      }],
    });
  });

  test('blocks Etsy production push when selected order is missing fulfillment file', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const order = {
      orderId: 'ETSY-MISSING-PREREQ',
      status: 'New',
      scale_overall_status: 'Failed',
      case: [],
      seller: {},
      items: [{ transactionId: 'tx-1', fulfillment_file: {}, cost_breakdown: {} }],
      save,
    };
    mockFindChain([order]);

    const req = {
      body: { orderIds: ['ETSY-MISSING-PREREQ'] },
      user: { role: 'Admin', _id: 'user-1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.pushEtsyPlatformOrders(req, res);

    expect(axios.post).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Some Etsy orders are missing production prerequisites',
      orders: [{
        orderId: 'ETSY-MISSING-PREREQ',
        errors: [
          { itemId: 'tx-1', code: 'MISSING_FULFILLMENT_FILE', message: 'Missing fulfillment file' },
        ],
      }],
    });
  });

  test('pushes Etsy production with LNG override when selected order is missing vendor mapping', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const order = {
      orderId: 'ETSY-LNG-OVERRIDE',
      status: 'New',
      scale_overall_status: 'Ready',
      case: [],
      seller: {},
      shopId: { _id: 'shop-1', name: 'Etsy Shop' },
      buyer: {},
      shipping: {},
      items: [{ transactionId: 'tx-1', fulfillment_file: { front: 'https://cdn.example/front.png' }, cost_breakdown: {} }],
      markModified: jest.fn(),
      save,
    };
    mockFindChain([order]);
    axios.post.mockResolvedValue({ data: { success: true, received: 1, inserted: 1, updated: 0, skipped: 0, errorsCount: 0, errors: [] } });

    const req = {
      body: { orderIds: ['ETSY-LNG-OVERRIDE'] },
      user: { role: 'Admin', _id: 'user-1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.pushEtsyPlatformOrders(req, res);

    expect(axios.post.mock.calls[0][1].data[0].items[0].cost_center).toEqual(expect.objectContaining({
      vendorKey: 'lng',
      vendor_mapping_override: true,
    }));
    expect(res.status).not.toHaveBeenCalled();
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
