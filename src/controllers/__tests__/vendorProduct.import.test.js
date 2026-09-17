jest.mock('../../models', () => ({
  vendor: { findById: jest.fn() },
  vendorProduct: { findOneAndUpdate: jest.fn() },
  vendorCostCenter: { findOneAndUpdate: jest.fn() },
}));
jest.mock('xlsx', () => ({
  readFile: jest.fn(),
  utils: { sheet_to_json: jest.fn() },
}));

const db = require('../../models');
const XLSX = require('xlsx');
const { importVendorProductFromExcel } = require('../vendorProduct.controller');

describe('importVendorProductFromExcel', () => {
  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

  beforeEach(() => {
    jest.clearAllMocks();
    db.vendor.findById.mockResolvedValue({ _id: 'vendor-1' });
    XLSX.readFile.mockReturnValue({ SheetNames: ['Products'], Sheets: { Products: {} } });
  });

  it('upserts one product and its variants from a unified file', async () => {
    XLSX.utils.sheet_to_json.mockReturnValue([
      {
        product_id: 'G5000', product_name: 'Gildan 5000', image: 'https://image',
        sku: 'G5000-BLK-S', vendor_size: 'S', vendor_color: 'Black',
        standard_size: 'S', standard_color: 'Black', base_cost: '5.5',
        domestic_economy: '4', domestic_additional: '1',
        international_economy: '8', international_additional: '2', printing_method: 'dtg',
      },
      {
        product_id: 'G5000', product_name: 'Gildan 5000',
        sku: 'G5000-BLK-M', vendor_size: 'M', vendor_color: 'Black',
      },
    ]);
    db.vendorProduct.findOneAndUpdate.mockResolvedValue({ _id: 'product-1' });
    db.vendorCostCenter.findOneAndUpdate.mockResolvedValue({});
    const res = response();

    await importVendorProductFromExcel({ body: { vendor_id: 'vendor-1' }, file: { path: 'upload.xlsx' } }, res);

    expect(db.vendorProduct.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(db.vendorCostCenter.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(db.vendorCostCenter.findOneAndUpdate).toHaveBeenCalledWith(
      { vendor_product: 'product-1', sku: 'G5000-BLK-S', vendor_size: 'S', vendor_color: 'Black' },
      expect.objectContaining({ $set: expect.objectContaining({ printing_method: 'DTG', base_cost: 5.5 }) }),
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ productsUpserted: 1, variantsUpserted: 2 }));
  });

  it('accepts a one-size variant with only a SKU', async () => {
    XLSX.utils.sheet_to_json.mockReturnValue([
      { product_id: 'ASOM', product_name: 'Acrylic Shape Ornament', sku: 'LNGASOM', base_cost: 1.33 },
    ]);
    db.vendorProduct.findOneAndUpdate.mockResolvedValue({ _id: 'product-1' });
    const res = response();

    await importVendorProductFromExcel({ body: { vendor_id: 'vendor-1' }, file: { path: 'upload.xlsx' } }, res);

    expect(db.vendorProduct.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(db.vendorCostCenter.findOneAndUpdate).toHaveBeenCalledWith(
      { vendor_product: 'product-1', sku: 'LNGASOM', vendor_size: '', vendor_color: '' },
      expect.any(Object),
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('rejects a variant field without a SKU before writing any records', async () => {
    XLSX.utils.sheet_to_json.mockReturnValue([
      { product_id: 'G5000', product_name: 'Gildan 5000', vendor_size: 'S' },
    ]);
    const res = response();

    await importVendorProductFromExcel({ body: { vendor_id: 'vendor-1' }, file: { path: 'upload.xlsx' } }, res);

    expect(db.vendorProduct.findOneAndUpdate).not.toHaveBeenCalled();
    expect(db.vendorCostCenter.findOneAndUpdate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
