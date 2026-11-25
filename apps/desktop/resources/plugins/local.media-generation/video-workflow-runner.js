"use strict";

const { planVideo } = require("./video-workflows.js");
const { readFrame } = require("./reference-frames.js");

const COMPLETE = new Set(["saved", "save-failed", "failed", "unknown"]);

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function createVideoWorkflowRunner({
  api, provider, keyState, rejectKeyIfCurrent, requireHost, update, start, schedulePoll, keepRecord, warn,
}) {
  const active = new Map();
  const fingerprints = new Set();

  async function capability(method) {
    try {
      return await api?.[method]?.() === true;
    } catch {
      return false;
    }
  }

  async function plan(input) {
    const video = planVideo(input);
    await requireHost();
    if (!await capability("supportsVideoWorkflows")) throw fail("UPDATE_REQUIRED");
    if (video.parts.length > 1 && !await capability("supportsVideoStitching")) throw fail("STITCH_UNAVAILABLE");
    return video;
  }

  async function quote(input) {
    const { requests, totalSeconds } = await plan(input);
    return { requests, totalSeconds };
  }

  function authorized(batch) {
    const { key, revision } = keyState();
    return key && revision === batch.revision;
  }

  async function stopBatch(batch) {
    const remaining = batch.pending.splice(0);
    for (const record of remaining) {
      try {
        await update(record, "failed", "BATCH_INTERRUPTED");
      } catch {
        warn("BATCH_CLEANUP_FAILED");
      }
    }
    fingerprints.delete(batch.fingerprint);
  }

  async function submitPart(record, batch, index, lastFrame) {
    if (!authorized(batch)) {
      await update(record, "unknown", "SEQUENCE_INTERRUPTED");
      return;
    }
    const part = batch.parts[index];
    const first = part.continuation ? lastFrame : part.first?.url;
    // Authorize the owning session before each POST. A pending record is
    // already durable, and a process crash here never causes a new POST.
    const current = await update(record, "running");
    if (current?.status !== "running") return;
    if (!authorized(batch)) {
      await update(record, "unknown", "SEQUENCE_INTERRUPTED");
      return;
    }

    let taskId;
    try {
      taskId = await provider.submitVideo({
        ...record, prompt: part.prompt, duration: part.duration, generateAudio: batch.generateAudio,
      }, keyState().key, { first, last: part.last?.url, references: part.references });
    } catch (error) {
      rejectKeyIfCurrent(error.code, batch.revision);
      await update(record, error.uncertain ? "unknown" : "failed",
        error.uncertain ? "SUBMISSION_UNKNOWN" : error.code);
      return;
    }
    const submitted = await update(record, "running", undefined, taskId, batch.parts.length > 1 ? index : undefined);
    if (submitted?.status === "running") schedulePoll(submitted);
  }

  function startNext(batch) {
    const record = batch.pending.shift();
    if (!record) {
      fingerprints.delete(batch.fingerprint);
      return;
    }
    active.set(record.id, batch);
    start(record.id, async () => {
      try {
        await submitPart(record, batch, 0);
      } catch {
        if (active.delete(record.id)) await stopBatch(batch);
        // A failure saving a returned task ID can leave the POST untracked.
        // Do not issue further requests or assume that this one was rejected.
        await update(record, "unknown", "SUBMISSION_UNKNOWN");
      }
    });
  }

  function recordChanged(record) {
    const batch = active.get(record.id);
    if (!batch || !COMPLETE.has(record.status)) return;
    active.delete(record.id);
    if (record.status === "saved" && authorized(batch)) {
      startNext(batch);
    } else {
      void stopBatch(batch).catch(() => warn("BATCH_CLEANUP_FAILED"));
    }
  }

  async function submit(input) {
    const { key, revision } = keyState();
    if (!key) throw fail("KEY_REQUIRED");
    const video = await plan(input);
    if (video.requests > 1 && input.confirmedRequests !== video.requests) throw fail("CONFIRM_REQUESTS");
    if (fingerprints.has(video.fingerprint)) throw fail("BUSY");
    const batch = { ...video, revision, pending: [] };
    fingerprints.add(batch.fingerprint);
    try {
      // Reserve every output before the first billable operation. The host
      // can reject selection changes between reserves.
      for (let index = 0; index < video.count; index += 1) {
        if (!authorized(batch)) throw fail("KEY_REQUIRED");
        const record = await api.reserve(video.record);
        batch.pending.push(record);
        keepRecord(record);
      }
      if (!authorized(batch)) throw fail("KEY_REQUIRED");
      const items = [...batch.pending];
      startNext(batch);
      return { items };
    } catch (error) {
      await stopBatch(batch);
      throw error;
    }
  }

  function isSequence(record) {
    return record.plannedRequests > 1;
  }

  async function saveSegment(record, videoUrl, retrySave) {
    const index = record.segment;
    const final = index === record.plannedRequests - 1;
    const batch = retrySave ? undefined : active.get(record.id);
    let lastFrame;
    try {
      if (final) {
        const saving = await update(record, "saving");
        if (saving?.status !== "saving") return;
      }
      const staged = await api.stageVideo({
        id: record.id, index, videoUrl,
        ...(batch?.parts[index + 1]?.continuation && authorized(batch) ? { extractLastFrame: true } : {}),
      });
      if (final) {
        keepRecord(await api.finishVideo({ id: record.id, count: record.plannedRequests }));
        return;
      }
      lastFrame = staged?.lastFrame;
      if (batch?.parts[index + 1]?.continuation && authorized(batch)) lastFrame = readFrame(lastFrame).url;
    } catch {
      await update(record, "save-failed", "SAVE_FAILED");
      return;
    }
    if (!batch || !authorized(batch)) {
      await update(record, "unknown", "SEQUENCE_INTERRUPTED");
      return;
    }
    try {
      await submitPart(record, batch, index + 1, lastFrame);
    } catch {
      if (active.delete(record.id)) await stopBatch(batch);
      await update(record, "unknown", "SUBMISSION_UNKNOWN");
    }
  }

  function dispose() {
    active.clear();
    fingerprints.clear();
  }

  return { capability, quote, submit, recordChanged, isSequence, saveSegment, dispose };
}

module.exports = { createVideoWorkflowRunner };
