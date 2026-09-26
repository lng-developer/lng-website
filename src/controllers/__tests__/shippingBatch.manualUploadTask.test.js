jest.mock('../../models', () => ({
  orderCustomProduct: { find: jest.fn() },
  ShippingBatch: { findById: jest.fn() },
  RealtimeLog: { create: jest.fn() },
}));

jest.mock('../../lib/taskEmitter', () => ({
  emitTaskToMachine: jest.fn(),
  buildTaskId: jest.fn(),
}));

jest.mock('../../service/amazonConfirmationReservation.service', () => ({
  markAmazonConfirmationSubmitted: jest.fn(),
  releaseAmazonConfirmationReservation: jest.fn(),
  reserveAmazonConfirmation: jest.fn(),
}));

const db = require('../../models');
const { emitTaskToMachine } = require('../../lib/taskEmitter');
const { markAmazonConfirmationSubmitted } = require('../../service/amazonConfirmationReservation.service');
const controller = require('../shippingBatch.contrller');

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

test('manual upload responds successfully after emitting the extension task', async () => {
  const batch = {
    _id: 'batch-1',
    shopId: 'shop-1',
    machineId: 'machine-1',
    label: 'Batch 1',
    completed: [{ orderId: '111-3898217-9805865', tracking: '9214490411397506652594', carrier: 'USPS', shipDate: '2026-09-26' }],
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
      adapter: { rooms: new Map([['machine:machine-1', new Set(['socket-1'])]]) },
    },
  };
  const req = {
    body: { batchId: 'batch-1', shopId: 'shop-1' },
    app: { get: jest.fn((key) => key === 'io' ? io : { getByMachine: () => ({ shopId: 'shop-1', status: 'online' }) }) },
  };
  const res = makeRes();
  const next = jest.fn();

  db.ShippingBatch.findById.mockResolvedValue(batch);
  const query = { lean: jest.fn().mockResolvedValue([{
    orderId: '111-3898217-9805865',
    shopId: 'shop-1',
    status: 'Shipped',
    shipByDate: new Date('2026-09-24T07:00:00.000Z'),
    items: [{ tracking_info: { tracking: '9214490411397506652594', carrier: 'USPS', actualShipAt: new Date('2026-09-23T05:00:00.000Z') } }],
  }]) };
  db.orderCustomProduct.find.mockReturnValue(query);
  db.RealtimeLog.create.mockResolvedValue({});
  emitTaskToMachine.mockResolvedValue({ taskId: 'upload_tracking:shop-1:batch-1' });
  markAmazonConfirmationSubmitted.mockResolvedValue({ submitted: true });

  await controller.manualUploadTask(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(db.RealtimeLog.create).toHaveBeenCalledWith(expect.objectContaining({
    machineId: 'machine-1',
    action: 'click',
  }));
  expect(emitTaskToMachine).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    payload: expect.objectContaining({
      file: expect.objectContaining({ content: expect.stringContaining('2026-09-23') }),
    }),
  }));
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, batchId: 'batch-1' }));
});
