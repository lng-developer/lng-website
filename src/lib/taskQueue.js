// src/lib/taskQueue.js
const clientQueues = new Map(); // machineId -> { busy:bool, list: Array<task>, _runningWatchdog?: Timeout }

function getQueues() {
  return clientQueues;
}

function drainQueue(machineId, io) {
  const q = clientQueues.get(machineId);
  if (!q || q.busy) return;
  const next = q.list.shift();
  if (!next) return;
  q.busy = true;

  // phát task xuống client theo room machine
  io.to(`machine:${machineId}`).emit("server:task", next);

  // bật watchdog 120s
  q._runningWatchdog = setTimeout(() => {
    try {
      io.emit("job:update", { jobId: next.jobId, status: "timeout" });
    } catch {}
    q.busy = false;
    drainQueue(machineId, io);
  }, 120000);
}

function pushToQueue(machineId, task, io) {
  if (!clientQueues.has(machineId))
    clientQueues.set(machineId, { busy: false, list: [] });
  const q = clientQueues.get(machineId);
  q.list.push(task);
  if (!q.busy) drainQueue(machineId, io);
}

module.exports = { getQueues, drainQueue, pushToQueue };
