describe("server bootstrap", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("starts pull-tracking scheduler after DB connect", async () => {
    const express = require("express");
    const listen = jest.fn((_port, _host, cb) => cb && cb());
    const close = jest.fn();
    const httpServer = { listen, close };
    const ioClose = jest.fn();
    const connectDB = jest.fn().mockResolvedValue();
    const etsyStart = jest.fn();
    const fulfillmentTrackingStart = jest.fn();
    const startAutoScheduler = jest.fn();

    jest.doMock("../../src/config/env.config", () => jest.fn());
    jest.doMock("../../src/config/db.config", () => connectDB);
    jest.doMock("http", () => ({
      createServer: jest.fn(() => httpServer),
    }));
    jest.doMock("socket.io", () => ({
      Server: jest.fn(() => ({ close: ioClose })),
    }));
    jest.doMock("../../src/socket/index", () => jest.fn());
    jest.doMock("../../src/lib/presence", () => ({}));
    jest.doMock("../../src/service/etsyVendorSyncScheduler", () => ({
      start: etsyStart,
      stop: jest.fn(),
    }));
    jest.doMock("../../src/service/fulfillmentTrackingPullScheduler", () => ({
      start: fulfillmentTrackingStart,
      stop: jest.fn(),
    }));
    jest.doMock("../../src/controllers/autoConfig.controller", () => ({
      startAutoScheduler,
    }));

    const routerNames = [
      "roleRoutes",
      "userRoutes",
      "accountRoutes",
      "authRoutes",
      "orderCustomProductRoutes",
      "shopRoutes",
      "vendorRoutes",
      "vendorProductRoutes",
      "vendorCostCenterRoutes",
      "caseRoutes",
      "listingRoutes",
      "productTypeRoutes",
      "configCostCenterRoutes",
      "configOptionMappingRoutes",
      "scaleRoutes",
      "QCRoutes",
      "reportRoutes",
      "adsRoutes",
      "skuMappingRoutes",
      "APORoutes",
      "PsdTaskRoutes",
      "ideaTaskRoutes",
      "realtimeLogRoutes",
      "teamRoutes",
      "extRoutes",
      "adminSessionRoutes",
      "PointsRoutes",
      "ShippingBatchRoutes",
      "ToDoListRoutes",
      "EtsyOrderRoutes",
      "EtsyListingRoutes",
      "EtsyMessagesRoutes",
      "autoConfigRoutes",
      "extensionLogRoutes",
      "etsyAdsRoutes",
      "vendorWebhookRoutes",
      "devRoutes",
      "shopifyRoutes",
      "orderLifecycleRoutes",
    ];
    jest.doMock("../../src/routes", () =>
      Object.fromEntries(routerNames.map((name) => [name, express.Router()]))
    );
    jest.doMock("../../src/routes/upload.router.R2", () => express.Router());

    require("../../server");
    await Promise.resolve();

    expect(connectDB).toHaveBeenCalledTimes(1);
    expect(etsyStart).toHaveBeenCalledTimes(1);
    expect(fulfillmentTrackingStart).toHaveBeenCalledTimes(1);
    expect(startAutoScheduler).toHaveBeenCalledTimes(1);
    expect(httpServer.requestTimeout).toBe(0);
    expect(listen).toHaveBeenCalledWith(5000, "0.0.0.0", expect.any(Function));
  });
});
