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

describe('markAddressValidByOrderId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('marks invalid address as valid and reopens scale status', async () => {
    const save = jest.fn().mockResolvedValue(true);
    db.orderCustomProduct.findOne.mockResolvedValue({
      _id: 'oid-1',
      orderId: '114-5065197-6682605',
      address_validation: { isValid: false, smartyResponse: null },
      scale_overall_status: 'Address Invalid',
      save,
    });

    const req = {
      params: { orderId: '114-5065197-6682605' },
      user: { _id: 'u1', email: 'cs@example.com' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.markAddressValidByOrderId(req, res);

    const order = await db.orderCustomProduct.findOne.mock.results[0].value;
    expect(order.address_validation).toEqual({ isValid: true, smartyResponse: null });
    expect(order.scale_overall_status).toBe('Need Scale');
    expect(save).toHaveBeenCalledTimes(1);
    expect(logOrderHistory).toHaveBeenCalledWith(expect.objectContaining({
      action: 'MARK_ADDRESS_VALID',
      changes: expect.arrayContaining([
        expect.objectContaining({
          field: 'address_validation.isValid',
          from: false,
          to: true,
        }),
        expect.objectContaining({
          field: 'scale_overall_status',
          from: 'Address Invalid',
          to: 'Need Scale',
        }),
      ]),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Order address marked as valid successfully',
      orderId: '114-5065197-6682605',
      addressValid: true,
      scale_overall_status: 'Need Scale',
    });
  });

  test('returns no change when order is already valid', async () => {
    const save = jest.fn().mockResolvedValue(true);
    db.orderCustomProduct.findOne.mockResolvedValue({
      _id: 'oid-2',
      orderId: 'ORDER-2',
      address_validation: { isValid: true, smartyResponse: { foo: 'bar' } },
      scale_overall_status: 'Need Scale',
      save,
    });

    const req = {
      params: { orderId: 'ORDER-2' },
      user: { _id: 'u1' },
      ip: '127.0.0.1',
      headers: { 'user-agent': 'jest' },
    };
    const res = makeRes();

    await controller.markAddressValidByOrderId(req, res);

    expect(save).not.toHaveBeenCalled();
    expect(logOrderHistory).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      message: 'No change',
      orderId: 'ORDER-2',
      addressValid: true,
      scale_overall_status: 'Need Scale',
    });
  });
});
