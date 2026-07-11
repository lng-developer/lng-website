# Etsy Replace Order API For FE

## Muc dich

API nay tao mot don Etsy replacement tu don goc, giong luong replace order ben Amazon/custom-product.

FE dung API nay khi CS/Admin/Seller can tao don san xuat lai cho mot hoac nhieu item trong don Etsy.

## Endpoint

```http
POST /api/etsy/:orderId/replace
Authorization: Bearer <token>
Content-Type: application/json
```

Route live:

- Mount: `server.js` mount Etsy routes tai `/api/etsy`
- Route: `src/routes/etsyOrder.routes.js`
- Controller: `createEtsyReplacementOrder` trong `src/controllers/etsyOrder.controller.js`

Role duoc phep goi:

- `Customer Service`
- `Admin`
- `Seller`

## Params

| Field | Type | Required | Mo ta |
| --- | --- | --- | --- |
| `orderId` | string | yes | `orderId` cua don Etsy goc can replace. Nam tren URL. |

Vi du:

```http
POST /api/etsy/ETSY-1001/replace
```

## Body

```json
{
  "transactionIds": ["1234567890"],
  "note": "Replace wrong size"
}
```

| Field | Type | Required | Mo ta |
| --- | --- | --- | --- |
| `transactionIds` | string[] | conditional | Danh sach item Etsy can replace. Bat buoc neu don goc co nhieu item. Khong can gui neu don goc chi co 1 item. |
| `orderItemIds` | string[] | no | Alias tuong thich voi UI Amazon. Backend se dung `transactionIds` truoc; neu khong co thi fallback sang `orderItemIds`. |
| `note` | string | no | Ly do replace. Backend gan note nay vao `cs_note` cua item moi va `replace_meta.reason`. |

## Quy tac chon item

Etsy dung `transactionId` lam item id chinh.

- Don goc co 1 item: FE co the chi goi API voi body `{ "note": "..." }`.
- Don goc co nhieu item: FE phai gui `transactionIds`.
- Neu FE dang reuse component Amazon co field `orderItemIds`, co the gui `orderItemIds`; backend van support alias nay.
- Neu gui ca `transactionIds` va `orderItemIds`, backend uu tien `transactionIds`.

## Behavior khi tao don replace

Backend se:

- Tim don Etsy goc theo `orderId`.
- Tao `orderId` moi bang hau to `-R1`, `-R2`, `-R3`...
- Neu don goc da la `ETSY-1001-R1`, replacement tiep theo van tinh theo base `ETSY-1001` va tao so tiep theo.
- Copy thong tin chung tu don goc: `shopId`, `seller`, `buyer`, `shipping`, `customer_infor`, `shipping_type`, `totals`, coupon/payment/order type.
- Chi copy cac item duoc chon.
- Tao `transactionId` moi cho item replacement, giong cach Amazon tao `orderItemId` moi.
- Gan `orderItemId` cua item moi bang chinh `transactionId` moi de FE reuse UI cu de dang hon.
- Copy custom data cua item nhu SKU, title, customization, image, custom files.
- Reset cac field san xuat/fulfillment/tracking/cost cua don moi.
- Re-run Smarty validation cho dia chi US neu can.
- Ghi order history action `CREATE_REPLACEMENT_ORDER`.

## Trang thai va field bi reset

Order moi:

```json
{
  "status": "New",
  "scale_overall_status": "Need Scale",
  "base_cost": 0,
  "base_cost_computed_at": null,
  "base_cost_shipping_groups": [],
  "cs_assignment_status": "Unassigned",
  "sumbittedoetsy": false,
  "case": []
}
```

Item moi:

```json
{
  "tracking_info": {
    "fulfillment": "",
    "tracking": "",
    "status": "New",
    "note": "",
    "updated_at": "ISO_DATE"
  },
  "fulfillment_file": {},
  "scale_status": "Need Scale",
  "qc_note": "",
  "cs_note": "Replace wrong size"
}
```

Cost/item tracking cu khong duoc mang sang:

- `items[].cost_breakdown` bi remove.
- `vendor_submissions` cua order moi reset.
- `grabink_submission` reset ve chua sent.
- `fulfillment_platform_v2_submission` reset ve chua sent.
- `external_order_id`, `fulfilled_at`, `shippedAt` reset.

## Metadata trace replace

Order moi co `replace_meta`:

```json
{
  "is_replacement": true,
  "replace_of_order_id": "ETSY-1001",
  "created_at": "ISO_DATE",
  "reason": "Replace wrong size",
  "source_transaction_ids": ["1234567890"],
  "source_order_item_ids": ["1234567890"]
}
```

Item moi co `replace_meta`:

```json
{
  "is_replacement_item": true,
  "source_order_id": "ETSY-1001",
  "original_transaction_id": "1234567890",
  "original_order_item_id": "1234567890",
  "created_at": "ISO_DATE",
  "reason": "Replace wrong size"
}
```

FE co the dung metadata nay de hien thi:

- Don replacement nay tao tu don nao.
- Item replacement nay tao tu item goc nao.
- Ly do replace.

## Success response

```json
{
  "message": "Replacement order created",
  "source_order_id": "ETSY-1001",
  "replacement_order_id": "ETSY-1001-R1",
  "items_copied": 1,
  "selected_transaction_ids": ["66bdf5a5b8c9d1e2f3a45678"],
  "selected_order_item_ids": ["66bdf5a5b8c9d1e2f3a45678"],
  "address_validation": {
    "provider": "smarty",
    "scope": "etsy_us_street",
    "status": "valid",
    "isValid": true
  },
  "scale_overall_status": "Need Scale"
}
```

Luu y:

- `selected_transaction_ids` trong response la ID moi cua item replacement, khong phai ID item goc.
- `selected_order_item_ids` cung la ID moi, duoc tra ve de FE reuse logic item id cu.
- Neu Smarty xac dinh dia chi invalid, `scale_overall_status` co the la `Address Invalid`.

## Vi du request

### 1. Replace 1 item trong don nhieu item

```bash
curl -X POST "https://<api-host>/api/etsy/ETSY-1001/replace" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "transactionIds": ["1234567890"],
    "note": "Replace wrong size"
  }'
```

### 2. Replace don Etsy chi co 1 item

```bash
curl -X POST "https://<api-host>/api/etsy/ETSY-1002/replace" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "note": "Buyer requested replacement"
  }'
```

### 3. FE reuse payload Amazon voi `orderItemIds`

```json
{
  "orderItemIds": ["1234567890"],
  "note": "Replace damaged item"
}
```

Backend van chap nhan, nhung FE nen uu tien dung `transactionIds` cho Etsy.

## Error cases

### 404 - Khong tim thay don Etsy

```json
{
  "message": "Etsy order not found"
}
```

### 400 - Don goc khong co item

```json
{
  "message": "Source order has no items"
}
```

### 400 - Don nhieu item nhung FE khong gui item id

```json
{
  "message": "This Etsy order has multiple items. Please provide body.transactionIds as an array of transactionId to replace.",
  "availableTransactionIds": ["1234567890", "9876543210"],
  "availableOrderItemIds": ["1234567890", "9876543210"]
}
```

### 400 - Gui item id khong khop don goc

```json
{
  "message": "No matching transactionIds found in source Etsy order",
  "availableTransactionIds": ["1234567890", "9876543210"],
  "availableOrderItemIds": ["1234567890", "9876543210"]
}
```

### 500 - Loi server

```json
{
  "message": "Failed to create replacement order",
  "error": "..."
}
```

## Goi y ghep FE

1. O man hinh Etsy order detail, khi user bam Replace, lay danh sach item dang chon.
2. Neu order co nhieu item, bat buoc gui `transactionIds`.
3. Neu order co 1 item, co the khong gui `transactionIds`, nhung gui cung khong sao.
4. Sau khi API success, FE nen navigate hoac refresh den `replacement_order_id`.
5. FE khong nen tiep tuc thao tac tren item id cu cho don moi. Dung `selected_transaction_ids` response neu can focus item moi.
6. Neu `scale_overall_status = "Address Invalid"`, FE nen hien thi canh bao dia chi va cho user sua dia chi truoc khi scale/send vendor.

## Khac voi Amazon

- Amazon/custom-product chon item bang `orderItemIds`.
- Etsy chon item bang `transactionIds`.
- Backend Etsy van tra `selected_order_item_ids` va support body `orderItemIds` de FE reuse component, nhung canonical field cua Etsy la `transactionId`.
