"use strict";

const API_ORIGIN = "https://api.minimax.cn";
const IMAGE_TIMEOUT_MS = 610_000;
const TASK_TIMEOUT_MS = 30_000;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MEDIA_HOSTS = new Set(["cdn.hailuoai.com"]);

class MiniMaxError extends Error {
  constructor(code, { uncertain = false, transient = false, retryAfterMs = 0 } = {}) {
    super(code);
    this.code = code;
    this.uncertain = uncertain;
    this.transient = transient;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMs(value, now) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return Math.max(0, Date.parse(value) - now) || 0;
}

function rejection(status, retryAfter) {
  switch (status) {
    case 401:
    case 403:
      return new MiniMaxError("INVALID_KEY");
    case 402:
      return new MiniMaxError("INSUFFICIENT_BALANCE");
    case 422:
      return new MiniMaxError("PROMPT_REJECTED");
    case 404:
      return new MiniMaxError("VIDEO_TASK_UNAVAILABLE");
    case 429:
      return new MiniMaxError("RATE_LIMITED", { transient: true, retryAfterMs: retryAfter });
    default:
      return status === 408 || status >= 500
        ? new MiniMaxError("PROVIDER_UNAVAILABLE", { uncertain: true, transient: true })
        : new MiniMaxError("PROVIDER_REJECTED");
  }
}

function parseVideoUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MiniMaxError("UNSUPPORTED_MEDIA_HOST");
  }
  if (url.protocol !== "https:" || !MEDIA_HOSTS.has(url.hostname) || url.port ||
      url.username || url.password || url.hash) {
    throw new MiniMaxError("UNSUPPORTED_MEDIA_HOST");
  }
  return url.href;
}

function malformedResponse() {
  return new MiniMaxError("PROVIDER_UNAVAILABLE", { uncertain: true, transient: true });
}

function isImagePromptRejected(entry) {
  return entry?.error && ["1026", "1027"].includes(String(entry.error.code));
}

function createMiniMaxClient(fetch, now = Date.now) {
  async function request(path, key, timeoutMs, body) {
    const headers = { Authorization: "Bearer " + key };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch({
        url: API_ORIGIN + path,
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        timeoutMs,
      });
    } catch {
      throw malformedResponse();
    }
    if (!Number.isInteger(response?.status)) throw malformedResponse();
    if (response.status < 200 || response.status >= 300) {
      throw rejection(response.status, retryAfterMs(response.headers?.["retry-after"], now()));
    }
    try {
      const value = JSON.parse(response.bodyText);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw malformedResponse();
      return value;
    } catch {
      throw malformedResponse();
    }
  }

  async function requestImages({ imageModel, prompt, ratio, imageArea }, key, count, images) {
    return request(images.length ? "/v1/images/edits" : "/v1/images/generations", key, IMAGE_TIMEOUT_MS, {
      model: imageModel,
      prompt,
      aspect_ratio: ratio,
      area: imageArea,
      n: count,
      output_format: "jpeg",
      response_format: "b64_json",
      // Keep 4K JPEGs within the host's bounded archival path in typical use.
      ...(imageArea === "4K" ? { output_compression: 85 } : {}),
      ...(images.length ? { images: images.map(({ url }) => ({ image_url: url })) } : {}),
    });
  }

  return {
    async image(job, key) {
      const result = await requestImages({ ...job, imageModel: "MiniMax-H3-Image", imageArea: "1K" }, key, 1, []);
      const image = result.data?.[0];
      if (isImagePromptRejected(image)) throw new MiniMaxError("PROMPT_REJECTED");
      if (typeof image?.b64_json !== "string" || !image.b64_json) throw malformedResponse();
      return image.b64_json;
    },

    async imageBatch(job, key, { count, images }) {
      const result = await requestImages(job, key, count, images);
      if (!Array.isArray(result.data) || result.data.length > count) throw malformedResponse();
      return Array.from({ length: count }, (_, index) => {
        const entry = result.data[index];
        if (entry?.error && typeof entry.error === "object") {
          const rejected = isImagePromptRejected(entry);
          return { status: "failed", error: rejected ? "PROMPT_REJECTED" : "PROVIDER_REJECTED" };
        }
        if (typeof entry?.b64_json === "string" && entry.b64_json) return { bytes: entry.b64_json };
        return { status: "unknown", error: "SUBMISSION_UNKNOWN" };
      });
    },

    async submitVideo(job, key, { first, last, references = [] } = {}) {
      const content = [{ type: "text", text: job.prompt }];
      if (first) content.push({ type: "image_url", image_url: { url: first }, role: "first_frame" });
      if (last) content.push({ type: "image_url", image_url: { url: last }, role: "last_frame" });
      for (const { kind, url } of references) {
        const type = kind + "_url";
        content.push({ type, [type]: { url }, role: "reference_" + kind });
      }
      const result = await request("/v2/video_generation", key, TASK_TIMEOUT_MS, {
        model: job.model ?? "MiniMax-H3-Lite",
        content,
        ratio: first || last ? "adaptive" : job.ratio,
        duration: job.duration,
        resolution: job.resolution ?? "480P",
        generate_audio: job.generateAudio ?? false,
        response_format: "task",
      });
      if (typeof result.task_id !== "string" || !TASK_ID.test(result.task_id)) {
        throw malformedResponse();
      }
      return result.task_id;
    },

    async queryVideo(taskId, key) {
      if (typeof taskId !== "string" || !TASK_ID.test(taskId)) {
        throw new MiniMaxError("VIDEO_TASK_UNAVAILABLE");
      }
      const result = await request(
        "/v2/query/video_generation/" + encodeURIComponent(taskId), key, TASK_TIMEOUT_MS,
      );
      const task = result.task;
      if (task?.id !== taskId) throw malformedResponse();
      switch (task.status) {
        case "queued":
        case "running":
        case "failed":
        case "cancelled":
          return { status: task.status };
        case "succeeded":
          return { status: task.status, videoUrl: parseVideoUrl(task.content?.url) };
        default:
          throw malformedResponse();
      }
    },
  };
}

module.exports = { createMiniMaxClient, MiniMaxError };
