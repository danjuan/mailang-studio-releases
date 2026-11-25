import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { classifyIpLiteral, isAcceptableResolvedAddress, isAcceptableUserEndpointAddress, isSafePublicHttpsUrl, isSafeUserEndpointUrl } from "@pi-desktop/shared";
import { noteInsecureUserEndpoint, relaxedNetworkPolicyEnabled } from "./endpoint-policy";
import { OPENREEL_SRT_MAX_BYTES } from "./openreel-srt";

export type CaptionPhase = "extracting" | "uploading" | "waiting";

function failure(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function policyFailure() {
  return failure("OPENREEL_CAPTION_NETWORK_POLICY", "The subtitle service address is blocked by the current network policy.");
}

function connectionFailure(error: unknown) {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return failure("OPENREEL_CAPTION_LOCAL_NETWORK_DENIED", "Check that the app is allowed to access the local network.");
  }
  return failure("OPENREEL_CAPTION_UNREACHABLE", "Could not connect to the subtitle service. Check the service address, local network, or VPN.");
}

export function parseOpenReelCaptionEndpoint(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw policyFailure();
  let url: URL;
  try { url = new URL(value); } catch { throw policyFailure(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || !["/", "/transcribe"].includes(url.pathname)) throw policyFailure();
  return url;
}

export function normalizeOpenReelCaptionEndpoint(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    throw failure("OPENREEL_CAPTION_NOT_CONFIGURED", "Configure and enable the subtitle service in OpenReel settings.");
  }
  const url = parseOpenReelCaptionEndpoint(value);
  if (!(relaxedNetworkPolicyEnabled() ? isSafeUserEndpointUrl(url.href, { allowInsecureHttp: true }) : isSafePublicHttpsUrl(url.href))) {
    throw policyFailure();
  }
  return url.origin;
}

function resolveAddresses(host: string, signal: AbortSignal): Promise<{ address: string; family: number }[]> {
  const family = isIP(host);
  if (family) return Promise.resolve([{ address: host, family }]);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void lookup(host, { all: true }).then(resolve, error => reject(connectionFailure(error)))
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function permitsDirectAddress({ address, family }: { address: string; family: number }) {
  const kind = classifyIpLiteral(address);
  return (family === 4 || family === 6) && (relaxedNetworkPolicyEnabled()
    ? isAcceptableUserEndpointAddress(address, kind, "direct")
    : isAcceptableResolvedAddress(kind, "direct"));
}

/** Resolve exactly one authorized direct destination. Do not resolve the name again when dialing. */
export async function resolveOpenReelCaptionDestination(endpoint: string, signal: AbortSignal) {
  const url = new URL(normalizeOpenReelCaptionEndpoint(endpoint));
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolveAddresses(hostname, signal);
  signal.throwIfAborted();
  normalizeOpenReelCaptionEndpoint(endpoint);
  const destination = addresses[0];
  if (!destination) throw connectionFailure(undefined);
  if (!addresses.every(permitsDirectAddress)) throw policyFailure();
  return { url, hostname, ...destination };
}

function assertSrtResponse(response: IncomingMessage) {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    throw failure("OPENREEL_CAPTION_REDIRECT", "The subtitle service attempted to redirect the audio upload.");
  }
  if (status === 400) throw failure("OPENREEL_CAPTION_HTTP_400", "The subtitle service rejected the upload format.");
  if (status === 422) throw failure("OPENREEL_CAPTION_HTTP_422", "The subtitle service could not process the selected audio or language.");
  if (status === 500) throw failure("OPENREEL_CAPTION_HTTP_500", "The subtitle service could not finish transcription.");
  if (status !== 200) throw failure("OPENREEL_CAPTION_HTTP_OTHER", "The subtitle service returned an unexpected status.");
  const type = response.headers["content-type"];
  const encoding = response.headers["content-encoding"];
  const length = response.headers["content-length"];
  if (!type || !/^application\/x-subrip(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type) ||
      (encoding !== undefined && encoding.toLowerCase() !== "identity") ||
      (length !== undefined && Number(length) > OPENREEL_SRT_MAX_BYTES)) {
    throw failure("OPENREEL_CAPTION_INVALID_SRT", "The subtitle service returned an invalid or oversized SRT response.");
  }
}

export async function uploadOpenReelCaptionFlac(
  endpoint: string, audio: Buffer, language: string | undefined, signal: AbortSignal, check: () => void,
  progress: (phase: CaptionPhase, fraction?: number) => void, beforeUpload?: () => Promise<void>,
): Promise<Buffer> {
  const target = await resolveOpenReelCaptionDestination(endpoint, signal);
  check();
  if (beforeUpload) await beforeUpload();
  check();
  normalizeOpenReelCaptionEndpoint(endpoint);
  if (!permitsDirectAddress(target)) throw policyFailure();
  const boundary = `openreel-${randomBytes(18).toString("hex")}`;
  const languagePart = language === undefined ? "" :
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`;
  const head = Buffer.from(`${languagePart}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip.flac"\r\nContent-Type: audio/flac\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const { url, hostname, address, family } = target;
  const secure = url.protocol === "https:";
  if (!secure) noteInsecureUserEndpoint(hostname);
  progress("uploading", 0);
  check();
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = secure ? httpsRequest : httpRequest;
    const req = request({
      protocol: url.protocol, hostname: address, family, port: url.port || undefined,
      path: "/transcribe", method: "POST", agent: false,
      ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
      headers: {
        Host: url.host,
        Accept: "application/x-subrip",
        "Accept-Encoding": "identity",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": head.length + audio.length + tail.length,
      },
      signal,
    }, resolve);
    req.once("error", error => reject(connectionFailure(error)));
    req.once("finish", () => {
      try {
        check();
        progress("waiting");
      } catch (error) {
        reject(error);
        req.destroy();
      }
    });
    req.write(head);
    req.write(audio);
    req.end(tail);
  });
  try {
    check();
    assertSrtResponse(response);
    let length = 0;
    const chunks: Buffer[] = [];
    const iterator = response[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next().catch(error => { throw connectionFailure(error); });
      check();
      if (next.done) break;
      const chunk: Buffer = next.value;
      length += chunk.length;
      if (length > OPENREEL_SRT_MAX_BYTES) {
        throw failure("OPENREEL_CAPTION_INVALID_SRT", "The subtitle service returned an oversized SRT response.");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } finally {
    response.destroy();
  }
}
