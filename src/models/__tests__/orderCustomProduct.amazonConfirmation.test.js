const OrderCustomProduct = require("../orderCustomProduct.model");

test("stores the Amazon confirmation reservation lifecycle on an order", () => {
  const path = OrderCustomProduct.schema.path("amazonConfirmation");

  expect(path.schema.path("state").enumValues).toEqual([
    "reserved",
    "submitted",
    "confirmed",
    "needs_review",
    "failed",
  ]);
  expect(path.schema.path("batchId").instance).toBe("ObjectId");
  expect(path.schema.path("amazonBatchId").instance).toBe("String");
  expect(path.schema.path("reservedAt").instance).toBe("Date");
  expect(path.schema.path("submittedAt").instance).toBe("Date");
  expect(path.schema.path("finalizedAt").instance).toBe("Date");
});
