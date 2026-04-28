/* eslint-disable no-console */
/**
 * Smoke test toàn bộ contract socket/task mới.
 *
 *   PORT=5000 SHOP_ID=test-shop MACHINE_ID=test-machine \
 *     node scripts/test-socket-task.js
 *
 * Mặc định: BASE_URL=http://localhost:5000, SHOP_ID=smoketest-shop,
 *           MACHINE_ID=smoketest-machine.
 *
 * Yêu cầu server đang chạy + MongoDB sống. Script không cleanup DB
 * (taskStatusEvents / extensionTasks) — eventId/taskId có timestamp ms
 * nên không trùng giữa các lần chạy.
 */

const { io } = require("socket.io-client");
const axios = require("axios").default;
const crypto = require("crypto");

const PORT = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// RealtimeLog schema yêu cầu shopId là ObjectId → dùng ObjectId hex hợp lệ
function fakeObjectId() {
  return crypto.randomBytes(12).toString("hex");
}
const SHOP_ID = process.env.SHOP_ID || fakeObjectId();
const MACHINE_ID = process.env.MACHINE_ID || fakeObjectId();
const RUN_ID = Date.now();

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) {
  pass++;
  console.log(`  ✅ ${name}`);
}
function nok(name, detail) {
  fail++;
  failures.push({ name, detail });
  console.log(`  ❌ ${name}${detail ? `\n     → ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n━━ ${title} ━━`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emitWithTimeout(socket, event, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`emit "${event}" timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    socket.timeout(timeoutMs).emit(event, payload, (err, ack) => {
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(ack);
    });
  });
}

async function main() {
  console.log(`🔌 Connecting socket to ${BASE_URL}/ws ...`);
  console.log(`   shopId=${SHOP_ID}  machineId=${MACHINE_ID}  runId=${RUN_ID}`);

  const socket = io(BASE_URL, {
    path: "/ws",
    transports: ["websocket"],
    reconnection: false,
    timeout: 5000,
    auth: {
      shopId: SHOP_ID,
      machineId: MACHINE_ID,
      label: "smoke-test",
      version: "0.0.0",
      ua: "node-smoke-test",
    },
  });

  // Bắt server:task để verify shape mới (taskId, sentAt) và resend
  const receivedTasks = [];
  socket.on("server:task", (msg) => {
    receivedTasks.push(msg);
    console.log(
      `   📥 received server:task taskId=${msg?.taskId} resent=${!!msg?.resent}`
    );
  });

  socket.on("connect_error", (e) => {
    console.error(`❌ connect_error: ${e.message}`);
  });

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout 5s")), 5000);
  });
  console.log(`✅ connected sid=${socket.id}\n`);

  // ──────────────────────────────────────────────────────────
  section("1. ext:heartbeat phải ACK { ok, serverTs }");
  // ──────────────────────────────────────────────────────────
  try {
    const t0 = Date.now();
    const ack = await emitWithTimeout(
      socket,
      "ext:heartbeat",
      { shopId: SHOP_ID, machineId: MACHINE_ID, ts: t0 },
      7000
    );
    const dt = Date.now() - t0;
    if (ack && ack.ok === true && typeof ack.serverTs === "number") {
      ok(`heartbeat ACK trong ${dt}ms — serverTs=${ack.serverTs}`);
    } else {
      nok("heartbeat ACK shape sai", JSON.stringify(ack));
    }
  } catch (e) {
    nok("heartbeat không có ACK", e.message);
  }

  // ──────────────────────────────────────────────────────────
  section("2. client:task — record mới phải deduped:false");
  // ──────────────────────────────────────────────────────────
  const taskId = `smoketest:${SHOP_ID}:${RUN_ID}`;
  const eventIdReceived = `${taskId}:received`;
  const eventIdCompleted = `${taskId}:completed`;

  try {
    const ack = await emitWithTimeout(socket, "client:task", {
      eventId: eventIdReceived,
      taskId,
      type: "SMOKE_TEST",
      status: "received",
      shopId: SHOP_ID,
      machineId: MACHINE_ID,
      source: "chrome_extension",
      reportedAt: new Date().toISOString(),
    });
    if (ack?.ok === true && ack.deduped === false) {
      ok(`record mới — deduped=false eventId=${ack.eventId}`);
    } else {
      nok("ACK lần 1 không đúng", JSON.stringify(ack));
    }
  } catch (e) {
    nok("client:task lần 1 timeout/lỗi", e.message);
  }

  // ──────────────────────────────────────────────────────────
  section("3. client:task — gửi lại cùng eventId phải deduped:true");
  // ──────────────────────────────────────────────────────────
  try {
    const ack = await emitWithTimeout(socket, "client:task", {
      eventId: eventIdReceived,
      taskId,
      type: "SMOKE_TEST",
      status: "received",
      shopId: SHOP_ID,
      machineId: MACHINE_ID,
      source: "chrome_extension",
      reportedAt: new Date().toISOString(),
    });
    if (ack?.ok === true && ack.deduped === true) {
      ok(`duplicate detected — deduped=true`);
    } else {
      nok("ACK lần 2 không phát hiện duplicate", JSON.stringify(ack));
    }
  } catch (e) {
    nok("client:task lần 2 timeout/lỗi", e.message);
  }

  // ──────────────────────────────────────────────────────────
  section("4. client:task — thiếu field bắt buộc phải fail");
  // ──────────────────────────────────────────────────────────
  try {
    const ack = await emitWithTimeout(socket, "client:task", {
      // thiếu eventId
      taskId,
      status: "completed",
    });
    if (ack?.ok === false && /eventId/i.test(ack.message || "")) {
      ok(`thiếu eventId → ACK ok:false (${ack.message})`);
    } else {
      nok("không reject khi thiếu eventId", JSON.stringify(ack));
    }
  } catch (e) {
    nok("client:task validate timeout/lỗi", e.message);
  }

  // ──────────────────────────────────────────────────────────
  section("5. POST /api/ext/task-result — REST fallback (mới + dedup)");
  // ──────────────────────────────────────────────────────────
  const restEventId = `rest:${taskId}:completed`;
  try {
    const r1 = await axios.post(
      `${BASE_URL}/api/ext/task-result`,
      {
        eventId: restEventId,
        taskId,
        type: "SMOKE_TEST",
        status: "completed",
        shopId: SHOP_ID,
        machineId: MACHINE_ID,
        source: "rest_fallback",
        reportedAt: new Date().toISOString(),
        result: { uploaded: 1 },
      },
      { validateStatus: () => true }
    );
    if (r1.status === 200 && r1.data?.ok && r1.data.deduped === false) {
      ok(`REST lần 1 — 200 deduped=false`);
    } else {
      nok(
        "REST lần 1 sai",
        `status=${r1.status} body=${JSON.stringify(r1.data)}`
      );
    }
  } catch (e) {
    nok("REST lần 1 lỗi", e.message);
  }

  try {
    const r2 = await axios.post(
      `${BASE_URL}/api/ext/task-result`,
      {
        eventId: restEventId,
        taskId,
        status: "completed",
        shopId: SHOP_ID,
        machineId: MACHINE_ID,
      },
      { validateStatus: () => true }
    );
    if (r2.status === 200 && r2.data?.ok && r2.data.deduped === true) {
      ok(`REST lần 2 — 200 deduped=true`);
    } else {
      nok(
        "REST lần 2 không dedup",
        `status=${r2.status} body=${JSON.stringify(r2.data)}`
      );
    }
  } catch (e) {
    nok("REST lần 2 lỗi", e.message);
  }

  try {
    const r3 = await axios.post(
      `${BASE_URL}/api/ext/task-result`,
      { taskId, status: "completed" }, // thiếu eventId
      { validateStatus: () => true }
    );
    if (r3.status === 400 && r3.data?.ok === false) {
      ok(`REST validate — 400 khi thiếu eventId (${r3.data.message})`);
    } else {
      nok(
        "REST validate sai",
        `status=${r3.status} body=${JSON.stringify(r3.data)}`
      );
    }
  } catch (e) {
    nok("REST validate lỗi", e.message);
  }

  // ──────────────────────────────────────────────────────────
  section("6. server:task — phát task qua /api/ext/command, kiểm shape");
  // ──────────────────────────────────────────────────────────
  receivedTasks.length = 0;
  let dispatchedTaskId = null;
  try {
    const r = await axios.post(
      `${BASE_URL}/api/ext/command`,
      {
        shopId: SHOP_ID,
        machineId: MACHINE_ID,
        type: "SMOKE_TEST_DISPATCH",
        payload: { hello: "world", runId: RUN_ID },
      },
      { validateStatus: () => true }
    );
    if (r.status === 200 && r.data?.ok && r.data.taskId) {
      ok(`POST /command — response chứa taskId=${r.data.taskId}`);
      dispatchedTaskId = r.data.taskId;
    } else {
      nok(
        "POST /command sai response",
        `status=${r.status} body=${JSON.stringify(r.data)}`
      );
    }
  } catch (e) {
    nok("POST /command lỗi", e.message);
  }

  // Đợi server emit về socket
  await sleep(500);

  if (receivedTasks.length === 0) {
    nok("server:task không nhận được sau dispatch");
  } else {
    const msg = receivedTasks[receivedTasks.length - 1];
    const okShape =
      msg &&
      typeof msg.taskId === "string" &&
      msg.type === "SMOKE_TEST_DISPATCH" &&
      msg.payload &&
      msg.payload.taskId === msg.taskId &&
      typeof msg.sentAt === "string";
    if (okShape) {
      ok(
        `server:task shape mới — taskId=${msg.taskId}, payload.taskId khớp, sentAt=${msg.sentAt}`
      );
    } else {
      nok("server:task shape sai", JSON.stringify(msg));
    }
    if (dispatchedTaskId && msg.taskId !== dispatchedTaskId) {
      nok(
        "taskId trong server:task khác response REST",
        `${msg.taskId} vs ${dispatchedTaskId}`
      );
    }
  }

  // ──────────────────────────────────────────────────────────
  section("7. client:pull_pending_tasks — resend task chưa hoàn tất");
  // ──────────────────────────────────────────────────────────
  // Phát thêm 1 task nữa nhưng KHÔNG báo completed → sẽ là pending
  let pendingTaskId = null;
  try {
    const r = await axios.post(
      `${BASE_URL}/api/ext/command`,
      {
        shopId: SHOP_ID,
        machineId: MACHINE_ID,
        type: "SMOKE_PENDING",
        payload: { runId: RUN_ID, marker: "pending" },
      },
      { validateStatus: () => true }
    );
    pendingTaskId = r.data?.taskId;
    ok(`đã phát pending task taskId=${pendingTaskId}`);
  } catch (e) {
    nok("phát pending task lỗi", e.message);
  }

  await sleep(300);
  receivedTasks.length = 0; // clear để chỉ bắt resend

  try {
    const ack = await emitWithTimeout(
      socket,
      "client:pull_pending_tasks",
      { shopId: SHOP_ID, machineId: MACHINE_ID },
      5000
    );
    if (ack?.ok === true && typeof ack.count === "number") {
      ok(`pull_pending ACK count=${ack.count}`);
    } else {
      nok("pull_pending ACK sai", JSON.stringify(ack));
    }
  } catch (e) {
    nok("pull_pending timeout/lỗi", e.message);
  }

  await sleep(500);
  const resentMatch = receivedTasks.find(
    (m) => m.taskId === pendingTaskId && m.resent === true
  );
  if (resentMatch) {
    ok(
      `nhận lại pending task qua resend — taskId=${resentMatch.taskId} resent=true`
    );
  } else {
    nok(
      `không nhận lại pending taskId=${pendingTaskId}`,
      `received=${JSON.stringify(receivedTasks.map((m) => ({ taskId: m.taskId, resent: m.resent })))}`
    );
  }

  // ──────────────────────────────────────────────────────────
  section("8. status=completed sau resend → task không còn pending");
  // ──────────────────────────────────────────────────────────
  try {
    await emitWithTimeout(socket, "client:task", {
      eventId: `${pendingTaskId}:completed`,
      taskId: pendingTaskId,
      status: "completed",
      shopId: SHOP_ID,
      machineId: MACHINE_ID,
      result: { ok: true },
    });
    await sleep(200);

    receivedTasks.length = 0;
    const ack = await emitWithTimeout(
      socket,
      "client:pull_pending_tasks",
      { shopId: SHOP_ID, machineId: MACHINE_ID },
      5000
    );
    await sleep(300);
    const stillPending = receivedTasks.find((m) => m.taskId === pendingTaskId);
    if (!stillPending) {
      ok(`task đã completed, không còn trong pending (count=${ack.count})`);
    } else {
      nok(
        `task vẫn còn pending sau khi báo completed`,
        JSON.stringify(stillPending)
      );
    }
  } catch (e) {
    nok("flow completed→pull lỗi", e.message);
  }

  // ──────────────────────────────────────────────────────────
  socket.disconnect();
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Tổng: ${pass + fail}    ✅ pass=${pass}    ❌ fail=${fail}`);
  if (fail > 0) {
    console.log(`\nChi tiết fail:`);
    for (const f of failures) {
      console.log(`  • ${f.name}${f.detail ? `\n      ${f.detail}` : ""}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ Fatal:", e.message);
  console.error(e.stack);
  process.exit(2);
});
