jest.mock('../../models', () => ({
  ShippingBatch: { findById: jest.fn() },
  RealtimeLog: { create: jest.fn() },
}));

jest.mock('../../lib/taskEmitter', () => ({
  emitTaskToMachine: jest.fn(),
  buildTaskId: jest.fn(),
}));

const db = require('../../models');
const { emitTaskToMachine } = require('../../lib/taskEmitter');
const controller = require('../shippingBatch.contrller');

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

test('manual upload responds successfully after emitting the extension task', async () => {
  const batch = {
    _id: 'batch-1',
    machineId: 'machine-1',
    label: 'Batch 1',
    completed: [{ orderId: '111-3898217-9805865', tracking: '9214490411397506652594' }],
    review: {
      approvedAt: new Date(),
      confirmedSingleShipment: true,
      confirmedNoTransparency: true,
      shipDate: '2026-09-23',
    },
    save: jest.fn().mockResolvedValue(),
  };
  const io = {
    sockets: {
      sockets: new Map(),
      adapter: { rooms: new Map() },
    },
  };
  const req = {
    body: { batchId: 'batch-1', shopId: 'shop-1' },
    app: { get: jest.fn().mockReturnValue(io) },
  };
  const res = makeRes();
  const next = jest.fn();

  db.ShippingBatch.findById.mockResolvedValue(batch);
  db.RealtimeLog.create.mockResolvedValue({});
  emitTaskToMachine.mockResolvedValue({ taskId: 'upload_tracking:shop-1:batch-1' });

  await controller.manualUploadTask(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(db.RealtimeLog.create).toHaveBeenCalledWith(expect.objectContaining({
    machineId: 'machine-1',
    action: 'click',
  }));
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, batchId: 'batch-1' }));
});
