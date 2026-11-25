"use strict";

const { createMiniMaxClient } = require("./minimax.js");
const { planImage } = require("./image-workflows.js");
const { readReferenceFrames } = require("./reference-frames.js");
const { createVideoWorkflowRunner } = require("./video-workflow-runner.js");

const POLL_INTERVAL_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const VIDEO_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETAINED_IMAGE_BYTES = 16 * 1024 * 1024;
const RATIOS = new Set(["1:1", "16:9", "9:16"]);
const DURATIONS = new Set([4, 6, 8]);
const PENDING = new Set(["submitting", "running", "saving", "save-failed"]);

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function validateSubmission(input) {
  const { sessionId, kind, ratio = kind === "image" ? "1:1" : "16:9", duration } = input ?? {};
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (typeof sessionId !== "string" || !sessionId || !["image", "video"].includes(kind) ||
      !prompt || prompt.length > 8000 || Array.from(prompt).length > 4000 || !RATIOS.has(ratio) ||
      (kind === "video" && !DURATIONS.has(duration ?? 4))) {
    throw fail("INVALID_INPUT");
  }
  return { sessionId, kind, prompt, ratio, ...(kind === "video" ? { duration: duration ?? 4 } : {}) };
}

function createMediaRuntime(pi, {
  now = Date.now,
  schedule = setTimeout,
  unschedule = clearTimeout,
  warn = (message) => console.warn(message),
} = {}) {
  const api = pi.sessionMedia;
  const provider = createMiniMaxClient((input) => pi.net.fetch(input), now);
  const jobs = new Map();
  const running = new Map();
  const pendingRetries = new Set();
  const submissions = new Set();
  const timers = new Map();
  const failedImages = new Map();
  let imageBytes = 0;
  let key = "";
  let keyRevision = 0;
  let disposed = false;

  function safeWarning(code) {
    // Provider responses and host exceptions may contain credentials, prompts,
    // paths or signed URLs. Report only a fixed diagnostic.
    if (!disposed) warn("[media-generation] " + code);
  }

  async function supports(method) {
    if (disposed || typeof api?.[method] !== "function") return false;
    try {
      const supported = await api[method]();
      return !disposed && supported === true;
    } catch {
      return false;
    }
  }

  async function requireHost() {
    if (!await supports("capabilities")) throw fail("UPDATE_REQUIRED");
  }

  function clearPolls() {
    for (const timer of timers.values()) unschedule(timer);
    timers.clear();
  }

  function setKey(value) {
    key = value;
    keyRevision += 1;
    clearPolls();
  }

  function rejectKeyIfCurrent(error, revision) {
    if (error === "INVALID_KEY" && revision === keyRevision) setKey("");
  }

  function keepRecord(record) {
    if (disposed) return;
    if (PENDING.has(record.status)) jobs.set(record.id, record);
    else jobs.delete(record.id);
    workflows.recordChanged(record);
  }

  async function update(record, status, error, taskId, segment) {
    if (disposed) return;
    const attempt = running.get(record.id);
    // History can display this write before the host acknowledges it here.
    if (attempt && status === "save-failed") attempt.reportingSaveFailure = true;
    const updated = await api.update({
      id: record.id,
      status,
      ...(error ? { error } : {}),
      ...(taskId ? { taskId } : {}),
      ...(segment !== undefined ? { segment } : {}),
    });
    keepRecord(updated);
    return updated;
  }

  function startRecords(ids, action) {
    if (disposed || ids.some((id) => running.has(id))) return false;
    const attempts = new Map();
    for (const id of ids) {
      const { promise: finished, resolve } = Promise.withResolvers();
      const attempt = { finished, resolve, reportingSaveFailure: false, retryRequested: false };
      attempts.set(id, attempt);
      running.set(id, attempt);
    }
    function finishRecord(id) {
      const attempt = attempts.get(id);
      if (!attempt || running.get(id) !== attempt) return;
      running.delete(id);
      attempt.resolve();
    }
    void Promise.resolve().then(() => action(finishRecord)).catch(() => safeWarning("JOB_UPDATE_FAILED")).finally(() => {
      for (const id of ids) finishRecord(id);
    });
    return true;
  }

  function start(id, action) {
    return startRecords([id], action);
  }

  function forgetImage(id) {
    const image = failedImages.get(id);
    if (image) imageBytes -= image.length;
    failedImages.delete(id);
  }

  function retainImage(id, bytes) {
    forgetImage(id);
    if (imageBytes + bytes.length > MAX_RETAINED_IMAGE_BYTES) return false;
    failedImages.set(id, bytes);
    imageBytes += bytes.length;
    return true;
  }

  async function saveImage(record, bytes) {
    if (disposed) return;
    try {
      await update(record, "saving");
      if (disposed) return;
      keepRecord(await api.archive({ id: record.id, jpegBase64: bytes }));
      forgetImage(record.id);
    } catch {
      if (disposed) return;
      const retained = retainImage(record.id, bytes);
      await update(record, "save-failed", retained ? "SAVE_FAILED" : "IMAGE_DATA_UNAVAILABLE");
    }
  }

  async function saveVideo(record, url) {
    if (disposed) return;
    try {
      await update(record, "saving");
      if (disposed) return;
      keepRecord(await api.archive({ id: record.id, videoUrl: url }));
    } catch {
      await update(record, "save-failed", "SAVE_FAILED");
    }
  }

  function schedulePoll(record, { delay = 0, failures = 0, retrySave = false } = {}) {
    if (disposed || !key || timers.has(record.id)) return;
    const timer = schedule(() => {
      timers.delete(record.id);
      start(record.id, () => pollVideo(record, failures, retrySave));
    }, delay);
    timers.set(record.id, timer);
  }

  async function pollVideo(record, failures, retrySave) {
    if (disposed || !key) return;
    const revision = keyRevision;
    const expiresIn = record.createdAt + VIDEO_LIFETIME_MS - now();
    const failureStatus = retrySave || record.status === "saving" ? "save-failed" : "failed";
    if (expiresIn <= 0) {
      await update(record, failureStatus, "VIDEO_EXPIRED");
      return;
    }
    let result;
    try {
      result = await provider.queryVideo(record.taskId, key);
    } catch (error) {
      if (disposed) return;
      if (revision !== keyRevision) {
        schedulePoll(record, { retrySave });
        return;
      }
      if (error.code === "UNSUPPORTED_MEDIA_HOST") {
        await update(record, "save-failed", error.code);
        return;
      }
      if (!error.transient && error.code !== "INVALID_KEY") {
        await update(record, "failed", error.code);
        return;
      }
      const status = retrySave || record.status === "saving" ? "save-failed" : "running";
      rejectKeyIfCurrent(error.code, revision);
      const updated = await update(record, status, error.code);
      if (error.transient) {
        const backoff = Math.min(POLL_INTERVAL_MS * 2 ** Math.min(failures, 4), MAX_RETRY_DELAY_MS);
        schedulePoll(updated, {
          delay: Math.min(Math.max(backoff, error.retryAfterMs), expiresIn),
          failures: failures + 1,
          retrySave,
        });
      }
      return;
    }
    if (disposed) return;
    switch (result.status) {
      case "queued":
      case "running": {
        const updated = record.status === "running" && !record.error
          ? record : await update(record, "running");
        schedulePoll(updated, { delay: POLL_INTERVAL_MS, retrySave });
        break;
      }
      case "succeeded":
        if (workflows.isSequence(record)) await workflows.saveSegment(record, result.videoUrl, retrySave);
        else await saveVideo(record, result.videoUrl);
        break;
      case "failed":
      case "cancelled":
        await update(record, "failed", result.status === "failed" ? "VIDEO_FAILED" : "VIDEO_CANCELLED");
        break;
    }
  }

  async function generate(record, revision, frames) {
    if (disposed) return;
    if (!key || revision !== keyRevision) {
      await update(record, "failed", "KEY_REQUIRED");
      return;
    }

    let output;
    try {
      output = record.kind === "image"
        ? await provider.image(record, key)
        : await provider.submitVideo(record, key, frames);
    } catch (error) {
      rejectKeyIfCurrent(error.code, revision);
      await update(record, error.uncertain ? "unknown" : "failed",
        error.uncertain ? "SUBMISSION_UNKNOWN" : error.code);
      return;
    }
    if (disposed) return;
    if (record.kind === "image") {
      await saveImage(record, output);
    } else {
      const submitted = await update(record, "running", undefined, output);
      if (submitted) schedulePoll(submitted);
    }
  }

  async function recover() {
    if (!await supports("capabilities")) return;
    for (const record of await api.recoverable()) {
      if (disposed || jobs.has(record.id) || running.has(record.id)) continue;
      keepRecord(record);
      if (record.kind === "video" && record.taskId) continue;
      const imageWasGenerated = record.kind === "image" && ["saving", "save-failed"].includes(record.status);
      if (record.status === "save-failed" && record.error === "IMAGE_DATA_UNAVAILABLE") continue;
      start(record.id, () => imageWasGenerated
        ? update(record, "save-failed", "IMAGE_DATA_UNAVAILABLE")
        : update(record, "unknown", "SUBMISSION_UNKNOWN"));
    }
  }

  let recovering;
  function refreshRecoverable() {
    if (!recovering) {
      recovering = recover().catch(() => safeWarning("RECOVERY_FAILED")).finally(() => {
        recovering = undefined;
      });
    }
    return recovering;
  }

  const workflows = createVideoWorkflowRunner({
    api, provider, keyState: () => ({ key, revision: keyRevision }), rejectKeyIfCurrent, requireHost,
    update, start, schedulePoll, keepRecord, warn: safeWarning,
  });

  void refreshRecoverable();

  async function resume() {
    await refreshRecoverable();
    for (const record of jobs.values()) {
      if (!running.has(record.id) && record.kind === "video" && record.taskId &&
          ["running", "saving"].includes(record.status)) {
        schedulePoll(record);
      }
    }
  }

  async function submit(input) {
    if (!key) throw fail("KEY_REQUIRED");
    const form = validateSubmission(input);
    if (input.frames !== undefined && form.kind !== "video") throw fail("INVALID_INPUT");
    const { first, last, mode } = readReferenceFrames(input.frames);
    const fingerprint = JSON.stringify([form, first?.digest, last?.digest]);
    if (submissions.has(fingerprint)) throw fail("BUSY");
    const revision = keyRevision;
    submissions.add(fingerprint);
    try {
      await requireHost();
      if (mode && !await supports("supportsReferenceFrames")) throw fail("UPDATE_REQUIRED");
      if (revision !== keyRevision || !key) throw fail("KEY_REQUIRED");
      const record = await api.reserve(mode ? { ...form, frameMode: mode } : form);
      keepRecord(record);
      if (!start(record.id, async () => {
        try {
          await generate(record, revision, { first: first?.url, last: last?.url });
        } finally {
          submissions.delete(fingerprint);
        }
      })) {
        throw fail("BUSY");
      }
      return record;
    } catch (error) {
      submissions.delete(fingerprint);
      throw error;
    }
  }

  async function setImageBatchStatus(items, status, error) {
    for (const record of items) {
      try {
        await update(record, status, error);
      } catch {
        safeWarning("JOB_UPDATE_FAILED");
      }
    }
  }

  async function generateImageBatch(items, form, revision, finishRecord) {
    let outcomes;
    try {
      // Reauthorize the durable session before making the billable request.
      for (const record of items) {
        const active = await update(record, "running");
        if (active?.status !== "running") throw fail("BATCH_INTERRUPTED");
      }
    } catch {
      await setImageBatchStatus(items, "failed", "BATCH_INTERRUPTED");
      return;
    }
    if (disposed) return;
    if (!key || revision !== keyRevision) {
      await setImageBatchStatus(items, "failed", "KEY_REQUIRED");
      return;
    }
    try {
      outcomes = await provider.imageBatch({ ...form.record, prompt: form.providerPrompt }, key, form);
    } catch (error) {
      rejectKeyIfCurrent(error.code, revision);
      await setImageBatchStatus(items, error.uncertain ? "unknown" : "failed",
        error.uncertain ? "SUBMISSION_UNKNOWN" : error.code);
      return;
    }
    for (const [index, item] of items.entries()) {
      const { bytes, status, error } = outcomes[index];
      try {
        if (bytes) await saveImage(item, bytes);
        else await update(item, status, error);
      } catch {
        safeWarning("JOB_UPDATE_FAILED");
      } finally {
        finishRecord(item.id);
      }
    }
  }

  async function submitImage(input) {
    if (!key) throw fail("KEY_REQUIRED");
    const form = planImage(input);
    const { fingerprint } = form;
    if (submissions.has(fingerprint)) throw fail("BUSY");
    const revision = keyRevision;
    const items = [];
    submissions.add(fingerprint);
    try {
      await requireHost();
      if (!await supports("supportsImageWorkflows")) throw fail("UPDATE_REQUIRED");
      for (let index = 0; index < form.count; index += 1) {
        if (revision !== keyRevision || !key) throw fail("KEY_REQUIRED");
        const record = await api.reserve(form.record);
        items.push(record);
        keepRecord(record);
      }
      if (revision !== keyRevision || !key) throw fail("KEY_REQUIRED");
      if (!startRecords(items.map(({ id }) => id), async (finishRecord) => {
        try {
          await generateImageBatch(items, form, revision, finishRecord);
        } finally {
          submissions.delete(fingerprint);
        }
      })) throw fail("BUSY");
      return { items };
    } catch (error) {
      await setImageBatchStatus(items, "failed", error?.code === "KEY_REQUIRED" ? "KEY_REQUIRED" : "BATCH_INTERRUPTED");
      submissions.delete(fingerprint);
      throw error;
    }
  }

  async function retrySave(input) {
    const { id, sessionId } = input ?? {};
    const attemptAtClick = running.get(id);
    const retryWasPending = pendingRetries.has(id);
    await requireHost();
    if (!jobs.has(id)) await refreshRecoverable();
    const active = await pi.session.getActive();
    if (!active || active.sessionId !== sessionId) throw fail("NO_SESSION");
    if (jobs.get(id)?.sessionId !== active.sessionId) throw fail("RECOVERY_UNAVAILABLE");

    if (retryWasPending || pendingRetries.has(id) || attemptAtClick?.retryRequested) throw fail("BUSY");
    const attempt = running.get(id);
    if (!attempt?.reportingSaveFailure) return startSaveRetry(id, sessionId);

    // Hold the retry through the second session check, even after the original
    // attempt releases its running entry.
    attempt.retryRequested = true;
    pendingRetries.add(id);
    try {
      await attempt.finished;
      if (disposed) throw fail("UPDATE_REQUIRED");
      if ((await pi.session.getActive())?.sessionId !== sessionId) throw fail("NO_SESSION");
      return startSaveRetry(id, sessionId);
    } finally {
      pendingRetries.delete(id);
    }
  }

  function startSaveRetry(id, sessionId) {
    if (disposed) throw fail("UPDATE_REQUIRED");
    const record = jobs.get(id);
    if (!record || record.sessionId !== sessionId || record.status !== "save-failed") {
      throw fail("RECOVERY_UNAVAILABLE");
    }
    if (running.has(record.id) || timers.has(record.id)) throw fail("BUSY");
    if (record.kind === "image") {
      const bytes = failedImages.get(record.id);
      if (!bytes) throw fail("RECOVERY_UNAVAILABLE");
      if (!start(record.id, () => saveImage(record, bytes))) throw fail("BUSY");
    } else {
      if (!key) throw fail("KEY_REQUIRED");
      if (!record.taskId) throw fail("RECOVERY_UNAVAILABLE");
      if (!start(record.id, () => pollVideo(record, 0, true))) throw fail("BUSY");
    }
    return { accepted: true };
  }

  return {
    async invoke(channel, input) {
      switch (channel) {
        case "media.keyStatus": {
          const [referenceFrames, videoWorkflows, imageWorkflows] = await Promise.all([
            supports("supportsReferenceFrames"), workflows.capability("supportsVideoWorkflows"),
            supports("supportsImageWorkflows"),
          ]);
          const videoStitch = videoWorkflows && await workflows.capability("supportsVideoStitching");
          return { configured: Boolean(key), referenceFrames,
            ...(videoWorkflows ? { videoWorkflows, videoStitch } : {}),
            ...(imageWorkflows ? { imageWorkflows } : {}) };
        }
        case "media.setKey": {
          await requireHost();
          const value = typeof input?.key === "string" ? input.key.trim() : null;
          if (value === null || (value !== "" && !/^[\x21-\x7e]{1,2048}$/.test(value))) {
            throw fail("INVALID_INPUT");
          }
          setKey(value);
          if (key) void resume().catch(() => safeWarning("RESUME_FAILED"));
          return { configured: Boolean(key) };
        }
        case "media.submit":
          return submit(input);
        case "media.submitImage":
          return submitImage(input);
        case "media.quoteVideo":
          return workflows.quote(input);
        case "media.submitVideo":
          return workflows.submit(input);
        case "media.retrySave":
          return retrySave(input);
        default:
          throw fail("UNSUPPORTED");
      }
    },

    dispose() {
      disposed = true;
      setKey("");
      jobs.clear();
      workflows.dispose();
      for (const attempt of running.values()) attempt.resolve();
      running.clear();
      pendingRetries.clear();
      submissions.clear();
      failedImages.clear();
      imageBytes = 0;
    },
  };
}

let runtime;

module.exports = {
  onLoad() {
    runtime = createMediaRuntime(globalThis.pi);
  },
  onUnload() {
    runtime?.dispose();
    runtime = undefined;
  },
  onPanelInvoke(channel, input) {
    if (!runtime) throw fail("UPDATE_REQUIRED");
    return runtime.invoke(channel, input);
  },
  createMediaRuntime,
};
