# LNG Website — Backend

## Tổng quan

`LNG Website` là một nền tảng backend Node.js/Express cho quản lý đơn hàng, fulfillment và workflow cho các cửa hàng bán hàng tùy chỉnh (ví dụ trên Etsy/Amazon). Ứng dụng tổ chức các luồng chính: nhập đơn (marketplace integrations), ánh xạ SKU → vendor, tính toán chi phí, tạo task thiết kế (PSD), QC, gửi đơn đến vendor để in/sản xuất, quản lý tracking và báo cáo.

Phiên bản hiện tại là một modular monolith (all-in-one) với các thành phần chính trong `src/` và scripts tự động trong root.

## Mục đích tài liệu

Tài liệu này mô tả chi tiết cách hệ thống hoạt động để giúp các developer mới / hiện tại nhanh hiểu codebase, chạy local, phát triển tính năng mới và vận hành sản phẩm.

---

## 1. Kiến trúc tổng quan

- Entry point: `server.js` — thiết lập Express, kết nối MongoDB, khởi tạo Socket.IO và đăng ký routes.
- Folder chính: `src/` chứa `controllers/`, `service/`, `models/`, `routes/`, `socket/`, `workers/` (đề xuất), `utils/`.
- Queue: `bullmq` + Redis được dùng cho job queue & background workers.
- Storage: Cloudinary / AWS S3 cho media; local `uploads/` cho dev.
- DB: MongoDB + Mongoose models.

Component diagram (tóm tắt):

- Clients (Admin UI, QC terminal, Designer app, Seller app)
  ↕ (HTTP + WebSocket)
- API Server (Express + Socket.IO)
  ↕
- Services (in-process): Etsy integration, Amazon integration, Fulfillment service, PSD task manager, Reporting.
  ↕
- Workers (BullMQ consumers) → Vendor APIs, heavy processing (image processing, excel reports)
  ↕
- MongoDB (orders, listings, psd tasks, users, vendors, shipping batches)

---

## 2. Luồng dữ liệu chính (Order lifecycle)

1) Import orders
- Source: Etsy CSV/Reports (hiện có), Amazon (SP‑API) — import bằng route hoặc background job.
- Controller: `src/controllers/etsyOrder.controller.js` (Etsy). Khi import file, hệ thống parse CSV/Excel, tạo `EtsyOrder` record với `orderId`, `items[]`, `buyer`, `seller`.

2) Processing / Compute base cost
- Service: `src/controllers/orderCustomProduct.controller.js` + `src/service/*` xử lý ánh xạ SKU → `VendorProduct`, lấy giá base, thêm phí in/embroidery, tính shipping, lưu `cost_breakdown` vào `OrderCustomProduct`.

3) PSD / Design
- Nếu sản phẩm yêu cầu design mới, hệ thống tạo `PsdTask` (model + controller). Designer upload snapshot/outputs, cập nhật listing.

4) QC
- QC staff review đơn trong `qc.controller.js`. Mỗi item có `scale_status`. Sau QC, order có thể chuyển sang `Ready`.

5) Fulfillment / Submit to Vendor
- Khi `scale_overall_status = Ready`, hệ thống gửi order tới vendor (Grabink, Merchfox, ...).
- Provider adapters (service layer) gọi vendor API, lưu `vendor_submissions` (idempotent).

6) Tracking & Shipping Batch
- Vendors trả tracking → cập nhật order.
- Upload tracking lên Amazon (batches) hoặc cập nhật marketplace.

### Fulfillment Platform v2 callback

LNG only mirrors the order lifecycle. Fulfillment Platform v2 owns Viettel Post credentials, wallet, label and carrier polling. Configure only `FULFILLMENT_LIFECYCLE_WEBHOOK_SECRET` in LNG; it must match Fulfillment's callback secret. The receiver is `POST /api/vendor-webhooks/fulfillment-platform-v2` and verifies the exact HMAC body, timestamp and event id before persisting safe metadata. Do not put Viettel Post credentials in LNG.

For staging, replay a signed mock `shipment.label_ready` callback first. It records pending label/tracking only. Replay `shipment.carrier_handoff_confirmed` next to set `actualShipAt` and allow the normal marketplace-tracking path. Do not use this verification to create a real carrier shipment.

7) Reporting
- Scripts và services tạo báo cáo Excel/CSV (`daily_orders_report.js`, `export-orders.js`).

---

## Detailed Feature Flows (Chi tiết chức năng chính)

Đoạn sau mô tả chi tiết từng chức năng cốt lõi: cách kéo order, xử lý, tìm vendor, tính base cost và các bước tiếp theo.

1) Kéo order về (Ingestion)
- Etsy: hiện hệ thống nhận import từ file CSV/Excel (route `POST /api/etsy/import`). Flow: user upload file → parser (`csv-parse` / `xlsx`) → tạo `EtsyOrder` records (upsert theo `orderId`).
- Amazon (SP‑API): recommended flow:
  - Gọi `getOrders` với `MarketplaceIds` + `CreatedAfter`/`LastUpdatedAfter` để lấy danh sách `AmazonOrderId`.
  - Với mỗi `AmazonOrderId` gọi `getOrderItems` để lấy items chi tiết (SellerSKU/ASIN, quantity, itemPrice).
  - Upsert vào DB (`EtsyOrder` hoặc `OrderCustomProduct`) theo `AmazonOrderId` để đảm bảo idempotency.
  - Handle pagination, rate limits, retry/backoff. Nếu chưa có creds, sử dụng mock fixtures (`scripts/fixtures/amazonOrders.json`).

2) Xử lý order (Normalization & Mapping)
- Sau import, hệ thống chạy pipeline mapping:
  - Parse SKU/transaction info → extract seller code / product code.
  - Áp dụng `skuMapping` rules (equals, contains, regex) từ config để map SKU → `VendorProduct` hoặc internal `productId`.
  - Enrich order: lookup `Listing`, `VendorProduct`, seller account, shop info.
  - Validate address (Smarty) và flag `address_validation` nếu invalid.

3) Tìm vendor (Vendor selection)
- Rule priority:
  1. Explicit vendor set on order/listing
  2. Vendor mapped via `VendorProduct` (preferred)
  3. Auto-detect by capability (provider.canHandle(order))
  4. Fallback default vendor (e.g., `grabink`)
- Vendor config stored in `VendorProduct` includes `vendor_key`, `cost_by_size`, `additional_costs`, `shipping_config`.

4) Tính `base_cost` (Cost breakdown)
- Steps:
  1. For each item, read `VendorProduct` cost_by_size for the requested size.
  2. Add customization costs (embroidery, extra print positions) from product config.
  3. Calculate item-level shipping (vendor shipping config: base + per_unit).
  4. Apply discounts, coupons, or marketplace fees if needed.
  5. Store `cost_breakdown` per item: `{ base_cost_each, additional_costs, shipping_each, total_each }`.
- Example formula (per item):
  - base_cost_each = vendor_price[size]
  - extra = embroidery_price + two_sided_price
  - shipping_each = vendor_shipping.base + vendor_shipping.per_unit * qty
  - total_each = base_cost_each + extra + (shipping_each / qty)

5) PSD / Design workflow
- If item requires design (new listing or missing template) → create `PsdTask` with links to listing and order item.
- Designer updates task, uploads output to Cloudinary/S3 and sets `psd.status = Available`.

6) QC workflow
- QC staff fetches pending orders (`GET /api/fulfillment/qc`). For each item QC checks images, custom text, address, and cost. QC updates item `scale_status` (`Ready` / `QC Rejected`).
- On `Ready` for all items, order `scale_overall_status` becomes `Ready`.

7) Fulfillment submission
- When order ready, a worker picks it and submits to the selected vendor:
  - Build payload according to vendor API contract.
  - Submit via provider adapter (`src/service/fulfillment/providers/*`).
  - Persist `vendor_submissions[vendorKey] = { sent: true, sent_at, external_id, last_response }`.
  - Update order status to `Fulfilled`/`Sent` and emit socket event `order:fulfilled`.
- Submission must be idempotent — check `vendor_submissions[vendorKey].sent` before sending.

8) Tracking & post-fulfillment
- Vendor sends tracking via webhook or worker polls vendor API. Update `items[].tracking_info` and change order status to `Shipped`.
- For marketplaces (Amazon), create `ShippingBatch` and call merchant API to upload tracking in batch.

9) Error handling, retries & DLQ
- For external API calls implement retry with exponential backoff and max attempts. Failures go to Dead Letter Queue (DLQ) for manual review.
- Log full error context into `OrderHistory` and central logs for troubleshooting.

10) Idempotency & consistency
- Use `orderId` (marketplace ID) as unique key and upsert on import.
- Worker operations should use optimistic updates and locking if concurrent workers may operate on same order (e.g., Redis lock per orderId).

11) Rate limiting & concurrency
- Throttle `getOrderItems` and vendor calls using `p-limit` or queue concurrency settings. Respect SP‑API quotas and vendor limits.

12) Testing these flows
- Unit tests: mock external APIs (`nock`) and assert mapping & cost calculation.
- Integration: run `scripts/import-amazon-mock.js` to seed DB and exercise downstream flows (compute-base-cost → create PsdTask → QC → submit worker).

---

## 3. Thư mục chính và mô tả

- `server.js` — entry point.
- `src/controllers/` — HTTP controllers; mỗi file xử lý endpoints cho domain.
- `src/service/` — business logic, provider adapters, helper functions.
- `src/models/` — Mongoose schemas (OrderCustomProduct, EtsyOrder, Listing, PsdTask, User, VendorProduct, ShippingBatch, OrderHistory, ...).
- `src/routes/` — route registration.
- `src/socket/` — Socket.IO setup and event handlers.
- `src/utils/` — helper utilities (sku mapping, cloudinary, address validation, etc.).
- `scripts/` — ad-hoc scripts và batch jobs (đã có nhiều file ở root; nên move vào `scripts/`).
- `uploads/` — media uploads (dev only).

---

## 4. Các model quan trọng (tóm tắt)

- `OrderCustomProduct`: orderId, items[{sku, qty, cost_breakdown, tracking_info, scale_status}], customer_info, status, scale_overall_status, vendor_submissions, sellerId, shopId.
- `EtsyOrder`: raw import record từ Etsy.
- `Listing`: asin, product_image, psd.status, seller, template.
- `PsdTask`: listing ref, status, outputs.
- `VendorProduct`: vendor reference, cost_by_size, additional_costs, shipping_config.

---

## 5. External Integrations

- Etsy: import orders via CSV/Excel; controllers under `src/controllers/etsy*`.
- Amazon SP‑API: (planned) use `amazon-sp-api` wrapper; endpoints: `getOrders`, `getOrderItems`, Reports API, Selling Partner Notifications (SPN).
- Vendors: Grabink / Merchfox / others — provider adapters implemented in `src/service/fulfillment`.
- Cloudinary / AWS S3: image storage and CDN access.
- Smarty (or similar): address validation before submission.

---

## 6. Realtime (Socket.IO)

- Socket server initialized in `src/socket/`.
- Clients join rooms by `shopId` and `machineId`.
- Events emitted: `presence:update`, `order:updated`, `order:fulfilled`, `order:shipped`.

---

## 7. Background jobs & workers

- Queue: `bullmq` used for background processing (long-running tasks, vendor submissions, report generation).
- Suggestion: move heavy scripts into `src/workers/` as named consumers. Example worker responsibilities:
  - Submit orders to vendors and handle responses
  - Process images (Sharp) and upload to Cloudinary
  - Generate Excel reports and store in S3/Cloudinary

---

## 8. How to run (dev)

Prerequisites:
- Node.js (recommended 18+)
- MongoDB (local or remote)
- Redis (for BullMQ)

1) Install deps
```bash
npm install
```

2) Create `.env` in project root (DEV example):
```
MONGODB_URI=mongodb://localhost:27017/lng-dev
PORT=5000
NODE_ENV=development
CLOUDINARY_URL=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AMAZON_CLIENT_ID=...
AMAZON_CLIENT_SECRET=...
AMAZON_REFRESH_TOKEN=...
AWS_ROLE_ARN=...
AMAZON_MARKETPLACE_ID=...
JWT_SECRET=your_jwt_secret
```

3) Start server (development)
```bash
npm run dev
```

4) Worker (example)
- Workers can be run as separate processes (e.g., `node src/workers/fulfillment.worker.js`) — we recommend using `pm2` or separate terminals for dev.

---

## 9. Endpoints quan trọng (tóm tắt)

- Auth: `POST /api/auth/login`, `POST /api/auth/refresh-token`
- Orders: `POST /api/order/compute-base-cost`, `GET /api/order/:id`, `GET /api/order/fe`
- Etsy: `POST /api/etsy/import`, `GET /api/etsy`
- Fulfillment/QC: `GET /api/fulfillment/qc`, `PATCH /api/fulfillment/qc/:id`, `POST /api/fulfillment/send`
- PSD Task: `GET /api/psd-task`, `POST /api/psd-task`
- Shipping batches: `POST /api/shipping-batches`

Xem chi tiết controllers trong `src/controllers/`.

---

## 10. Environment variables (chi tiết)

- `MONGODB_URI` — MongoDB connection string
- `PORT` — HTTP port
- `NODE_ENV` — `development|production`
- `JWT_SECRET` — secret cho JWT
- `CLOUDINARY_URL` / `CLOUDINARY_*` — Cloudinary config
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ROLE_ARN` — AWS credentials
- `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_REFRESH_TOKEN`, `AMAZON_MARKETPLACE_ID` — SP‑API
- `REDIS_URL` — Redis for BullMQ

Lưu ý: không commit file `.env`. Dùng secret manager cho prod.

---

## 11. Testing

- Unit tests: currently repo chưa có test suite đầy đủ. Khuyến nghị thêm `tests/` sử dụng `mocha`/`jest` + `nock` để mock external APIs.
- Integration tests: seed DB bằng fixture (`scripts/fixtures/`) và chạy scripts mock import.
- Manual test: sử dụng Postman để gọi endpoints import và kiểm tra DB collections.

---

## 12. Observability & Ops

- Logging: dùng `morgan` + structured logger (pino/winston) — chuyển stdout vào centralized logs trong prod.
- Metrics: instrument critical services (import rate, vendor submission success, job queue lengths).
- Monitoring: health-check endpoint (`GET /health`) và readiness/liveness probes for containerized deployments.

---

## 13. Scaling recommendations

Short term (monolith):
- Move heavy tasks to BullMQ workers and scale workers horizontally.
- Use p-limit or queue to throttle external API calls (SP‑API, vendors).
- Index heavily queried Mongo fields (orderId, sellerId, shopId, dates).

Long term (service extraction):
- Extract integration service (Etsy/Amazon) to a microservice that only ingests and normalizes orders.
- Extract fulfillment/worker service for vendor submissions and tracking updates.
- Use message broker (Redis/Kafka) for event-driven communication.

---

## 14. Troubleshooting & FAQs

- Q: Tôi thấy duplicates khi import order?  
  A: System should use `findOneAndUpdate({orderId}, upsert:true)` to keep idempotency. Check the import controller and unique index on `orderId`.

- Q: Vendor API rate limit errors?  
  A: Use retry/exponential backoff and DLQ. Ensure workers honor p-limit.

- Q: Socket events không tới client?  
  A: Verify `shopId` room join, check server `io` instance is attached to app (see `server.js`).

---

## 15. Contribution & Developer notes

- Code style: follow existing style (CommonJS modules). Keep changes modular and add tests for new services.
- When adding heavy external calls, always add a worker and queue rather than blocking HTTP request.
- Add `env.example` for any new environment variables.

---

## 16. Next steps (recommended)

1. Add `env.example` and `config/index.js` to centralize configuration.
2. Move ad-hoc scripts in project root into `scripts/` or `src/workers/`.
3. Implement a small `src/workers/fulfillment.worker.js` and move vendor submission logic there.
4. Add unit/integration tests for core flows (import, compute-cost, submit vendor).
5. Consider containerizing with Docker and creating `docker-compose` for dev (Mongo + Redis + app).

---

If you want, tôi có thể: (A) tạo `env.example` và `config/index.js` trong repo ngay bây giờ, hoặc (B) triển khai mẫu `src/service/amazon/orders.service.js` và route import để bạn test. Chọn A hoặc B.
# lng-website
# Test CI/CD
