const mockHandler = jest.fn((_req, res) => res?.json?.({ ok: true }));
const mockController = () =>
  new Proxy(
    {},
    {
      get(target, prop) {
        if (!target[prop]) target[prop] = mockHandler;
        return target[prop];
      },
    }
  );

jest.mock("../../middlewares/auth.middleware", () => ({
  authenticateToken: jest.fn((_req, _res, next) => next()),
  authorizeRoles: jest.fn(() => (_req, _res, next) => next()),
}));

jest.mock("../../controllers/orderCustomProduct.controller", () => {
  const controller = mockController();
  controller.upload = { single: jest.fn(() => mockHandler) };
  return controller;
});

jest.mock("../../controllers/autoConfig.controller", () => mockController());
jest.mock("../../controllers/ext.controller", () => mockController());
jest.mock("../../controllers/productType.controller", () => mockController());
jest.mock("../../controllers/skuMappingConfig.controller", () => mockController());
jest.mock("../../controllers/skuMapping.controller", () => mockController());
jest.mock("../../service/etsyCustomFile.service", () => mockController());

jest.mock("../../controllers", () => ({
  etsyOrderController: mockController(),
  scaleController: mockController(),
  shippingBatchController: mockController(),
  vendorController: mockController(),
  vendorProductController: mockController(),
  vendorCostCenterController: mockController(),
  shopController: mockController(),
}));

jest.mock("../../controllers/points.controller", () => mockController());

const { authenticateToken } = require("../../middlewares/auth.middleware");

function routeHasAuth(router, method, path) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );
  if (!layer) return false;
  return layer.route.stack.some((entry) => entry.handle === authenticateToken);
}

function routeIndex(router, method, path) {
  return router.stack.findIndex(
    (entry) => entry.route?.path === path && entry.route.methods[method]
  );
}

describe("portal critical routes require authenticateToken", () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test("custom order mutating portal routes are authenticated", () => {
    const router = require("../orderCustomProduct.routes");
    [
      ["post", "/update-from-xlsx"],
      ["post", "/cancel-from-excel"],
      ["post", "/:orderId/validate-address"],
      ["post", "/orders/address/validate-invalid"],
      ["post", "/update-tracking"],
    ].forEach(([method, path]) => {
      expect(routeHasAuth(router, method, path)).toBe(true);
    });
  });

  test("etsy mutating portal routes are authenticated", () => {
    const router = require("../etsyOrder.routes");
    [
      ["post", "/import"],
      ["patch", "/sumbittedoetsy"],
      ["patch", "/:orderId/tracking"],
      ["put", "/:orderId/tracking"],
      ["patch", "/:orderId/items/:transactionId/tracking"],
      ["put", "/:orderId/items/:transactionId/tracking"],
      ["post", "/compute-base-cost"],
    ].forEach(([method, path]) => {
      expect(routeHasAuth(router, method, path)).toBe(true);
    });
  });

  test("config and master-data mutating routes are authenticated", () => {
    const cases = [
      [require("../scale.routes"), "put", "/orders/reset/bulk"],
      [require("../autoConfig.routes"), "post", "/"],
      [require("../autoConfig.routes"), "put", "/:id"],
      [require("../autoConfig.routes"), "delete", "/:id"],
      [require("../autoConfig.routes"), "post", "/run-vendor-sync"],
      [require("../vendor.routes"), "post", "/"],
      [require("../vendor.routes"), "put", "/:id"],
      [require("../vendor.routes"), "delete", "/:id"],
      [require("../vendor.routes"), "post", "/update-status"],
      [require("../vendorProduct.routes"), "post", "/"],
      [require("../vendorProduct.routes"), "put", "/:id"],
      [require("../vendorProduct.routes"), "delete", "/:id"],
      [require("../vendorProduct.routes"), "post", "/import-excel"],
      [require("../vendorCostCenter.routes"), "post", "/"],
      [require("../vendorCostCenter.routes"), "put", "/:id"],
      [require("../vendorCostCenter.routes"), "delete", "/:id"],
      [require("../vendorCostCenter.routes"), "post", "/update-status"],
      [require("../vendorCostCenter.routes"), "post", "/import"],
      [require("../vendorCostCenter.routes"), "post", "/bulk-update"],
      [require("../skuMapping.routes"), "post", "/config"],
      [require("../skuMapping.routes"), "patch", "/config/:id"],
      [require("../skuMapping.routes"), "post", "/config/:id/active"],
      [require("../skuMapping.routes"), "post", "/apply"],
      [require("../productType.routes"), "put", "/:groupId/reorder"],
    ];

    cases.forEach(([router, method, path]) => {
      expect(routeHasAuth(router, method, path)).toBe(true);
    });
  });

  test("shipping batch portal actions are authenticated", () => {
    const router = require("../shippingBatch.routes");
    [
      ["get", "/"],
      ["post", "/"],
      ["post", "/:batchId/update-from-system"],
      ["post", "/export-orders-with-tracking"],
      ["post", "/manual-upload-task"],
      ["post", "/create-from-orders"],
    ].forEach(([method, path]) => {
      expect(routeHasAuth(router, method, path)).toBe(true);
    });
  });

  test("specific GET routes are registered before dynamic id routes", () => {
    const vendorProduct = require("../vendorProduct.routes");
    expect(routeIndex(vendorProduct, "get", "/get-vendor-products-by-vendor-id/:vendorId"))
      .toBeLessThan(routeIndex(vendorProduct, "get", "/:id"));

    const vendorCostCenter = require("../vendorCostCenter.routes");
    expect(routeIndex(vendorCostCenter, "get", "/by-product/:vendorProductId"))
      .toBeLessThan(routeIndex(vendorCostCenter, "get", "/:id"));
    expect(routeIndex(vendorCostCenter, "get", "/variants/:vendorProductId/lookup"))
      .toBeLessThan(routeIndex(vendorCostCenter, "get", "/variants/:vendorProductId"));
    expect(routeIndex(vendorCostCenter, "get", "/variants/:vendorProductId"))
      .toBeLessThan(routeIndex(vendorCostCenter, "get", "/:id"));

    const shop = require("../shop.routes");
    expect(routeIndex(shop, "get", "/ext/clients"))
      .toBeLessThan(routeIndex(shop, "get", "/:id"));

    const points = require("../points.routes");
    expect(routeIndex(points, "get", "/all/with-logs"))
      .toBeLessThan(routeIndex(points, "get", "/:userId/logs"));
  });
});
