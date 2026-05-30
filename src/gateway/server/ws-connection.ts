import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import { getRuntimeConfig } from "../../config/io.js";
import { resolveCanvasHostUrl } from "../../infra/canvas-host-url.js";
import { removeRemoteNodeInfo } from "../../infra/skills-remote.js";
import { upsertPresence } from "../../infra/system-presence.js";
import { logRejectedLargePayload } from "../../logging/diagnostic-payload.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { truncateUtf16Safe } from "../../utils.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { resolvePreauthHandshakeTimeoutMs } from "../handshake-timeouts.js";
import { isLoopbackAddress } from "../net.js";
import { MAX_PAYLOAD_BYTES, MAX_PREAUTH_PAYLOAD_BYTES } from "../server-constants.js";
import { clearNodeWakeState } from "../server-methods/nodes-wake-state.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../server-methods/types.js";
import { formatError } from "../server-utils.js";
import { logWs } from "../ws-log.js";
import { getHealthVersion, incrementPresenceVersion } from "./health-state.js";
import type { PreauthConnectionBudget } from "./preauth-connection-budget.js";
import { broadcastPresenceSnapshot } from "./presence-events.js";
import type {
  GatewayWsMessageHandlerParams,
  WsOriginCheckMetrics,
} from "./ws-connection/message-handler.js";
import { resolveSharedGatewaySessionGeneration } from "./ws-shared-generation.js";
import type { GatewayWsClient } from "./ws-types.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const LOG_HEADER_MAX_LEN = 300;
const LOG_HEADER_FORMAT_REGEX = /\p{Cf}/gu;
const MAX_QUEUED_MESSAGE_HANDLER_FRAMES = 16;
const GATEWAY_WS_PING_INTERVAL_MS = 10_000;
const GATEWAY_WS_PING_SAMPLE_LIMIT = 12;

type GatewayWsPingOutcome = {
  ok: boolean;
  rttMs?: number;
};

type GatewayWsPingState = {
  nextId: number;
  pending: { id: number; sentAtMs: number } | null;
  sent: number;
  received: number;
  timedOut: number;
  latePongs: number;
  consecutiveTimeouts: number;
  outcomes: GatewayWsPingOutcome[];
  rtts: number[];
};

type GatewayWsLatencyPayload = {
  status: "measuring" | "ok" | "warn" | "timeout";
  intervalMs: number;
  timeoutMs: number;
  sent: number;
  received: number;
  timedOut: number;
  latePongs: number;
  consecutiveTimeouts: number;
  sampleCount: number;
  timeoutPercent: number;
  packetLossPercent: number;
  lastRttMs?: number;
  avgRttMs?: number;
  minRttMs?: number;
  maxRttMs?: number;
  jitterMs?: number;
};

function createGatewayWsPingState(): GatewayWsPingState {
  return {
    nextId: 1,
    pending: null,
    sent: 0,
    received: 0,
    timedOut: 0,
    latePongs: 0,
    consecutiveTimeouts: 0,
    outcomes: [],
    rtts: [],
  };
}

function roundMetric(value: number): number {
  return Math.max(0, Math.round(value));
}

function pushBounded<T>(items: T[], item: T, limit: number): void {
  items.push(item);
  if (items.length > limit) {
    items.splice(0, items.length - limit);
  }
}

function readPingId(data: RawData): number | null {
  const raw = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : String(data);
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function calcJitterMs(rtts: number[]): number | undefined {
  if (rtts.length < 2) {
    return undefined;
  }
  let totalDelta = 0;
  for (let index = 1; index < rtts.length; index += 1) {
    totalDelta += Math.abs(rtts[index] - rtts[index - 1]);
  }
  return roundMetric(totalDelta / (rtts.length - 1));
}

function buildGatewayWsLatencyPayload(state: GatewayWsPingState): GatewayWsLatencyPayload {
  const settledCount = state.outcomes.length;
  const timeoutCount = state.outcomes.filter((outcome) => !outcome.ok).length;
  const timeoutPercent = settledCount > 0 ? roundMetric((timeoutCount / settledCount) * 100) : 0;
  const avgRttMs =
    state.rtts.length > 0
      ? roundMetric(state.rtts.reduce((total, rtt) => total + rtt, 0) / state.rtts.length)
      : undefined;
  const jitterMs = calcJitterMs(state.rtts);
  const lastRttMs =
    state.rtts.length > 0 ? roundMetric(state.rtts[state.rtts.length - 1]) : undefined;
  const status =
    state.consecutiveTimeouts > 0
      ? "timeout"
      : avgRttMs === undefined
        ? "measuring"
        : avgRttMs >= 250 || (jitterMs ?? 0) >= 100 || timeoutPercent > 0
          ? "warn"
          : "ok";
  return {
    status,
    intervalMs: GATEWAY_WS_PING_INTERVAL_MS,
    timeoutMs: GATEWAY_WS_PING_INTERVAL_MS,
    sent: state.sent,
    received: state.received,
    timedOut: state.timedOut,
    latePongs: state.latePongs,
    consecutiveTimeouts: state.consecutiveTimeouts,
    sampleCount: settledCount,
    timeoutPercent,
    packetLossPercent: timeoutPercent,
    ...(lastRttMs !== undefined && { lastRttMs }),
    ...(avgRttMs !== undefined && { avgRttMs }),
    ...(state.rtts.length > 0 && { minRttMs: roundMetric(Math.min(...state.rtts)) }),
    ...(state.rtts.length > 0 && { maxRttMs: roundMetric(Math.max(...state.rtts)) }),
    ...(jitterMs !== undefined && { jitterMs }),
  };
}

function recordGatewayWsPingTimeout(state: GatewayWsPingState): void {
  state.pending = null;
  state.timedOut += 1;
  state.consecutiveTimeouts += 1;
  pushBounded(state.outcomes, { ok: false }, GATEWAY_WS_PING_SAMPLE_LIMIT);
}

function recordGatewayWsPong(state: GatewayWsPingState, data: RawData, nowMs: number): void {
  const id = readPingId(data);
  if (!state.pending || id !== state.pending.id) {
    state.latePongs += 1;
    return;
  }
  const rttMs = Math.max(0, nowMs - state.pending.sentAtMs);
  state.pending = null;
  state.received += 1;
  state.consecutiveTimeouts = 0;
  pushBounded(state.outcomes, { ok: true, rttMs }, GATEWAY_WS_PING_SAMPLE_LIMIT);
  pushBounded(state.rtts, rttMs, GATEWAY_WS_PING_SAMPLE_LIMIT);
}

function emitGatewayWsLatency(send: (obj: unknown) => void, state: GatewayWsPingState): void {
  send({
    type: "event",
    event: "gateway.latency",
    payload: buildGatewayWsLatencyPayload(state),
  });
}

function replaceControlChars(value: string): string {
  let cleaned = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      cleaned += " ";
      continue;
    }
    cleaned += char;
  }
  return cleaned;
}
const sanitizeLogValue = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const cleaned = replaceControlChars(value)
    .replace(LOG_HEADER_FORMAT_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return undefined;
  }
  if (cleaned.length <= LOG_HEADER_MAX_LEN) {
    return cleaned;
  }
  return truncateUtf16Safe(cleaned, LOG_HEADER_MAX_LEN);
};

function formatSocketEndpoint(
  address: string | undefined,
  port: number | undefined,
): string | undefined {
  if (!address) {
    return undefined;
  }
  if (port === undefined) {
    return address;
  }
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

function resolveSocketAddress(socket: WebSocket): {
  remoteAddr?: string;
  remotePort?: number;
  localAddr?: string;
  localPort?: number;
  endpoint?: string;
} {
  const rawSocket = (socket as WebSocket & { _socket?: Socket })._socket;
  const remoteAddr = rawSocket?.remoteAddress;
  const remotePort = rawSocket?.remotePort;
  const localAddr = rawSocket?.localAddress;
  const localPort = rawSocket?.localPort;
  const remoteEndpoint = formatSocketEndpoint(remoteAddr, remotePort);
  const localEndpoint = formatSocketEndpoint(localAddr, localPort);
  return {
    remoteAddr,
    remotePort,
    localAddr,
    localPort,
    endpoint:
      remoteEndpoint && localEndpoint
        ? `${remoteEndpoint}->${localEndpoint}`
        : (remoteEndpoint ?? localEndpoint),
  };
}

function isWsPayloadLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /max payload size exceeded/i.test(message);
}

export type GatewayWsSharedHandlerParams = {
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  preauthConnectionBudget: PreauthConnectionBudget;
  port: number;
  gatewayHost?: string;
  canvasHostEnabled: boolean;
  canvasHostScheme?: "http" | "https";
  canvasHostServerPort?: number;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Browser-origin fallback limiter (loopback is never exempt). */
  browserRateLimiter?: AuthRateLimiter;
  preauthHandshakeTimeoutMs?: number;
  isStartupPending?: () => boolean;
  gatewayMethods: string[];
  events: string[];
  refreshHealthSnapshot: GatewayRequestContext["refreshHealthSnapshot"];
};

export type AttachGatewayWsConnectionHandlerParams = GatewayWsSharedHandlerParams & {
  logGateway: SubsystemLogger;
  logHealth: SubsystemLogger;
  logWsControl: SubsystemLogger;
  extraHandlers: GatewayRequestHandlers;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  buildRequestContext: () => GatewayRequestContext;
};

function attachGatewayWsMessageHandlerOnDemand(params: GatewayWsMessageHandlerParams): void {
  const queued: RawData[] = [];
  const queueMessage = (data: RawData) => {
    if (queued.length >= MAX_QUEUED_MESSAGE_HANDLER_FRAMES) {
      params.setCloseCause("message-handler-loading-overflow", {
        queuedFrames: queued.length,
      });
      params.close(1008, "gateway message handler loading");
      return;
    }
    queued.push(data);
  };
  params.socket.on("message", queueMessage);
  void import("./ws-connection/message-handler.js")
    .then(({ attachGatewayWsMessageHandler }) => {
      params.socket.off("message", queueMessage);
      if (params.isClosed()) {
        return;
      }
      attachGatewayWsMessageHandler(params);
      for (const data of queued) {
        params.socket.emit("message", data);
      }
    })
    .catch((error: unknown) => {
      params.socket.off("message", queueMessage);
      params.setCloseCause("message-handler-load-failed", {
        error: formatError(error),
      });
      params.logWsControl.warn(
        `failed to load ws message handler conn=${params.connId}: ${formatError(error)}`,
      );
      params.close(1011, "gateway message handler unavailable");
    });
}

export function attachGatewayWsConnectionHandler(params: AttachGatewayWsConnectionHandlerParams) {
  const {
    wss,
    clients,
    preauthConnectionBudget,
    port,
    gatewayHost,
    canvasHostEnabled,
    canvasHostScheme,
    canvasHostServerPort,
    resolvedAuth,
    getResolvedAuth = () => resolvedAuth,
    getRequiredSharedGatewaySessionGeneration = () =>
      resolveSharedGatewaySessionGeneration(
        getResolvedAuth(),
        getRuntimeConfig().gateway?.trustedProxies,
      ),
    rateLimiter,
    browserRateLimiter,
    isStartupPending,
    gatewayMethods,
    events,
    refreshHealthSnapshot,
    logGateway,
    logHealth,
    logWsControl,
    extraHandlers,
    broadcast,
    buildRequestContext,
  } = params;
  const originCheckMetrics: WsOriginCheckMetrics = { hostHeaderFallbackAccepted: 0 };

  wss.on("connection", (socket, upgradeReq) => {
    let client: GatewayWsClient | null = null;
    let closed = false;
    const openedAt = Date.now();
    const connId = randomUUID();
    const { remoteAddr, remotePort, localAddr, localPort, endpoint } = resolveSocketAddress(socket);
    const preauthBudgetKey = (
      socket as WebSocket & {
        __openclawPreauthBudgetClaimed?: boolean;
        __openclawPreauthBudgetKey?: string;
      }
    ).__openclawPreauthBudgetKey;
    (
      socket as WebSocket & {
        __openclawPreauthBudgetClaimed?: boolean;
      }
    ).__openclawPreauthBudgetClaimed = true;
    const headerValue = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value;
    const requestHost = headerValue(upgradeReq.headers.host);
    const requestOrigin = headerValue(upgradeReq.headers.origin);
    const requestUserAgent = headerValue(upgradeReq.headers["user-agent"]);
    const forwardedFor = headerValue(upgradeReq.headers["x-forwarded-for"]);
    const realIp = headerValue(upgradeReq.headers["x-real-ip"]);

    const canvasHostPortForWs = canvasHostServerPort ?? (canvasHostEnabled ? port : undefined);
    const canvasHostOverride =
      gatewayHost && gatewayHost !== "0.0.0.0" && gatewayHost !== "::" ? gatewayHost : undefined;
    const canvasHostUrl = resolveCanvasHostUrl({
      canvasPort: canvasHostPortForWs,
      hostOverride: canvasHostServerPort ? canvasHostOverride : undefined,
      requestHost: upgradeReq.headers.host,
      forwardedProto: upgradeReq.headers["x-forwarded-proto"],
      localAddress: upgradeReq.socket?.localAddress,
      scheme: canvasHostScheme,
    });

    logWs("in", "open", { connId, remoteAddr, remotePort, localAddr, localPort, endpoint });
    let handshakeState: "pending" | "connected" | "failed" = "pending";
    let holdsPreauthBudget = true;
    let closeCause: string | undefined;
    let closeMeta: Record<string, unknown> = {};
    let lastFrameType: string | undefined;
    let lastFrameMethod: string | undefined;
    let lastFrameId: string | undefined;

    const setCloseCause = (cause: string, meta?: Record<string, unknown>) => {
      if (!closeCause) {
        closeCause = cause;
      }
      if (meta && Object.keys(meta).length > 0) {
        closeMeta = { ...closeMeta, ...meta };
      }
    };

    const releasePreauthBudget = () => {
      if (!holdsPreauthBudget) {
        return;
      }
      holdsPreauthBudget = false;
      preauthConnectionBudget.release(preauthBudgetKey);
    };

    const setLastFrameMeta = (meta: { type?: string; method?: string; id?: string }) => {
      if (meta.type || meta.method || meta.id) {
        lastFrameType = meta.type ?? lastFrameType;
        lastFrameMethod = meta.method ?? lastFrameMethod;
        lastFrameId = meta.id ?? lastFrameId;
      }
    };

    const send = (obj: unknown) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    const connectNonce = randomUUID();
    send({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: connectNonce, ts: Date.now() },
    });

    let pingTimer: ReturnType<typeof setInterval> | undefined;
    const pingState = createGatewayWsPingState();

    socket.on("pong", (data: RawData) => {
      recordGatewayWsPong(pingState, data, performance.now());
      emitGatewayWsLatency(send, pingState);
    });

    const sendProtocolPing = () => {
      if (pingState.pending) {
        recordGatewayWsPingTimeout(pingState);
        emitGatewayWsLatency(send, pingState);
      }
      const id = pingState.nextId;
      pingState.nextId += 1;
      try {
        socket.ping(Buffer.from(String(id)));
        pingState.pending = { id, sentAtMs: performance.now() };
        pingState.sent += 1;
      } catch {
        // close() clears the timer; ping can race with a socket already entering CLOSING
      }
    };

    const close = (code = 1000, reason?: string) => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(handshakeTimer);
      if (pingTimer !== undefined) {
        clearInterval(pingTimer);
      }
      releasePreauthBudget();
      if (client) {
        clients.delete(client);
      }
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
    };

    socket.once("error", (err) => {
      if (isWsPayloadLimitError(err)) {
        logRejectedLargePayload({
          surface: client ? "gateway.ws.frame" : "gateway.ws.preauth",
          limitBytes: client ? MAX_PAYLOAD_BYTES : MAX_PREAUTH_PAYLOAD_BYTES,
          reason: client ? "ws_frame_limit" : "preauth_frame_limit",
        });
      }
      logWsControl.warn(`error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`);
      close();
    });

    const isNoisySwiftPmHelperClose = (userAgent: string | undefined, remote: string | undefined) =>
      normalizeLowercaseStringOrEmpty(userAgent).includes("swiftpm-testing-helper") &&
      isLoopbackAddress(remote);

    socket.once("close", (code, reason) => {
      const durationMs = Date.now() - openedAt;
      const logForwardedFor = sanitizeLogValue(forwardedFor);
      const logOrigin = sanitizeLogValue(requestOrigin);
      const logHost = sanitizeLogValue(requestHost);
      const logUserAgent = sanitizeLogValue(requestUserAgent);
      const logReason = sanitizeLogValue(reason?.toString());
      const closeContext = {
        cause: closeCause,
        handshake: handshakeState,
        durationMs,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
        host: logHost,
        origin: logOrigin,
        userAgent: logUserAgent,
        forwardedFor: logForwardedFor,
        remoteAddr,
        remotePort,
        localAddr,
        localPort,
        endpoint,
        ...closeMeta,
      };
      if (!client) {
        const logFn = isNoisySwiftPmHelperClose(requestUserAgent, remoteAddr)
          ? logWsControl.debug
          : logWsControl.warn;
        logFn(
          `closed before connect conn=${connId} peer=${endpoint ?? "n/a"} remote=${remoteAddr ?? "?"} fwd=${logForwardedFor || "n/a"} origin=${logOrigin || "n/a"} host=${logHost || "n/a"} ua=${logUserAgent || "n/a"} code=${code ?? "n/a"} reason=${logReason || "n/a"}`,
          closeContext,
        );
      }
      if (client && isWebchatClient(client.connect.client)) {
        logWsControl.info(
          `webchat disconnected code=${code} reason=${logReason || "n/a"} conn=${connId}`,
        );
      }
      if (client?.presenceKey) {
        upsertPresence(client.presenceKey, { reason: "disconnect" });
        broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
      }
      const context = buildRequestContext();
      context.unsubscribeAllSessionEvents(connId);
      if (client?.connect?.role === "node") {
        const nodeId = context.nodeRegistry.unregister(connId);
        if (nodeId) {
          removeRemoteNodeInfo(nodeId);
          context.nodeUnsubscribeAll(nodeId);
          clearNodeWakeState(nodeId);
        }
      }
      logWs("out", "close", {
        connId,
        code,
        reason: logReason,
        durationMs,
        cause: closeCause,
        handshake: handshakeState,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
        endpoint,
      });
      close();
    });

    const handshakeTimeoutMs = resolvePreauthHandshakeTimeoutMs({
      configuredTimeoutMs: params.preauthHandshakeTimeoutMs,
    });
    const handshakeTimer = setTimeout(() => {
      if (!client) {
        handshakeState = "failed";
        setCloseCause("handshake-timeout", {
          handshakeMs: Date.now() - openedAt,
          endpoint,
        });
        logWsControl.warn(
          `handshake timeout conn=${connId} peer=${endpoint ?? "n/a"} remote=${remoteAddr ?? "?"}`,
        );
        close();
      }
    }, handshakeTimeoutMs);

    attachGatewayWsMessageHandlerOnDemand({
      socket,
      upgradeReq,
      connId,
      remoteAddr,
      remotePort,
      localAddr,
      localPort,
      endpoint,
      forwardedFor,
      realIp,
      requestHost,
      requestOrigin,
      requestUserAgent,
      canvasHostUrl,
      connectNonce,
      getResolvedAuth,
      getRequiredSharedGatewaySessionGeneration,
      rateLimiter,
      browserRateLimiter,
      isStartupPending,
      gatewayMethods,
      events,
      extraHandlers,
      buildRequestContext,
      refreshHealthSnapshot,
      send,
      close,
      isClosed: () => closed,
      clearHandshakeTimer: () => clearTimeout(handshakeTimer),
      getClient: () => client,
      setClient: (next) => {
        if (closed) {
          return false;
        }
        releasePreauthBudget();
        client = next;
        clients.add(next);
        pingTimer = setInterval(sendProtocolPing, GATEWAY_WS_PING_INTERVAL_MS);
        return true;
      },
      setHandshakeState: (next) => {
        handshakeState = next;
      },
      setCloseCause,
      setLastFrameMeta,
      originCheckMetrics,
      logGateway,
      logHealth,
      logWsControl,
    });
  });
}
