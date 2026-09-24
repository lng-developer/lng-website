jest.mock("../../models", () => ({
  ShippingBatch: { findById: jest.fn() },
}));

const db = require("../../models");
const controller = require("../shippingBatch.contrller");

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn(), type: jest.fn(), attachment: jest.fn(), send: jest.fn() };
  res.status.mockReturnValue(res);
  res.type.mockReturnValue(res);
  res.attachment.mockReturnValue(res);
  return res;
}

test("downloads the stored Amazon Processing Report as text", async () => {
  db.ShippingBatch.findById.mockResolvedValue({
    _id: "batch-1",
    amazonFeed: { amazonBatchId: "93703020720", reportText: "records activated: 1" },
  });
  const req = { params: { batchId: "batch-1" } };
  const res = makeRes();

  await controller.downloadAmazonFeedReport(req, res, jest.fn());

  expect(res.type).toHaveBeenCalledWith("text/plain");
  expect(res.attachment).toHaveBeenCalledWith("amazon-processing-report-93703020720.txt");
  expect(res.send).toHaveBeenCalledWith("records activated: 1");
});

test("returns 404 when no Amazon Processing Report was retained", async () => {
  db.ShippingBatch.findById.mockResolvedValue({ _id: "batch-1", amazonFeed: {} });
  const res = makeRes();

  await controller.downloadAmazonFeedReport({ params: { batchId: "batch-1" } }, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(404);
});
