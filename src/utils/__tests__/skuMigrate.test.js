const { resolveMappedSku } = require("../skuMigrate");

test("resolveMappedSku applies the first matching active config without changing an unmapped SKU", () => {
  expect(
    resolveMappedSku("J2536-NK-010726-04", [
      { employeeMap: { J2536: "J2605" }, options: { upperProduct: false } },
    ])
  ).toBe("J2605-NK-010726-04");

  expect(
    resolveMappedSku("J9999-NK-010726-04", [
      { employeeMap: { J2536: "J2605" }, options: { upperProduct: false } },
    ])
  ).toBe("J9999-NK-010726-04");
});
