const db = require("../models");
const Job = db.Job;
const { addLog } = require("../service/realtime.service");

exports.claim = async (req, res) => {
  try {
    const clientId = (req.body?.clientId || "").trim();
    const label = (req.body?.label || "").trim();
    const assignee = clientId || label || "unknown";

    const job = await Job.findOneAndUpdate(
      { status: "queued", dueAt: { $lte: Date.now() } },
      {
        $set: {
          status: "running",
          assignedTo: assignee,
          updatedAt: Date.now(),
        },
        $inc: { attempts: 1 },
      },
      { sort: { dueAt: 1 }, returnDocument: "after" }
    ).lean();

    res.json(job || null);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
};

exports.complete = async (req, res) => {
  try {
    const {
      jobId,
      success,
      error,
      ms,
      count,
      created,
      updated,
      skipped,
      reportId,
      clientId,
      label,
    } = req.body || {};
    if (!jobId)
      return res.status(400).json({ ok: false, message: "jobId is required" });

    const job = await Job.findById(jobId);
    if (!job)
      return res.status(404).json({ ok: false, message: "job not found" });

    job.status = success ? "done" : "failed";
    job.metrics = { ms, count, created, updated, skipped, reportId };
    job.updatedAt = Date.now();
    await job.save();

    const base = {
      jobId: String(job._id),
      clientId,
      label,
      ms,
      count,
      created,
      updated,
      skipped,
      reportId,
    };
    await addLog("STATUS", {
      ...base,
      phase: "import",
      status: success ? "success" : "fail",
      error: success ? undefined : error || "unknown",
    });

    return res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
};
