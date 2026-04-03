# Bugfix Requirements Document

## Introduction

Hệ thống fake tracking hiện tại đang tự động tạo fake tracking numbers cho tất cả các đơn hàng không có real tracking. Yêu cầu mới là thay đổi luồng xử lý để chỉ xử lý các đơn hàng có real tracking thật, và ngừng việc tạo fake tracking numbers. Điều này nhằm đảm bảo tính chính xác của dữ liệu tracking và tránh việc cung cấp thông tin tracking giả cho khách hàng.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN một đơn hàng không có real tracking trong database THEN hệ thống tự động tạo fake tracking với format "92" + 18 chữ số ngẫu nhiên

1.2 WHEN hàm createBatchFromFile xử lý file TXT từ Amazon THEN hệ thống bao gồm cả đơn hàng có fake tracking vào completed[] array

1.3 WHEN tạo file content để upload lên Amazon THEN hệ thống bao gồm cả đơn không có tracking (fake tracking) và real tracking

1.4 WHEN lưu vào ShippingBatch THEN hệ thống lưu fake tracking vào completed[] với isFake: true và source: "fake"

### Expected Behavior (Correct)

2.1 WHEN một đơn hàng không có real tracking trong database THEN hệ thống SHALL bỏ qua đơn hàng đó và không tạo fake tracking, chỉ đợi khi nào có real tracking mới tiếp tục xử lý

2.2 WHEN hàm createBatchFromFile xử lý file TXT từ Amazon THEN hệ thống SHALL chỉ bao gồm các đơn hàng có real tracking vào completed[] array

2.3 WHEN tạo file content để upload lên Amazon THEN hệ thống SHALL chỉ bao gồm các đơn hàng có real tracking trong file output

2.4 WHEN lưu vào ShippingBatch THEN hệ thống SHALL lưu các đơn không có tracking vào tracking_fakes[] array để theo dõi và đợi real tracking, nhưng không bao gồm chúng trong completed[]

2.5 WHEN các đơn hàng trong tracking_fakes[] có real tracking sau này THEN hệ thống SHALL có thể xử lý chúng trong các batch update tiếp theo

### Unchanged Behavior (Regression Prevention)

3.1 WHEN một đơn hàng có real tracking trong database THEN hệ thống SHALL CONTINUE TO sử dụng real tracking và lưu vào completed[] với isFake: false và source: "system"

3.2 WHEN parse file TXT từ Amazon với format "order-id | days-past-promise" THEN hệ thống SHALL CONTINUE TO lọc các đơn có days-past-promise = -2

3.3 WHEN tính toán stats cho ShippingBatch THEN hệ thống SHALL CONTINUE TO cung cấp thống kê totalOrders, totalReal, và totalFake

3.4 WHEN tạo ShippingBatch record THEN hệ thống SHALL CONTINUE TO lưu với các trường machineId, label, type: "CONFIRM", và status: "CONFIRM_FILE_READY"

3.5 WHEN có các hàm update existing batches (như createUpdateBatchFromSystem, updateAllFakeTracking) THEN hệ thống SHALL CONTINUE TO kiểm tra và xử lý các đơn trong tracking_fakes[] khi chúng có real tracking