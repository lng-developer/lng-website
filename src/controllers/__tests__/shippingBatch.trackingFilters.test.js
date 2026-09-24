jest.mock('../../models', () => ({}));

const { _test } = require('../shippingBatch.contrller');

describe('check-orders tracking filters', () => {
  test('matches the selected vendor, carrier, and carrier-handoff state on the same item', () => {
    const query = _test.buildCheckOrdersQuery('shop-1', {
      vendor: 'MerchFox',
      carrier: 'USPS',
      carrierHandoff: 'yes',
    });

    expect(query.items).toEqual({
      $elemMatch: {
        'tracking_info.fulfillment': { $regex: '^MerchFox$', $options: 'i' },
        'tracking_info.carrier': { $regex: '^USPS$', $options: 'i' },
        'tracking_info.actualShipAt': { $type: 'date' },
      },
    });
  });

  test('keeps the no-tracking condition when a vendor is selected', () => {
    const query = _test.buildCheckOrdersQuery('shop-1', { vendor: 'MerchFox', tracking: 'no' });

    expect(query.$nor).toEqual([{ items: { $elemMatch: { 'tracking_info.tracking': { $regex: '^(?!-+$).*\\S' } } } }]);
  });
});
