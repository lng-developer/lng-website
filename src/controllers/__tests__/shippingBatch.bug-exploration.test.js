/**
 * Bug Condition Exploration Test for Fake Tracking Removal
 * 
 * **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * **DO NOT attempt to fix the test or the code when it fails**
 * **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
 * **GOAL**: Surface counterexamples that demonstrate the bug exists
 * 
 * **Validates: Requirements 2.1, 2.2, 2.4**
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

describe('Bug Condition Exploration: Fake Tracking Generation for Orders Without Real Tracking', () => {
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
   * Property 1: Bug Condition - Fake Tracking Generation for Orders Without Real Tracking
   * 
   * This property tests the bug condition: orders without real tracking should NOT be added 
   * to completed[] array and should only be saved to tracking_fakes[] without fake tracking generation.
   * 
   * **Validates: Requirements 2.1, 2.2, 2.4**
   */
  test('Property 1: Orders without real tracking should NOT be in completed[] array', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate test data: orders without real tracking
        fc.array(
          fc.record({
            orderId: fc.string({ minLength: 1, maxLength: 20 })
              .filter(s => s.trim().length > 0 && !s.includes('\t') && !s.includes('\n') && !s.includes('\r'))
              .map(s => s.replace(/[^a-zA-Z0-9_-]/g, 'X')), // Replace special chars with X
            daysPastPromise: fc.constant(-2) // Only orders with -2 are processed
          }),
          { minLength: 1, maxLength: 5 }
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
          return uniqueOrders.length > 0 ? uniqueOrders : [{ orderId: 'TEST123', daysPastPromise: -2 }];
        }),
        async (ordersWithoutTracking) => {
          // Setup: Mock all orders to have NO real tracking
          mockDb.orderCustomProduct.findOne.mockImplementation(async (query) => {
            // Return null to simulate no real tracking found
            return null;
          });

          // Create mock file buffer with orders
          const fileContent = 'order-id\tdays-past-promise\n' + 
            ordersWithoutTracking
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
          if (!createCall) {
            throw new Error('ShippingBatch.create was not called');
          }

          const batchData = createCall[0];
          const { completed, tracking_fakes } = batchData;

          // **BUG CONDITION ASSERTION**: 
          // On UNFIXED code, this assertion will FAIL because orders without real tracking
          // are incorrectly added to completed[] with fake tracking numbers.
          // When the bug is fixed, this assertion will PASS.
          
          // Assert: Orders without real tracking should NOT be in completed[]
          const ordersInCompleted = completed.filter(item => 
            ordersWithoutTracking.some(order => order.orderId === item.orderId)
          );
          
          expect(ordersInCompleted).toHaveLength(0);
          
          // Assert: Orders without real tracking should be in tracking_fakes[] for monitoring
          expect(tracking_fakes).toBeDefined();
          expect(tracking_fakes.length).toBeGreaterThan(0);
          
          // Assert: tracking_fakes should contain the orders without tracking
          const orderIdsInTrackingFakes = tracking_fakes.map(item => item.orderId);
          ordersWithoutTracking.forEach(order => {
            expect(orderIdsInTrackingFakes).toContain(order.orderId);
          });
          
          // Assert: No fake tracking should be generated in tracking_fakes
          tracking_fakes.forEach(item => {
            expect(item.tracking).toBeUndefined();
            expect(item.note).toBeDefined();
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
   * Concrete test case to ensure reproducible failure on unfixed code
   */
  test('Concrete case: Single order without real tracking should not be in completed[]', async () => {
    // Setup: Mock order to have NO real tracking
    mockDb.orderCustomProduct.findOne.mockResolvedValue(null);

    // Create mock file with single order
    const mockFile = {
      buffer: Buffer.from('order-id\tdays-past-promise\nTEST123\t-2', 'utf8')
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
    const { completed, tracking_fakes } = batchData;

    // **CRITICAL ASSERTION**: This will FAIL on unfixed code
    // The unfixed code adds orders without real tracking to completed[] with fake tracking
    expect(completed).toHaveLength(0);
    
    // The order should be in tracking_fakes for monitoring
    expect(tracking_fakes).toHaveLength(1);
    expect(tracking_fakes[0].orderId).toBe('TEST123');
    expect(tracking_fakes[0].tracking).toBeUndefined(); // No fake tracking generated
  });

  /**
   * Test stats calculation bug condition
   */
  test('Stats calculation: totalOrders should equal totalReal + totalFake from separate arrays', async () => {
    // Setup: Mock mixed orders - some with tracking, some without
    mockDb.orderCustomProduct.findOne.mockImplementation(async (query) => {
      const orderId = query.orderId;
      // Orders starting with 'REAL' have tracking, others don't
      if (orderId.startsWith('REAL')) {
        return {
          items: [{
            tracking_info: {
              tracking: `REAL_TRACK_${orderId}`
            }
          }]
        };
      }
      return null; // No tracking
    });

    // Create mock file with mixed orders
    const mockFile = {
      buffer: Buffer.from('order-id\tdays-past-promise\nREAL001\t-2\nNOTRACK001\t-2\nREAL002\t-2\nNOTRACK002\t-2', 'utf8')
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
    const batchData = createCall[0];
    const { completed, tracking_fakes, stats } = batchData;

    // **BUG CONDITION**: On unfixed code, stats calculation is incorrect
    // Expected behavior: totalOrders = totalReal + totalFake
    // where totalReal = completed.length (only real tracking)
    // and totalFake = tracking_fakes.length (orders without tracking)
    
    const expectedTotalReal = completed.filter(item => !item.isFake).length;
    const expectedTotalFake = tracking_fakes.length;
    const expectedTotalOrders = expectedTotalReal + expectedTotalFake;

    expect(stats.totalReal).toBe(expectedTotalReal);
    expect(stats.totalFake).toBe(expectedTotalFake);
    expect(stats.totalOrders).toBe(expectedTotalOrders);
  });
});