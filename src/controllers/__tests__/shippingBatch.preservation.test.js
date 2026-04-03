/**
 * Preservation Property Tests for Fake Tracking Removal Bugfix
 * 
 * **IMPORTANT**: Follow observation-first methodology
 * These tests observe behavior on UNFIXED code for orders with real tracking
 * and capture baseline behavior patterns that must be preserved after the fix.
 * 
 * **EXPECTED OUTCOME**: Tests PASS on unfixed code (confirms baseline behavior to preserve)
 * 
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 */

const fc = require('fast-check');

// Mock dependencies
const mockDb = {
  orderCustomProduct: {
    findOne: jest.fn()
  },
  ShippingBatch: {
    create: jest.fn()
  }
};

// Mock the database module
jest.mock('../../models', () => mockDb);

// Import the controller after mocking
const shippingBatchController = require('../shippingBatch.contrller');

describe('Preservation Property Tests: Real Tracking Processing and File Parsing Behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock ShippingBatch.create to return a response that matches the input
    mockDb.ShippingBatch.create.mockImplementation(async (batchData) => {
      return {
        _id: 'mock-batch-id',
        machineId: batchData.machineId,
        label: batchData.label,
        status: batchData.status,
        fileName: batchData.fileName,
        stats: batchData.stats,
        type: batchData.type
      };
    });
  });

  /**
   * Property 2.1: Preservation - Real Tracking Processing Behavior
   * 
   * Observes and preserves the behavior for orders WITH real tracking:
   * - Orders with real tracking continue to be processed normally
   * - They are added to completed[] array with correct format
   * - isFake: false, source: "system"
   * 
   * **Validates: Requirements 3.1**
   */
  test('Property 2.1: Orders with real tracking continue normal processing', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate test data: orders WITH real tracking
        fc.array(
          fc.record({
            orderId: fc.string({ minLength: 1, maxLength: 20 })
              .filter(s => s.trim().length > 0 && !s.includes('\t') && !s.includes('\n') && !s.includes('\r'))
              .map(s => s.replace(/[^a-zA-Z0-9_-]/g, 'X')), // Replace special chars with X
            daysPastPromise: fc.constant(-2), // Only orders with -2 are processed
            realTracking: fc.string({ minLength: 10, maxLength: 30 })
              .filter(s => s.trim().length > 0)
              .map(s => s.replace(/[^a-zA-Z0-9_-]/g, 'T')) // Replace special chars with T
          }),
          { minLength: 1, maxLength: 3 }
        ).map(orders => {
          // Ensure unique order IDs
          const uniqueOrders = [];
          const seen = new Set();
          for (const order of orders) {
            if (!seen.has(order.orderId) && order.orderId.length > 0) {
              seen.add(order.orderId);
              uniqueOrders.push(order);
            }
          }
          return uniqueOrders.length > 0 ? uniqueOrders : [{ orderId: 'TEST123', daysPastPromise: -2, realTracking: 'TRACK123456789' }];
        }),
        async (ordersWithRealTracking) => {
          // Setup: Mock all orders to have real tracking
          mockDb.orderCustomProduct.findOne.mockImplementation(async (query) => {
            const orderId = query.orderId;
            const order = ordersWithRealTracking.find(o => o.orderId === orderId);
            if (order) {
              return {
                items: [{
                  tracking_info: {
                    tracking: order.realTracking
                  }
                }]
              };
            }
            return null;
          });

          // Create mock file buffer with orders
          const fileContent = 'order-id\tdays-past-promise\n' + 
            ordersWithRealTracking
              .map(order => `${order.orderId}\t${order.daysPastPromise}`)
              .join('\n');
          
          const mockFile = {
            buffer: Buffer.from(fileContent, 'utf8')
          };

          // Create mock request and response
          const mockReq = {
            body: {
              machineId: 'test-machine',
              label: 'test-label'
            },
            file: mockFile
          };

          const mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
          };

          const mockNext = jest.fn();

          // Execute the function
          await shippingBatchController.createBatchFromFile(mockReq, mockRes, mockNext);

          // Get the arguments passed to ShippingBatch.create
          const createCall = mockDb.ShippingBatch.create.mock.calls[0];
          expect(createCall).toBeDefined();

          const batchData = createCall[0];
          const { completed } = batchData;

          // **PRESERVATION ASSERTION**: Orders with real tracking should be in completed[]
          expect(completed).toHaveLength(ordersWithRealTracking.length);
          
          // Verify each order with real tracking is processed correctly
          ordersWithRealTracking.forEach(order => {
            const completedOrder = completed.find(c => c.orderId === order.orderId);
            expect(completedOrder).toBeDefined();
            expect(completedOrder.tracking).toBe(order.realTracking);
            expect(completedOrder.isFake).toBe(false);
            expect(completedOrder.source).toBe("system");
          });
        }
      ),
      { 
        numRuns: 10,
        verbose: true
      }
    );
  });

  /**
   * Property 2.2: Preservation - File Parsing Behavior
   * 
   * Observes and preserves the TXT file parsing behavior:
   * - Format "order-id | days-past-promise" continues to work
   * - Only orders with days-past-promise = -2 are processed
   * - Tab-separated format parsing
   * 
   * **Validates: Requirements 3.2**
   */
  test('Property 2.2: File parsing with "order-id | days-past-promise" format continues to work', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate mixed orders with different days-past-promise values
        fc.array(
          fc.record({
            orderId: fc.string({ minLength: 1, maxLength: 20 })
              .filter(s => s.trim().length > 0 && !s.includes('\t') && !s.includes('\n') && !s.includes('\r'))
              .map(s => s.replace(/[^a-zA-Z0-9_-]/g, 'X')), // Replace special chars with X
            daysPastPromise: fc.integer({ min: -5, max: 5 }), // Mix of values
            realTracking: fc.string({ minLength: 10, maxLength: 30 })
              .filter(s => s.trim().length > 0)
              .map(s => s.replace(/[^a-zA-Z0-9_-]/g, 'T')) // Replace special chars with T
          }),
          { minLength: 3, maxLength: 8 }
        ).map(orders => {
          // Ensure unique order IDs and at least one order with -2
          const uniqueOrders = [];
          const seen = new Set();
          for (const order of orders) {
            if (!seen.has(order.orderId) && order.orderId.length > 0) {
              seen.add(order.orderId);
              uniqueOrders.push(order);
            }
          }
          // Ensure at least one order with daysPastPromise = -2
          if (!uniqueOrders.some(o => o.daysPastPromise === -2)) {
            uniqueOrders[0] = { ...uniqueOrders[0], daysPastPromise: -2 };
          }
          return uniqueOrders.length >= 3 ? uniqueOrders : [
            { orderId: 'TEST1', daysPastPromise: -2, realTracking: 'TRACK123' },
            { orderId: 'TEST2', daysPastPromise: -1, realTracking: 'TRACK456' },
            { orderId: 'TEST3', daysPastPromise: 0, realTracking: 'TRACK789' }
          ];
        }),
        async (mixedOrders) => {
          // Setup: Mock orders to have real tracking
          mockDb.orderCustomProduct.findOne.mockImplementation(async (query) => {
            const orderId = query.orderId;
            const order = mixedOrders.find(o => o.orderId === orderId);
            if (order) {
              return {
                items: [{
                  tracking_info: {
                    tracking: order.realTracking
                  }
                }]
              };
            }
            return null;
          });

          // Create mock file buffer with mixed orders
          const fileContent = 'order-id\tdays-past-promise\n' + 
            mixedOrders
              .map(order => `${order.orderId}\t${order.daysPastPromise}`)
              .join('\n');
          
          const mockFile = {
            buffer: Buffer.from(fileContent, 'utf8')
          };

          const mockReq = {
            body: {
              machineId: 'test-machine',
              label: 'test-label'
            },
            file: mockFile
          };

          const mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
          };

          const mockNext = jest.fn();

          // Execute the function
          await shippingBatchController.createBatchFromFile(mockReq, mockRes, mockNext);

          // Get the batch data
          const createCall = mockDb.ShippingBatch.create.mock.calls[0];
          if (createCall) {
            const batchData = createCall[0];
            const { completed } = batchData;

            // **PRESERVATION ASSERTION**: Only orders with days-past-promise = -2 should be processed
            const expectedOrdersToProcess = mixedOrders.filter(order => order.daysPastPromise === -2);
            
            // If there are orders with -2, they should be in completed (since they have real tracking)
            if (expectedOrdersToProcess.length > 0) {
              expect(completed.length).toBeGreaterThan(0);
              
              // Verify only orders with days-past-promise = -2 are processed
              completed.forEach(completedOrder => {
                const originalOrder = mixedOrders.find(o => o.orderId === completedOrder.orderId);
                expect(originalOrder).toBeDefined();
                expect(originalOrder.daysPastPromise).toBe(-2);
              });
            }
          }
        }
      ),
      { 
        numRuns: 10,
        verbose: true
      }
    );
  });

  /**
   * Property 2.3: Preservation - Stats Calculation Format
   * 
   * Observes and preserves the stats calculation format:
   * - Stats object has totalOrders, totalReal, totalFake fields
   * - Calculation provides accurate statistics
   * 
   * **Validates: Requirements 3.3**
   */
  test('Property 2.3: Stats calculation continues to provide accurate statistics', async () => {
    // Setup: Mock orders with real tracking
    mockDb.orderCustomProduct.findOne.mockImplementation(async (query) => {
      const orderId = query.orderId;
      return {
        items: [{
          tracking_info: {
            tracking: `REAL_TRACK_${orderId}`
          }
        }]
      };
    });

    // Create mock file with orders that have real tracking
    const mockFile = {
      buffer: Buffer.from('order-id\tdays-past-promise\nORDER001\t-2\nORDER002\t-2\nORDER003\t-2', 'utf8')
    };

    const mockReq = {
      body: {
        machineId: 'test-machine',
        label: 'test-label'
      },
      file: mockFile
    };

    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    const mockNext = jest.fn();

    // Execute the function
    await shippingBatchController.createBatchFromFile(mockReq, mockRes, mockNext);

    // Get the batch data
    const createCall = mockDb.ShippingBatch.create.mock.calls[0];
    expect(createCall).toBeDefined();
    
    const batchData = createCall[0];
    const { stats, completed } = batchData;

    // **PRESERVATION ASSERTION**: Stats object should have correct structure and values
    expect(stats).toBeDefined();
    expect(stats).toHaveProperty('totalOrders');
    expect(stats).toHaveProperty('totalReal');
    expect(stats).toHaveProperty('totalFake');
    
    // For orders with real tracking, verify stats accuracy
    expect(stats.totalReal).toBe(completed.filter(item => !item.isFake).length);
    expect(stats.totalFake).toBe(completed.filter(item => item.isFake).length);
    expect(stats.totalOrders).toBe(completed.length);
    
    // Since all orders have real tracking, totalFake should be 0
    expect(stats.totalFake).toBe(0);
    expect(stats.totalReal).toBe(3);
    expect(stats.totalOrders).toBe(3);
  });

  /**
   * Property 2.4: Preservation - ShippingBatch Creation
   * 
   * Observes and preserves ShippingBatch record creation:
   * - Correct fields: machineId, label, type: "CONFIRM", status: "CONFIRM_FILE_READY"
   * - Proper structure and data types
   * 
   * **Validates: Requirements 3.4**
   */
  test('Property 2.4: ShippingBatch creation continues with correct fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          machineId: fc.string({ minLength: 2, maxLength: 20 })
            .filter(s => s.trim().length > 1)
            .map(s => s.replace(/[^a-zA-Z0-9_-]/g, 'M')), // Replace special chars with M
          label: fc.string({ minLength: 2, maxLength: 50 })
            .filter(s => s.trim().length > 1)
            .map(s => s.replace(/[^a-zA-Z0-9_-]/g, 'L')) // Replace special chars with L
        }),
        async (batchInfo) => {
          // Setup: Mock order with real tracking
          mockDb.orderCustomProduct.findOne.mockResolvedValue({
            items: [{
              tracking_info: {
                tracking: 'REAL_TRACK_123'
              }
            }]
          });

          const mockFile = {
            buffer: Buffer.from('order-id\tdays-past-promise\nTEST123\t-2', 'utf8')
          };

          const mockReq = {
            body: {
              machineId: batchInfo.machineId,
              label: batchInfo.label
            },
            file: mockFile
          };

          const mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
          };

          const mockNext = jest.fn();

          // Execute the function
          await shippingBatchController.createBatchFromFile(mockReq, mockRes, mockNext);

          // Get the batch data
          const createCall = mockDb.ShippingBatch.create.mock.calls[0];
          expect(createCall).toBeDefined();
          
          const batchData = createCall[0];

          // **PRESERVATION ASSERTION**: ShippingBatch should have correct structure
          expect(batchData.machineId).toBe(batchInfo.machineId);
          expect(batchData.label).toBe(batchInfo.label);
          expect(batchData.type).toBe("CONFIRM");
          expect(batchData.status).toBe("CONFIRM_FILE_READY");
          expect(batchData.fileName).toMatch(/^confirm_.*\.txt$/);
          
          // Verify required arrays exist
          expect(Array.isArray(batchData.completed)).toBe(true);
          expect(Array.isArray(batchData.tracking_fakes)).toBe(true);
          expect(batchData.stats).toBeDefined();
        }
      ),
      { 
        numRuns: 10,
        verbose: true
      }
    );
  });

  /**
   * Concrete test case: Real tracking processing baseline
   */
  test('Concrete case: Order with real tracking processed normally', async () => {
    // Setup: Mock order with real tracking
    mockDb.orderCustomProduct.findOne.mockResolvedValue({
      items: [{
        tracking_info: {
          tracking: 'REAL_TRACK_ABC123'
        }
      }]
    });

    const mockFile = {
      buffer: Buffer.from('order-id\tdays-past-promise\nORDER_REAL\t-2', 'utf8')
    };

    const mockReq = {
      body: {
        machineId: 'test-machine',
        label: 'test-label'
      },
      file: mockFile
    };

    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    const mockNext = jest.fn();

    // Execute the function
    await shippingBatchController.createBatchFromFile(mockReq, mockRes, mockNext);

    // Get the batch data
    const createCall = mockDb.ShippingBatch.create.mock.calls[0];
    expect(createCall).toBeDefined();
    
    const batchData = createCall[0];
    const { completed } = batchData;

    // **BASELINE BEHAVIOR**: Order with real tracking should be in completed[]
    expect(completed).toHaveLength(1);
    expect(completed[0].orderId).toBe('ORDER_REAL');
    expect(completed[0].tracking).toBe('REAL_TRACK_ABC123');
    expect(completed[0].isFake).toBe(false);
    expect(completed[0].source).toBe('system');
  });

  /**
   * Concrete test case: File parsing baseline behavior
   */
  test('Concrete case: File parsing filters days-past-promise = -2', async () => {
    // Setup: Mock orders with real tracking
    mockDb.orderCustomProduct.findOne.mockImplementation(async (query) => {
      const orderId = query.orderId;
      return {
        items: [{
          tracking_info: {
            tracking: `REAL_TRACK_${orderId}`
          }
        }]
      };
    });

    // File with mixed days-past-promise values
    const mockFile = {
      buffer: Buffer.from('order-id\tdays-past-promise\nORDER1\t-2\nORDER2\t-1\nORDER3\t-2\nORDER4\t0', 'utf8')
    };

    const mockReq = {
      body: {
        machineId: 'test-machine',
        label: 'test-label'
      },
      file: mockFile
    };

    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };

    const mockNext = jest.fn();

    // Execute the function
    await shippingBatchController.createBatchFromFile(mockReq, mockRes, mockNext);

    // Get the batch data
    const createCall = mockDb.ShippingBatch.create.mock.calls[0];
    expect(createCall).toBeDefined();
    
    const batchData = createCall[0];
    const { completed } = batchData;

    // **BASELINE BEHAVIOR**: Only orders with days-past-promise = -2 should be processed
    expect(completed).toHaveLength(2);
    expect(completed.map(c => c.orderId)).toEqual(expect.arrayContaining(['ORDER1', 'ORDER3']));
    
    // Verify no orders with other days-past-promise values
    const processedOrderIds = completed.map(c => c.orderId);
    expect(processedOrderIds).not.toContain('ORDER2'); // days-past-promise = -1
    expect(processedOrderIds).not.toContain('ORDER4'); // days-past-promise = 0
  });
});