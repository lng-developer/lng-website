# Auto Job Logs API Specification

## Tổng quan
API để quản lý và xem logs của các auto jobs (cron jobs) trong hệ thống. Giúp debug và monitor các jobs tự động khi deploy production.

## Base URL
```
/api/auto-job-logs
```

## Endpoints

### 1. GET /api/auto-job-logs
Lấy danh sách logs với phân trang và filter

**Query Parameters:**
- `page` (number, optional): Trang hiện tại (default: 1)
- `limit` (number, optional): Số items per page (default: 20)
- `jobId` (string, optional): Filter theo job ID cụ thể
- `jobType` (string, optional): Filter theo loại job (`vendorSyncBatch`, `autoRequestExtension`, `uploadTracking`)
- `status` (string, optional): Filter theo trạng thái (`running`, `success`, `error`)
- `days` (number, optional): Lấy logs trong X ngày gần đây (default: 7)

**Response:**
```json
{
  "success": true,
  "data": {
    "logs": [
      {
        "_id": "...",
        "jobId": "auto-import-orders",
        "jobType": "autoRequestExtension",
        "executionId": "auto-import-orders_1775744274210_8kc9nk2ch",
        "startTime": "2026-04-09T14:30:00.000Z",
        "endTime": "2026-04-09T14:30:05.659Z",
        "duration": 5659,
        "status": "success",
        "result": {
          "ok": true,
          "processed": 10,
          "success": 10,
          "failed": 0
        },
        "stats": {
          "processed": 10,
          "success": 10,
          "failed": 0
        },
        "logs": [
          {
            "timestamp": "2026-04-09T14:30:00.100Z",
            "level": "info",
            "message": "Starting auto job: auto-import-orders",
            "data": null
          }
        ],
        "config": {
          "taskType": "IMPORT_ORDERS",
          "payload": null
        },
        "createdAt": "2026-04-09T14:30:00.000Z"
      }
    ],
    "pagination": {
      "currentPage": 1,
      "totalPages": 5,
      "totalItems": 100,
      "itemsPerPage": 20,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### 2. GET /api/auto-job-logs/stats
Lấy thống kê tổng quan về logs

**Query Parameters:**
- `jobId` (string, optional): Thống kê cho job cụ thể
- `days` (number, optional): Thống kê trong X ngày (default: 7)

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "totalExecutions": 50,
      "successRate": 85.5,
      "avgDuration": 3245,
      "totalProcessed": 500,
      "totalSuccess": 450,
      "totalFailed": 50
    },
    "breakdown": [
      {
        "_id": "success",
        "count": 42,
        "avgDuration": 3100,
        "totalProcessed": 420,
        "totalSuccess": 420,
        "totalFailed": 0
      },
      {
        "_id": "error",
        "count": 8,
        "avgDuration": 1200,
        "totalProcessed": 80,
        "totalSuccess": 30,
        "totalFailed": 50
      }
    ],
    "recentExecutions": [
      {
        "jobId": "auto-import-orders",
        "status": "success",
        "startTime": "2026-04-09T14:30:00.000Z",
        "duration": 5659
      }
    ]
  }
}
```

### 3. GET /api/auto-job-logs/:executionId
Lấy chi tiết một execution cụ thể

**Response:**
```json
{
  "success": true,
  "data": {
    "log": {
      "_id": "...",
      "jobId": "auto-import-orders",
      "jobType": "autoRequestExtension",
      "executionId": "auto-import-orders_1775744274210_8kc9nk2ch",
      "startTime": "2026-04-09T14:30:00.000Z",
      "endTime": "2026-04-09T14:30:05.659Z",
      "duration": 5659,
      "status": "success",
      "result": { ... },
      "stats": { ... },
      "logs": [
        {
          "timestamp": "2026-04-09T14:30:00.100Z",
          "level": "info",
          "message": "Starting auto job",
          "data": { "configId": "auto-import-orders" }
        },
        {
          "timestamp": "2026-04-09T14:30:01.200Z",
          "level": "info",
          "message": "Processing 10 shops",
          "data": { "shopCount": 10 }
        },
        {
          "timestamp": "2026-04-09T14:30:05.500Z",
          "level": "info",
          "message": "Job completed successfully",
          "data": { "result": { ... } }
        }
      ],
      "config": { ... },
      "error": null
    }
  }
}
```

### 4. GET /api/auto-job-logs/job/:jobId
Lấy logs của một job cụ thể

**Query Parameters:**
- `limit` (number, optional): Số logs tối đa (default: 50)

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "auto-import-orders",
    "logs": [ ... ],
    "count": 25
  }
}
```

### 5. GET /api/auto-job-logs/export
Export logs để debugging

**Query Parameters:**
- `jobId` (string, optional): Export logs của job cụ thể
- `days` (number, optional): Export logs trong X ngày (default: 1)

**Response:**
```json
{
  "success": true,
  "data": {
    "exportData": [
      {
        "executionId": "...",
        "jobId": "auto-import-orders",
        "jobType": "autoRequestExtension",
        "startTime": "2026-04-09T14:30:00.000Z",
        "endTime": "2026-04-09T14:30:05.659Z",
        "duration": 5659,
        "status": "success",
        "result": { ... },
        "error": null,
        "stats": { ... },
        "logsCount": 5,
        "detailedLogs": [ ... ]
      }
    ],
    "count": 10,
    "period": "1 days",
    "exportedAt": "2026-04-09T15:00:00.000Z"
  }
}
```

### 6. POST /api/auto-job-logs/cleanup
Xóa logs cũ (manual cleanup)

**Body:**
```json
{
  "days": 30
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Cleaned up 150 old logs",
    "deletedCount": 150,
    "cutoffDate": "2026-03-10T15:00:00.000Z"
  }
}
```

## Data Models

### AutoJobLog Schema
```javascript
{
  jobId: String,           // ID của config auto (vd: "auto-import-orders")
  jobType: String,         // Loại job: "vendorSyncBatch", "autoRequestExtension", "uploadTracking"
  executionId: String,     // ID unique cho mỗi lần chạy
  startTime: Date,         // Thời gian bắt đầu
  endTime: Date,          // Thời gian kết thúc
  duration: Number,        // Thời gian chạy (ms)
  status: String,          // "running", "success", "error"
  result: Mixed,           // Kết quả trả về từ job
  error: {                 // Thông tin lỗi (nếu có)
    message: String,
    stack: String
  },
  logs: [{                 // Chi tiết logs trong quá trình chạy
    timestamp: Date,
    level: String,         // "info", "warn", "error", "debug"
    message: String,
    data: Mixed
  }],
  config: Mixed,           // Config của job khi chạy
  stats: {                 // Thống kê kết quả
    processed: Number,
    success: Number,
    failed: Number,
    details: Mixed
  },
  createdAt: Date,
  updatedAt: Date
}
```

## Sử dụng trong Frontend

### 1. Dashboard Overview
```javascript
// Lấy thống kê tổng quan
const getJobStats = async () => {
  const response = await fetch('/api/auto-job-logs/stats?days=7');
  const data = await response.json();
  
  // Hiển thị success rate, avg duration, etc.
  setStats(data.data.summary);
};
```

### 2. Job Logs List
```javascript
// Lấy danh sách logs với phân trang
const getJobLogs = async (page = 1, filters = {}) => {
  const params = new URLSearchParams({
    page,
    limit: 20,
    ...filters
  });
  
  const response = await fetch(`/api/auto-job-logs?${params}`);
  const data = await response.json();
  
  setLogs(data.data.logs);
  setPagination(data.data.pagination);
};

// Filter theo job type
const filterByJobType = (jobType) => {
  getJobLogs(1, { jobType });
};

// Filter theo status
const filterByStatus = (status) => {
  getJobLogs(1, { status });
};
```

### 3. Job Detail View
```javascript
// Xem chi tiết một execution
const getExecutionDetail = async (executionId) => {
  const response = await fetch(`/api/auto-job-logs/${executionId}`);
  const data = await response.json();
  
  setExecutionDetail(data.data.log);
};
```

### 4. Export for Debugging
```javascript
// Export logs để debug
const exportLogs = async (jobId, days = 1) => {
  const params = new URLSearchParams({ jobId, days });
  const response = await fetch(`/api/auto-job-logs/export?${params}`);
  const data = await response.json();
  
  // Download hoặc hiển thị data
  downloadJSON(data.data.exportData, `logs-${jobId}-${days}days.json`);
};
```

## Features

### 1. Auto TTL
- Logs tự động xóa sau 7 ngày (configurable)
- Index TTL trên `createdAt` field

### 2. Efficient Queries
- Indexes trên các fields thường query: `jobId`, `jobType`, `status`, `startTime`
- Pagination support
- Aggregation cho stats

### 3. Detailed Logging
- Logs từng bước trong quá trình execution
- Error tracking với stack trace
- Performance metrics (duration, stats)

### 4. Production Ready
- Không ảnh hưởng performance của main app
- Async logging
- Error handling

## Lưu ý Implementation

1. **Performance**: Logs được lưu async, không block main execution
2. **Storage**: TTL 7 ngày để tránh database quá lớn
3. **Security**: Cần auth middleware cho production
4. **Monitoring**: Có thể integrate với monitoring tools qua export API