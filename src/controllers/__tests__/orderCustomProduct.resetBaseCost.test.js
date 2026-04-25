jest.mock('../../models', () => ({
  orderCustomProduct: { findOne: jest.fn() },
  shop: {},
  configCostCenter: {},
  vendorCostCenter: {},
  vendorProduct: {},
  configOptionMapping: {},
  user: {},
  SkuMappingConfig: {},
  SkuMappingEntry: {},
  listing: {},
  PsdTask: {},
  OrderHistory: {},
}));

jest.mock('../../service/orderHistoryLogger', () => ({
  logOrderHistory: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../../models');
const { logOrderHistory } = require('../../service/orderHistoryLogger');
const controller = require('../orderCustomProduct.controller');

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('resetBaseCost', () => {
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

    await controller.resetBaseCost(req, res);

    expect(db.orderCustomProduct.findOne).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'Missing orderId' });
  });

  test('returns 404 when order is not found', async () => {
    db.orderCustomProduct.findOne.mockResolvedValue(null);

    const req = {
      body: { orderId: 'ORDER-404' },
      user: { _id: 'u1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.resetBaseCost(req, res);

    expect(db.orderCustomProduct.findOne).toHaveBeenCalledWith({ orderId: 'ORDER-404' });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Order not found' });
  });

  test('resets base cost and removes item cost breakdown successfully', async () => {
    const save = jest.fn().mockResolvedValue(true);
    const order = {
      _id: 'oid-1',
      orderId: '114-1742171-9101033',
      base_cost: 21.6,
      base_cost_shipping_groups: [{ group_key: 'g1', shipping_total_for_group: 7.5 }],
      base_cost_computed_at: new Date('2026-04-23T01:17:11.313Z'),
      items: [
        { orderItemId: '1', cost_breakdown: { matchedSku: 'SKU-1' } },
        { orderItemId: '2', cost_breakdown: null },
        { orderItemId: '3', cost_breakdown: { matchedSku: 'SKU-3' } },
      ],
      save,
    };
    db.orderCustomProduct.findOne.mockResolvedValue(order);

    const req = {
      body: { orderId: '114-1742171-9101033' },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.resetBaseCost(req, res);

    expect(order.base_cost).toBe(0);
    expect(order.base_cost_shipping_groups).toEqual([]);
    expect(order.base_cost_computed_at).toBeNull();
    expect(order.items[0].cost_breakdown).toBeUndefined();
    expect(order.items[1].cost_breakdown).toBeUndefined();
    expect(order.items[2].cost_breakdown).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(1);
    expect(logOrderHistory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'UPDATE_BASE_COST',
      description: 'Order base cost reset to 0 and item cost breakdown removed',
      changes: expect.arrayContaining([
        expect.objectContaining({ field: 'base_cost', from: 21.6, to: 0 }),
        expect.objectContaining({ field: 'base_cost_shipping_groups', to: [] }),
        expect.objectContaining({ field: 'base_cost_computed_at', to: null }),
        expect.objectContaining({
          field: 'items.cost_breakdown',
          from: '2 item(s) had cost breakdown',
          to: 'removed',
        }),
      ]),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Order base cost reset successfully',
      orderId: '114-1742171-9101033',
      base_cost: 0,
      removedCostBreakdownCount: 2,
    });
  });
});
