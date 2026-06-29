# No Cost Center Status Sort/Filter API For FE

Tài liệu này chỉ mô tả phần FE cần để lọc/sort trạng thái đơn trong tab No Cost Center cho Amazon và Etsy.

## 1. Amazon No Cost Center List

Endpoint:

```http
GET /api/order/fe
```

Auth:

```txt
Authorization: Bearer <token>
```

Query quan trọng:

| Query | Type | Required | Description |
| --- | --- | --- | --- |
| `isNoCostCenter` | boolean string | Yes | Set `true` để chỉ lấy đơn thiếu cost center/base cost. |
| `status` | string | No | Lọc 1 trạng thái: `New`, `Fulfilled`, `Shipped`. |
| `statuses` | comma string | No | Lọc nhiều trạng thái, ví dụ `New,Fulfilled,Shipped`. Nếu có `statuses`, FE không cần gửi `status`. |
| `sortBy` | string | No | Set `status` nếu muốn sort theo trạng thái đơn. |
| `sortOrder` | string | No | `asc` hoặc `desc`. |
| `page` | number | No | Trang hiện tại. |
| `perPage` | number/string | No | Số dòng mỗi trang, hoặc `all`. |

Ví dụ lọc No Cost Center chỉ trạng thái New:

```http
GET /api/order/fe?isNoCostCenter=true&status=New&page=1&perPage=20
```

Ví dụ lọc No Cost Center theo 3 trạng thái:

```http
GET /api/order/fe?isNoCostCenter=true&statuses=New,Fulfilled,Shipped&page=1&perPage=20
```

Ví dụ sort theo trạng thái:

```http
GET /api/order/fe?isNoCostCenter=true&statuses=New,Fulfilled,Shipped&sortBy=status&sortOrder=asc
```

Response list giữ shape hiện tại:

```json
{
  "data": [],
  "totalCount": 0,
  "totalPages": 1,
  "currentPage": 1,
  "includeLogs": false,
  "logLimit": 0
}
```

## 2. Amazon Statistics

Endpoint:

```http
GET /api/order/statistic
```

Auth:

```txt
Authorization: Bearer <token>
```

Query nên gửi cùng filter với list:

```http
GET /api/order/statistic
```

Response có thêm field:

```json
{
  "all": 0,
  "new": 0,
  "noCostCenter": 0,
  "noCostCenterByStatus": {
    "new": 0,
    "fulfilled": 0,
    "shipped": 0
  },
  "fulfilled": 0,
  "shipped": 0
}
```

FE dùng `noCostCenterByStatus` để hiển thị số lượng trong tab/filter No Cost Center:

| FE label | Response key |
| --- | --- |
| New | `noCostCenterByStatus.new` |
| Fulfilled | `noCostCenterByStatus.fulfilled` |
| Shipped | `noCostCenterByStatus.shipped` |

## 3. Etsy No Cost Center List

Endpoint:

```http
GET /api/etsy
```

Auth:

```txt
Route hiện tại không gắn authenticateToken trong etsyOrder.routes.js.
Nếu FE đang có token thì vẫn có thể gửi Authorization header như các API khác.
```

Query quan trọng:

| Query | Type | Required | Description |
| --- | --- | --- | --- |
| `isNoCostCenter` | boolean string | Yes | Set `true` để chỉ lấy Etsy orders thiếu cost center/base cost. |
| `status` | string | No | Lọc 1 trạng thái: `New`, `Fulfilled`, `Shipped`. |
| `statuses` | comma string | No | Lọc nhiều trạng thái, ví dụ `New,Fulfilled,Shipped`. |
| `sortBy` | string | No | Set `status` nếu muốn sort theo trạng thái đơn. |
| `sortOrder` | string | No | `asc` hoặc `desc`. |
| `page` | number | No | Trang hiện tại. |
| `limit` | number | No | Số dòng mỗi trang. |

Ví dụ lọc No Cost Center chỉ trạng thái Fulfilled:

```http
GET /api/etsy?isNoCostCenter=true&status=Fulfilled&page=1&limit=20
```

Ví dụ lọc No Cost Center theo 3 trạng thái:

```http
GET /api/etsy?isNoCostCenter=true&statuses=New,Fulfilled,Shipped&page=1&limit=20
```

Ví dụ sort theo trạng thái:

```http
GET /api/etsy?isNoCostCenter=true&statuses=New,Fulfilled,Shipped&sortBy=status&sortOrder=asc
```

Response list giữ shape hiện tại:

```json
{
  "data": [],
  "totalCount": 0,
  "totalPages": 0,
  "currentPage": 1
}
```

## 4. Etsy Statistics

Endpoint:

```http
GET /api/etsy/statistic
```

Auth:

```txt
Route hiện tại không gắn authenticateToken trong etsyOrder.routes.js.
Nếu FE đang có token thì vẫn có thể gửi Authorization header như các API khác.
```

Response có thêm field:

```json
{
  "all": 0,
  "new": 0,
  "noCostCenter": 0,
  "noCostCenterByStatus": {
    "new": 0,
    "fulfilled": 0,
    "shipped": 0
  },
  "fulfilled": 0,
  "shipped": 0
}
```

FE dùng `noCostCenterByStatus` giống Amazon:

| FE label | Response key |
| --- | --- |
| New | `noCostCenterByStatus.new` |
| Fulfilled | `noCostCenterByStatus.fulfilled` |
| Shipped | `noCostCenterByStatus.shipped` |

## 5. FE Implementation Notes

- Khi user đang ở tab No Cost Center, luôn gửi `isNoCostCenter=true` ở list API.
- Khi chọn 1 status, gửi `status=<value>`.
- Khi chọn nhiều status, gửi `statuses=New,Fulfilled,Shipped`.
- Khi sort cột/trạng thái đơn, gửi `sortBy=status&sortOrder=asc|desc`.
- Không gửi cả `status` và `statuses` cùng lúc; nếu có nhiều status thì chỉ gửi `statuses`.
- No Cost Center backend tự loại đơn `Cancelled` khỏi điều kiện thiếu cost center.
- Etsy coi status rỗng/null là `New` trong statistics No Cost Center.
