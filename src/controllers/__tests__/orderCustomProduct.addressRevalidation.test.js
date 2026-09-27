jest.mock('../../models', () => ({
  orderCustomProduct: { find: jest.fn(), updateOne: jest.fn() },
  shop: {}, configCostCenter: {}, vendorCostCenter: {}, vendorProduct: {},
  configOptionMapping: {}, user: {}, SkuMappingConfig: {}, SkuMappingEntry: {},
  listing: {}, PsdTask: {}, OrderHistory: {},
}));

jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const db = require('../../models');
const controller = require('../orderCustomProduct.controller');

const response = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() });

test('reopens an address-invalid order after batch revalidation succeeds', async () => {
  const query = { select: jest.fn(), sort: jest.fn(), limit: jest.fn(), lean: jest.fn() };
  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.lean.mockResolvedValue([{
    orderId: 'ORDER-1',
    customer_infor: { address: '1 Main St', city: 'Austin', state: 'TX', zip_code: '78701' },
    address_validation: { isValid: false },
    scale_overall_status: 'Address Invalid',
    items: [{ scale_status: 'Pending' }],
  }]);
  db.orderCustomProduct.find.mockReturnValue(query);
  db.orderCustomProduct.updateOne.mockResolvedValue({ modifiedCount: 1 });
  axios.get.mockResolvedValue({ data: [{ delivery_line_1: '1 Main St' }] });
  const res = response();

  await controller.validateInvalidAddressesBatch({ query: { status: 'New' } }, res);

  expect(db.orderCustomProduct.updateOne).toHaveBeenCalledWith(
    { orderId: 'ORDER-1' },
    { $set: expect.objectContaining({
      'address_validation.isValid': true,
      'address_validation.checkedAt': expect.any(Date),
      scale_overall_status: 'Pending',
    }) }
  );
});
