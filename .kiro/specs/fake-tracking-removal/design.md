# Fake Tracking Removal Bugfix Design

## Overview

Hệ thống hiện tại đang tự động tạo fake tracking numbers cho tất cả các đơn hàng không có real tracking, dẫn đến việc cung cấp thông tin tracking giả cho khách hàng. Bugfix này sẽ thay đổi logic trong hàm `createBatchFromFile` để chỉ xử lý các đơn hàng có real tracking thật, ngừng việc tạo fake tracking, và lưu các đơn không có tracking vào `tracking_fakes[]` để theo dõi mà không đưa vào `completed[]`.

## Glossary

- **Bug_Condition (C)**: Điều kiện kích hoạt bug - khi đơn hàng không có real tracking nhưng vẫn được tạo fake tracking và đưa vào completed[]
- **Property (P)**: Hành vi mong muốn - đơn hàng không có real tracking sẽ được bỏ qua khỏi completed[] và chỉ lưu vào tracking_fakes[] để theo dõi
- **Preservation**: Các hành vi hiện tại phải được giữ nguyên - xử lý đơn có real tracking, parsing file TXT, tính toán stats
- **createBatchFromFile**: Hàm trong `src/controllers/shippingBatch.contrller.js` xử lý file TXT từ Amazon và tạo shipping batch
- **completed[]**: Array chứa các đơn hàng đã hoàn thành với tracking để tạo file confirm ship
- **tracking_fakes[]**: Array chứa các đơn hàng không có tracking để theo dõi
- **getRealTrackingForOrder**: Hàm lấy real tracking từ database cho một orderId
- **generateFakeTracking**: Hàm tạo fake tracking với format "92" + 18 chữ số ngẫu nhiên

## Bug Details

### Bug Condition

Bug xảy ra khi một đơn hàng không có real tracking trong database nhưng hệ thống vẫn tự động tạo fake tracking và đưa vào `completed[]` array. Hàm `createBatchFromFile` hiện tại đang gọi `generateFakeTracking()` cho tất cả đơn hàng không có real tracking và thêm chúng vào cả `completed[]` và `tracking_fakes[]`.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { orderId: string, realTracking: string|null }
  OUTPUT: boolean
  
  RETURN input.realTracking IS NULL
         AND orderIsProcessedIntoCompleted(input.orderId)
         AND fakeTrackingIsGenerated(input.orderId)
END FUNCTION
```

### Examples

- **Đơn hàng A123**: Không có real tracking → Hiện tại: tạo fake "92123456789012345678" và đưa vào completed[] → Mong muốn: chỉ lưu vào tracking_fakes[], không đưa vào completed[]
- **Đơn hàng B456**: Không có real tracking → Hiện tại: tạo fake "92987654321098765432" và đưa vào completed[] → Mong muốn: chỉ lưu vào tracking_fakes[], không đưa vào completed[]
- **Đơn hàng C789**: Có real tracking "1Z999AA1234567890" → Mong muốn: tiếp tục đưa vào completed[] với real tracking
- **Edge case**: File TXT có 100 đơn, 30 đơn có real tracking, 70 đơn không có → Mong muốn: chỉ 30 đơn vào completed[], 70 đơn vào tracking_fakes[]

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Đơn hàng có real tracking phải tiếp tục được xử lý và đưa vào completed[] với isFake: false và source: "system"
- Parsing file TXT với format "order-id | days-past-promise" phải tiếp tục hoạt động
- Lọc các đơn có days-past-promise = -2 phải tiếp tục hoạt động
- Tính toán stats (totalOrders, totalReal, totalFake) phải tiếp tục cung cấp thông tin chính xác
- Tạo ShippingBatch record với các trường machineId, label, type: "CONFIRM", status: "CONFIRM_FILE_READY" phải tiếp tục hoạt động
- File output format cho Amazon phải tiếp tục sử dụng format hiện tại

**Scope:**
Tất cả các input không liên quan đến việc tạo fake tracking sẽ hoàn toàn không bị ảnh hưởng bởi fix này. Bao gồm:
- Xử lý đơn hàng có real tracking
- Parsing và validation file TXT
- Tạo file output cho Amazon
- Lưu trữ và truy vấn ShippingBatch records

## Hypothesized Root Cause

Dựa trên phân tích code, các nguyên nhân có thể của bug:

1. **Logic Flow Incorrect**: Hàm `createBatchFromFile` hiện tại luôn đưa tất cả đơn hàng vào `completed[]`, bất kể có real tracking hay không
   - Dòng 139-155: Logic hiện tại đưa cả đơn có fake tracking vào completed[]
   - Cần thay đổi để chỉ đưa đơn có real tracking vào completed[]

2. **Fake Tracking Generation**: Hàm `generateFakeTracking()` vẫn được gọi và kết quả được sử dụng
   - Cần ngừng gọi generateFakeTracking() cho logic mới
   - Chỉ lưu thông tin đơn không có tracking vào tracking_fakes[] mà không tạo fake

3. **Stats Calculation**: Stats hiện tại dựa trên completed[] array
   - totalOrders hiện tại = completed.length (bao gồm cả fake)
   - Cần cập nhật để totalOrders = totalReal + totalFake (từ tracking_fakes[])

4. **File Content Generation**: File output hiện tại dựa trên completed[] array
   - Điều này đúng vì chỉ muốn xuất đơn có real tracking
   - Không cần thay đổi logic buildPlainTextFile

## Correctness Properties

Property 1: Bug Condition - No Fake Tracking in Completed

_For any_ đơn hàng không có real tracking trong database, hàm createBatchFromFile đã fix SHALL không tạo fake tracking và không đưa đơn hàng đó vào completed[] array, chỉ lưu thông tin orderId vào tracking_fakes[] để theo dõi.

**Validates: Requirements 2.1, 2.2, 2.4**

Property 2: Preservation - Real Tracking Processing

_For any_ đơn hàng có real tracking trong database, hàm createBatchFromFile đã fix SHALL tiếp tục xử lý giống như trước, đưa đơn hàng vào completed[] với real tracking, isFake: false, và source: "system".

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

## Fix Implementation

### Changes Required

**File**: `src/controllers/shippingBatch.contrller.js`

**Function**: `createBatchFromFile`

**Specific Changes**:
1. **Remove Fake Tracking Generation**: Ngừng gọi `generateFakeTracking()` trong logic chính
   - Xóa dòng 150: `const fake = generateFakeTracking(orderId);`
   - Xóa logic đưa fake tracking vào completed[]

2. **Update Completed Array Logic**: Chỉ đưa đơn có real tracking vào completed[]
   - Thay đổi logic từ dòng 139-165
   - Chỉ push vào completed[] khi realTracking tồn tại

3. **Update Tracking Fakes Logic**: Lưu đơn không có tracking vào tracking_fakes[] mà không tạo fake
   - Thay đổi tracking_fakes[] để chỉ lưu { orderId, note: "no real tracking" }
   - Không lưu fake tracking number

4. **Update Stats Calculation**: Cập nhật cách tính stats
   - totalOrders = totalReal + totalFake
   - totalReal = completed.length (chỉ đơn có real tracking)
   - totalFake = tracking_fakes.length (đơn không có tracking)

5. **Maintain File Output**: Giữ nguyên logic tạo file output
   - confirmFileContent vẫn dựa trên completed[] (chỉ đơn có real tracking)
   - Không cần thay đổi buildPlainTextFile()

### Code Changes Detail

**Before (Lines 139-165):**
```javascript
if (realTracking) {
  completed.push({
    orderId,
    tracking: realTracking,
    isFake: false,
    source: "system",
  });
} else {
  const fake = generateFakeTracking(orderId);
  completed.push({
    orderId,
    tracking: fake,
    isFake: true,
    source: "fake",
  });
  tracking_fakes.push({
    orderId,
    tracking: fake,
  });
}
```

**After:**
```javascript
if (realTracking) {
  completed.push({
    orderId,
    tracking: realTracking,
    isFake: false,
    source: "system",
  });
} else {
  // Chỉ lưu vào tracking_fakes để theo dõi, không tạo fake tracking
  tracking_fakes.push({
    orderId,
    note: "no real tracking available",
  });
}
```

**Stats Calculation Update (Lines 168-172):**
```javascript
// Before
const stats = {
  totalOrders: completed.length,
  totalFake: completed.filter((r) => r.isFake).length,
  totalReal: completed.filter((r) => !r.isFake).length,
};

// After  
const stats = {
  totalOrders: completed.length + tracking_fakes.length,
  totalReal: completed.length, // chỉ đơn có real tracking
  totalFake: tracking_fakes.length, // đơn không có tracking
};
```

## Testing Strategy

### Validation Approach

Testing strategy sử dụng two-phase approach: đầu tiên, chạy test trên code chưa fix để xác nhận bug tồn tại, sau đó verify fix hoạt động đúng và preserve existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Xác nhận bug tồn tại trên code CHƯA FIX. Verify rằng đơn hàng không có real tracking vẫn được tạo fake tracking và đưa vào completed[].

**Test Plan**: Tạo test data với mix của đơn có và không có real tracking, chạy createBatchFromFile trên code chưa fix, và assert rằng tất cả đơn đều vào completed[].

**Test Cases**:
1. **Mixed Orders Test**: File có 5 đơn, 2 có real tracking, 3 không có → Code chưa fix: 5 đơn vào completed[] (will fail on unfixed code)
2. **No Real Tracking Test**: File có 3 đơn, tất cả không có real tracking → Code chưa fix: 3 đơn với fake tracking vào completed[] (will fail on unfixed code)  
3. **All Real Tracking Test**: File có 4 đơn, tất cả có real tracking → Code chưa fix: 4 đơn vào completed[] (should pass on unfixed code)
4. **Stats Calculation Test**: Verify totalOrders = completed.length trên code chưa fix (will fail after fix)

**Expected Counterexamples**:
- Đơn hàng không có real tracking vẫn xuất hiện trong completed[] với fake tracking
- totalFake được tính dựa trên completed[] thay vì tracking_fakes[]

### Fix Checking

**Goal**: Verify rằng với tất cả input có bug condition, hàm đã fix tạo ra expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := createBatchFromFile_fixed(input)
  ASSERT NOT orderInCompleted(input.orderId, result.completed)
  ASSERT orderInTrackingFakes(input.orderId, result.tracking_fakes)
END FOR
```

### Preservation Checking

**Goal**: Verify rằng với tất cả input không có bug condition, hàm đã fix tạo ra kết quả giống như hàm gốc.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT createBatchFromFile_original(input) = createBatchFromFile_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing được recommend cho preservation checking vì:
- Tự động generate nhiều test cases across input domain
- Catch edge cases mà manual unit tests có thể miss
- Cung cấp strong guarantees rằng behavior không thay đổi cho non-buggy inputs

**Test Plan**: Observe behavior trên code CHƯA FIX trước cho đơn có real tracking và file parsing, sau đó viết property-based tests capture behavior đó.

**Test Cases**:
1. **Real Tracking Preservation**: Verify đơn có real tracking tiếp tục vào completed[] với đúng format
2. **File Parsing Preservation**: Verify parsing file TXT và lọc days-past-promise = -2 tiếp tục hoạt động
3. **Stats Format Preservation**: Verify stats object vẫn có đúng structure (totalOrders, totalReal, totalFake)
4. **ShippingBatch Creation Preservation**: Verify record được tạo với đúng fields và values

### Unit Tests

- Test createBatchFromFile với file chỉ có đơn có real tracking
- Test createBatchFromFile với file chỉ có đơn không có real tracking  
- Test createBatchFromFile với file mixed orders
- Test edge cases: file empty, invalid format, no orders with days-past-promise = -2
- Test stats calculation accuracy sau khi fix

### Property-Based Tests

- Generate random combinations của đơn có/không có real tracking và verify completed[] chỉ chứa đơn có real tracking
- Generate random file formats và verify parsing behavior không thay đổi
- Test across nhiều scenarios rằng file output chỉ chứa real tracking numbers

### Integration Tests

- Test full flow từ upload file TXT đến tạo ShippingBatch record
- Test file content generation cho Amazon upload
- Test rằng UI có thể display stats correctly sau khi fix
- Test backward compatibility với existing ShippingBatch records