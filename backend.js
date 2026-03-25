const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const SESSION_COOKIE_NAME = "trafik_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const ARRIVING_WINDOW_MS = 30000;
const sessions = new Map();

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((cookies, chunk) => {
    const [rawKey, ...rawValue] = chunk.trim().split("=");
    if (!rawKey) return cookies;
    cookies[rawKey] = decodeURIComponent(rawValue.join("="));
    return cookies;
  }, {});
}

function buildSessionCookie(sessionId) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function createSessionData(sessionId) {
  return {
    sessionId,
    routes: [],
    sockets: new Set(),
    updatedAt: Date.now(),
  };
}

function getSessionData(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createSessionData(sessionId));
  }

  const session = sessions.get(sessionId);
  session.updatedAt = Date.now();
  return session;
}

function resolveSessionId(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let sessionId = cookies[SESSION_COOKIE_NAME];

  if (!sessionId) {
    sessionId = crypto.randomUUID();
    if (res) {
      res.setHeader("Set-Cookie", buildSessionCookie(sessionId));
    }
  }

  req.sessionId = sessionId;
  req.session = getSessionData(sessionId);
  return sessionId;
}

app.use((req, res, next) => {
  resolveSessionId(req, res);
  next();
});

// ==========================================
// 0. SERVE FRONTEND UI
// ==========================================
// Serve static files (CSS, JS, images) from the root folder
app.use(express.static(process.cwd()));

// Serve the frontend UI when someone visits the main URL
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

// Create the master HTTP server and bind WebSockets to it
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Default to 3000 to perfectly match Coolify's default Nixpacks behavior
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. FULL MTR NETWORK (10 Lines + Branches)
// ==========================================
const lineSequences = {
  TWL: [
    "CEN", "ADM", "TST", "JOR", "YMT", "MOK", "PRE", "SSP", 
    "CSW", "LCK", "MEI", "LAK", "KWF", "KWH", "TWH", "TSW",
  ],
  ISL: [
    "KET", "HKU", "SYP", "SHW", "CEN", "ADM", "WAC", "CAB", 
    "TIN", "FOH", "NOP", "QUO", "TAK", "SWH", "SKW", "CHW",
  ],
  KTL: [
    "WHA", "HOM", "YMT", "MOK", "PRE", "SKM", "KOT", "LOF", 
    "WTS", "DIH", "CHH", "KOB", "NTK", "KWT", "LAT", "YAT", "TIK",
  ],
  SIL: ["ADM", "OCP", "WCH", "LET", "SOH"],
  TML: [
    "WKS", "MOS", "HEO", "TSH", "SHM", "CIO", "STW", "CKT", 
    "HIK", "TAW", "DIH", "KAK", "SUW", "TKW", "HOM", "HUH", 
    "ETS", "AUS", "NAC", "MEI", "TWC", "TWW", "KSR", "YUL", 
    "LOP", "TIS", "TUM",
  ],
  TCL: ["HOK", "KOW", "OLY", "NAC", "LAK", "TSY", "SUN", "TUC"],
  AEL: ["HOK", "KOW", "TSY", "AIR", "AWE"],
  DRL: ["SUN", "DIS"],
  EAL: [
    "ADM", "EXH", "HUH", "MKK", "KOT", "TAW", "SHT", "FOT", 
    "UNI", "TAP", "TWO", "FAN", "SHS", "LOW",
  ],
  EAL_LMC: [
    "ADM", "EXH", "HUH", "MKK", "KOT", "TAW", "SHT", "FOT", 
    "UNI", "TAP", "TWO", "FAN", "SHS", "LMC",
  ],
  EAL_RAC: [
    "ADM", "EXH", "HUH", "MKK", "KOT", "TAW", "SHT", "RAC", 
    "UNI", "TAP", "TWO", "FAN", "SHS", "LOW",
  ],
  TKL: ["NOP", "QUO", "YAT", "TIK", "TKO", "HAH", "POA"],
  TKL_LHP: ["NOP", "QUO", "YAT", "TIK", "TKO", "LHP"],
};

const apiLineCodes = { EAL_LMC: "EAL", EAL_RAC: "EAL", TKL_LHP: "TKL" };
const apiStationCodes = { MEI: "MEF" };
const lineTraversalBias = { EAL_LMC: 0.1, EAL_RAC: 0.25, TKL_LHP: 0.1 };
const lineVariantsByOfficialLine = Object.keys(lineSequences).reduce(
  (groups, line) => {
    const officialLine = apiLineCodes[line] || line;
    if (!groups[officialLine]) groups[officialLine] = [];
    groups[officialLine].push(line);
    return groups;
  },
  {},
);

// ==========================================
// 2. GRAPH BUILDER & ROUTING LOGIC
// ==========================================
const graph = {};
const lineTravelMinutes = {
  TWL: 2.6,
  ISL: 2.5,
  KTL: 2.6,
  SIL: 3.1,
  TML: 2.9,
  TCL: 3.2,
  AEL: 4,
  DRL: 3.2,
  EAL: 3,
  EAL_LMC: 3,
  EAL_RAC: 3,
  TKL: 2.8,
  TKL_LHP: 3,
};

function getEdgeTravelMinutes(line) {
  return lineTravelMinutes[line] || 2.8;
}

function addEdge(a, b, line) {
  const weight = getEdgeTravelMinutes(line);
  if (!graph[a]) graph[a] = [];
  if (!graph[b]) graph[b] = [];
  graph[a].push({ node: b, weight, line });
  graph[b].push({ node: a, weight, line });
}

Object.entries(lineSequences).forEach(([line, stations]) => {
  for (let i = 0; i < stations.length - 1; i++) {
    addEdge(stations[i], stations[i + 1], line);
  }
});

function getDirection(line, from, to) {
  const seq = lineSequences[line];
  if (!seq) return "UP";
  return seq.indexOf(to) > seq.indexOf(from) ? "UP" : "DOWN";
}

function getOfficialLine(line) {
  return apiLineCodes[line] || line;
}

function getApiStationCode(station) {
  return apiStationCodes[station] || station;
}

function getScheduleRequestInfo(line, station) {
  const officialLine = getOfficialLine(line);
  const apiStation = getApiStationCode(station);

  return {
    officialLine,
    apiStation,
    cacheKey: `${officialLine}-${apiStation}`,
    stationKey: `${officialLine}-${apiStation}`,
    url: `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${officialLine}&sta=${apiStation}`,
  };
}

function buildStateKey(node, line) {
  return `${node}|${line || "START"}`;
}

function parseStateKey(key) {
  const [node, rawLine] = key.split("|");
  return { node, line: rawLine === "START" ? null : rawLine };
}

function findShortestPath(start, end) {
  const startKey = buildStateKey(start, null);
  const distances = new Map([[startKey, 0]]);
  const previous = new Map();
  const queue = new Set([startKey]);
  let bestEndKey = null;

  while (queue.size > 0) {
    let currentKey = null;
    let minDistance = Infinity;

    for (const key of queue) {
      const distance = distances.get(key) ?? Infinity;
      if (distance < minDistance) {
        minDistance = distance;
        currentKey = key;
      }
    }

    if (!currentKey) break;
    queue.delete(currentKey);

    const { node: currentNode, line: currentLine } = parseStateKey(currentKey);
    if (currentNode === end) {
      bestEndKey = currentKey;
      break;
    }

    for (const neighbor of graph[currentNode] || []) {
      const nextKey = buildStateKey(neighbor.node, neighbor.line);
      const transferPenalty =
        currentLine && getOfficialLine(currentLine) !== getOfficialLine(neighbor.line)
          ? 5
          : 0;
      const alt =
        minDistance +
        neighbor.weight +
        transferPenalty +
        (lineTraversalBias[neighbor.line] || 0);

      if (alt < (distances.get(nextKey) ?? Infinity)) {
        distances.set(nextKey, alt);
        previous.set(nextKey, {
          key: currentKey,
          edge: {
            from: currentNode,
            to: neighbor.node,
            line: neighbor.line,
            weight: neighbor.weight,
          },
        });
        queue.add(nextKey);
      }
    }
  }

  if (!bestEndKey) return [];

  const path = [];
  let currentKey = bestEndKey;
  while (previous.has(currentKey)) {
    const { key, edge } = previous.get(currentKey);
    path.unshift(edge);
    currentKey = key;
  }
  return path;
}

function generateItinerary(start, end) {
  const path = findShortestPath(start, end);
  if (path.length === 0) return [];

  const legs = [];
  let segmentStart = 0;

  while (segmentStart < path.length) {
    const currentOfficialLine = getOfficialLine(path[segmentStart].line);
    let segmentEnd = segmentStart;
    let commuteTime = 0;
    let stopCount = 0;

    while (
      segmentEnd < path.length &&
      getOfficialLine(path[segmentEnd].line) === currentOfficialLine
    ) {
      commuteTime += path[segmentEnd].weight;
      stopCount++;
      segmentEnd++;
    }

    const firstEdge = path[segmentStart];
    const lastEdge = path[segmentEnd - 1];
    const rideLine = lastEdge.line;

    legs.push({
      type: "WAITING",
      line: rideLine,
      station: firstEdge.from,
      direction: getDirection(rideLine, firstEdge.from, firstEdge.to),
      destinationStation: lastEdge.to,
      targetTime: null,
    });
    legs.push({
      type: "COMMUTING",
      line: rideLine,
      start: firstEdge.from,
      end: lastEdge.to,
      duration: Math.max(3, Math.ceil(commuteTime + Math.max(1, stopCount * 0.5))),
    });

    if (segmentEnd < path.length) {
      legs.push({
        type: "TRANSFERRING",
        station: lastEdge.to,
        toLine: path[segmentEnd].line,
        duration: 5,
      });
    }

    segmentStart = segmentEnd;
  }

  return legs;
}

// ==========================================
// 3. EXACT API TIMESTAMPS & POLLING CACHE
// ==========================================
const apiCache = new Map();

function logEta(level, message, context = {}) {
  const details = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

  console[level](`[MTR ETA] ${message}${details ? ` ${details}` : ""}`);
}

function trainServesDestination(
  routeLine,
  station,
  direction,
  destinationStation,
  trainDestination,
) {
  if (!destinationStation || !trainDestination) return true;

  const officialLine = apiLineCodes[routeLine] || routeLine;
  const candidateLines = lineVariantsByOfficialLine[officialLine] || [routeLine];

  return candidateLines.some((line) => {
    const sequence = lineSequences[line];
    if (!sequence) return false;

    const stationIndex = sequence.indexOf(station);
    const targetIndex = sequence.indexOf(destinationStation);
    const trainDestinationIndex = sequence.indexOf(trainDestination);

    if (
      stationIndex === -1 ||
      targetIndex === -1 ||
      trainDestinationIndex === -1
    ) {
      return false;
    }

    if (direction === "UP") {
      return stationIndex < targetIndex && targetIndex <= trainDestinationIndex;
    }

    return stationIndex > targetIndex && targetIndex >= trainDestinationIndex;
  });
}

async function fetchStationScheduleDetails(line, station, options = {}) {
  const { bypassCache = false } = options;
  const { officialLine, apiStation, cacheKey, stationKey, url } =
    getScheduleRequestInfo(line, station);

  if (!bypassCache && apiCache.has(cacheKey) && apiCache.get(cacheKey).expires > Date.now()) {
    const cached = apiCache.get(cacheKey);
    return {
      trainData: cached.trainData,
      metadata: {
        cached: true,
        httpStatus: 200,
        apiStatus: cached.apiStatus,
        resultCode: cached.resultCode,
        message: cached.message,
        isDelay: cached.isDelay,
        rawData: cached.rawData,
        officialLine,
        apiStation,
        stationKey,
        url,
      },
    };
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      logEta("error", "HTTP error from MTR schedule API", {
        httpStatus: res.status,
        line,
        officialLine,
        station,
        apiStation,
        url,
      });
      return {
        trainData: null,
        metadata: {
          cached: false,
          httpStatus: res.status,
          apiStatus: null,
          resultCode: null,
          message: `HTTP ${res.status}`,
          officialLine,
          apiStation,
          stationKey,
          url,
        },
      };
    }

    const data = await res.json();
    if (data?.status !== 1) {
      logEta("warn", "MTR schedule API returned no usable data", {
        httpStatus: res.status,
        apiStatus: data?.status,
        resultCode: data?.resultCode,
        message: data?.message,
        line,
        officialLine,
        station,
        apiStation,
        url,
      });
    }

    const trainData = data?.data?.[stationKey] || null;
    if (!trainData) {
      logEta("warn", "MTR schedule payload missing station entry", {
        httpStatus: res.status,
        apiStatus: data?.status,
        resultCode: data?.resultCode,
        message: data?.message,
        line,
        officialLine,
        station,
        apiStation,
        stationKey,
      });
    }
    apiCache.set(cacheKey, {
      rawData: data,
      trainData,
      apiStatus: data?.status ?? null,
      resultCode: data?.resultCode ?? null,
      message: data?.message ?? null,
      isDelay: data?.isdelay ?? null,
      expires: Date.now() + 8000,
    });
    return {
      trainData,
      metadata: {
        cached: false,
        httpStatus: res.status,
        apiStatus: data?.status ?? null,
        resultCode: data?.resultCode ?? null,
        message: data?.message ?? null,
        isDelay: data?.isdelay ?? null,
        rawData: data,
        officialLine,
        apiStation,
        stationKey,
        url,
      },
    };
  } catch (e) {
    logEta("error", "Failed to fetch MTR schedule API", {
      line,
      officialLine,
      station,
      apiStation,
      url,
      error: e.message,
    });
    return {
      trainData: null,
      metadata: {
        cached: false,
        httpStatus: null,
        apiStatus: null,
        resultCode: null,
        message: e.message,
        officialLine,
        apiStation,
        stationKey,
        url,
      },
    };
  }
}

function getApiAvailability(metadata, trainData, direction) {
  if (metadata.httpStatus && metadata.httpStatus >= 400) {
    return {
      status: "UNAVAILABLE",
      reason: metadata.message || `HTTP ${metadata.httpStatus}`,
      source: "http_error",
    };
  }

  if (metadata.apiStatus !== null && metadata.apiStatus !== 1) {
    return {
      status: "UNAVAILABLE",
      reason: metadata.message || metadata.resultCode || "API unavailable",
      source: "api_error",
    };
  }

  if (!trainData) {
    return {
      status: "UNAVAILABLE",
      reason: metadata.message || "No live data returned",
      source: "missing_station_data",
    };
  }

  if (!Array.isArray(trainData[direction]) || trainData[direction].length === 0) {
    const hasAnyDirectionalData = Object.values(trainData).some(
      (value) => Array.isArray(value) && value.length > 0,
    );

    return {
      status: hasAnyDirectionalData ? "UNAVAILABLE" : "SERVICE_ENDED",
      reason: metadata.message || (hasAnyDirectionalData ? "No trains available" : "Service ended"),
      source: hasAnyDirectionalData ? "direction_empty" : "service_ended",
    };
  }

  return {
    status: "LIVE",
    reason: null,
    source: "live",
  };
}

async function fetchExactETA(line, station, direction, destinationStation) {
  const { trainData, metadata } = await fetchStationScheduleDetails(line, station);
  const availability = getApiAvailability(metadata, trainData, direction);

  if (availability.status !== "LIVE") {
    logEta("warn", "No schedule returned for ETA lookup", {
      line,
      station,
      direction,
      destinationStation,
      availability: availability.status,
      reason: availability.reason,
    });
    return {
      targetTime: null,
      availability,
      isDelayed: metadata.isDelay === "Y",
      raw: null,
    };
  }

  if (trainData && Array.isArray(trainData[direction])) {
    const matchingTrain = trainData[direction].find((train) =>
      trainServesDestination(
        line,
        station,
        direction,
        destinationStation,
        train.dest,
      ),
    );

    const selectedTrain = destinationStation
      ? matchingTrain
      : matchingTrain || trainData[direction][0];

    if (!selectedTrain) {
      logEta("warn", "No matching train found for requested destination", {
        line,
        station,
        direction,
        destinationStation,
        candidateDestinations: trainData[direction]
          .map((train) => train.dest)
          .filter(Boolean)
          .join(","),
      });
      return {
        targetTime: null,
        availability: {
          status: "UNAVAILABLE",
          reason: metadata.message || "No train serves this destination right now",
          source: "destination_filtered",
        },
        isDelayed: metadata.isDelay === "Y",
        raw: null,
      };
    }

    if (!matchingTrain && destinationStation) {
      logEta("warn", "Filtered out all trains for branch destination", {
        line,
        station,
        direction,
        destinationStation,
        candidateDestinations: trainData[direction]
          .map((train) => train.dest)
          .filter(Boolean)
          .join(","),
      });
    }

    if (selectedTrain?.time) {
      const timeStr = selectedTrain.time.replace(" ", "T") + "+08:00";
      return {
        targetTime: new Date(timeStr).getTime(),
        availability,
        isDelayed: metadata.isDelay === "Y",
        raw: selectedTrain,
      };
    }

    logEta("warn", "Selected train missing ETA time", {
      line,
      station,
      direction,
      destinationStation,
      selectedDestination: selectedTrain?.dest,
    });
  }

  return {
    targetTime: null,
    availability: {
      status: "UNAVAILABLE",
      reason: metadata.message || "Selected train is missing time data",
      source: "missing_time",
    },
    isDelayed: metadata.isDelay === "Y",
    raw: null,
  };
}

function applyLiveEtaToLeg(leg, etaResult) {
  const now = Date.now();
  const previousTarget = leg.targetTime || null;
  const liveEpoch = etaResult?.targetTime || null;
  const availability = etaResult?.availability || {
    status: "UNAVAILABLE",
    reason: "Live data unavailable",
    source: "unknown",
  };

  leg.lastApiUpdatedAt = now;
  leg.apiStatus = availability.status;
  leg.apiReason = availability.reason;
  leg.apiSource = availability.source;
  leg.isDelayed = etaResult?.isDelayed === true;

  if (!liveEpoch) {
    if (previousTarget && previousTarget - now <= ARRIVING_WINDOW_MS) {
      leg.arrivalState = "ARRIVING";
      return true;
    }

    leg.targetTime = null;
    leg.arrivalState = availability.status;
    return previousTarget !== null;
  }

  const isNearArrival = previousTarget && previousTarget - now <= ARRIVING_WINDOW_MS;
  const jumpedToLaterTrain = previousTarget && liveEpoch - previousTarget > ARRIVING_WINDOW_MS;

  if (isNearArrival && jumpedToLaterTrain) {
    leg.arrivalState = "ARRIVING";
    return previousTarget - now > 0;
  }

  leg.targetTime = liveEpoch;
  leg.arrivalState = liveEpoch - now <= ARRIVING_WINDOW_MS ? "ARRIVING" : "COUNTDOWN";
  return previousTarget !== leg.targetTime;
}

function serializeRoutes(sessionId) {
  return getSessionData(sessionId).routes;
}

function broadcastToSession(sessionId, type, data) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.sockets.forEach((socket) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type, data }));
    }
  });
}

setInterval(async () => {
  for (const [sessionId, session] of sessions.entries()) {
    let hasUpdates = false;

    for (const route of session.routes) {
      if (route.status !== "ACTIVE") continue;
      const leg = route.legs[route.currentLegIndex];

      if (leg && leg.type === "WAITING") {
        const etaResult = await fetchExactETA(
          leg.line,
          leg.station,
          leg.direction,
          leg.destinationStation,
        );
        if (applyLiveEtaToLeg(leg, etaResult)) {
          hasUpdates = true;
        }
      }
    }

    if (hasUpdates) {
      broadcastToSession(sessionId, "routes_updated", serializeRoutes(sessionId));
    }

    if (
      session.sockets.size === 0 &&
      session.routes.length === 0 &&
      Date.now() - session.updatedAt > SESSION_TTL_MS
    ) {
      sessions.delete(sessionId);
    }
  }
}, 10000);

// ==========================================
// 4. API & WEBSOCKET ROUTES
// ==========================================
wss.on("connection", (socket, req) => {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE_NAME] || crypto.randomUUID();
  const session = getSessionData(sessionId);
  session.sockets.add(socket);

  socket.on("close", () => {
    session.sockets.delete(socket);
    session.updatedAt = Date.now();
  });
});

app.post("/api/routes", async (req, res) => {
  const { name, startCode, endCode } = req.body;
  if (!graph[startCode] || !graph[endCode])
    return res.status(400).json({ error: "Station not in core map." });

  const legs = generateItinerary(startCode, endCode);

  if (legs[0] && legs[0].type === "WAITING") {
    const etaResult = await fetchExactETA(
      legs[0].line,
      legs[0].station,
      legs[0].direction,
      legs[0].destinationStation,
    );
    if (!etaResult?.targetTime) {
      logEta("warn", "Initial route created without live ETA", {
        routeName: name,
        line: legs[0].line,
        station: legs[0].station,
        direction: legs[0].direction,
        destinationStation: legs[0].destinationStation,
      });
    }
    applyLiveEtaToLeg(legs[0], etaResult);
  }

  const newRoute = {
    id: `R-${crypto.randomUUID()}`,
    name,
    legs,
    currentLegIndex: 0,
    status: "ACTIVE",
  };
  req.session.routes.push(newRoute);
  broadcastToSession(req.sessionId, "new_route", newRoute);
  res.status(201).json(newRoute);
});

app.post("/api/routes/:id/advance", async (req, res) => {
  const route = req.session.routes.find((r) => r.id === req.params.id);
  if (!route) return res.status(404).json({ error: "Not found" });

  route.currentLegIndex++;
  if (route.currentLegIndex >= route.legs.length) {
    route.status = "COMPLETED";
  } else {
    const nextLeg = route.legs[route.currentLegIndex];
    const previousLeg = route.legs[route.currentLegIndex - 1];

    if (nextLeg.type === "COMMUTING" && previousLeg?.type === "WAITING") {
      nextLeg.isDelayed = previousLeg.isDelayed === true;
    }

    if (nextLeg.type === "WAITING") {
      const etaResult = await fetchExactETA(
        nextLeg.line,
        nextLeg.station,
        nextLeg.direction,
        nextLeg.destinationStation,
      );
      if (!etaResult?.targetTime) {
        logEta("warn", "Advance route has no live ETA", {
          routeId: route.id,
          line: nextLeg.line,
          station: nextLeg.station,
          direction: nextLeg.direction,
          destinationStation: nextLeg.destinationStation,
        });
      }
      applyLiveEtaToLeg(nextLeg, etaResult);
    } else {
      nextLeg.targetTime = Date.now() + nextLeg.duration * 60000;
    }
  }
  req.session.updatedAt = Date.now();
  broadcastToSession(req.sessionId, "routes_updated", req.session.routes);
  res.json(route);
});

app.delete("/api/routes/:id", (req, res) => {
  req.session.routes = req.session.routes.filter((r) => r.id !== req.params.id);
  req.session.updatedAt = Date.now();
  broadcastToSession(req.sessionId, "route_deleted", req.params.id);
  res.sendStatus(204);
});

app.get("/api/routes", (req, res) => res.json(req.session.routes));

app.get("/api/debug/station-code/:station", (req, res) => {
  const station = req.params.station.toUpperCase();
  res.json({
    station,
    apiStation: getApiStationCode(station),
  });
});

app.get("/api/debug/eta", async (req, res) => {
  const line = String(req.query.line || "").toUpperCase();
  const station = String(req.query.station || "").toUpperCase();
  const direction = String(req.query.direction || "").toUpperCase();
  const destinationStation = req.query.destinationStation
    ? String(req.query.destinationStation).toUpperCase()
    : null;

  if (!line || !station) {
    return res.status(400).json({
      error: "Provide line and station query params.",
    });
  }

  const { trainData, metadata } = await fetchStationScheduleDetails(line, station, {
    bypassCache: req.query.fresh === "1",
  });

  const trains = direction && Array.isArray(trainData?.[direction])
    ? trainData[direction]
    : [];
  const selectedTrain = trains.find((train) =>
    trainServesDestination(
      line,
      station,
      direction,
      destinationStation,
      train.dest,
    ),
  );
  const etaResult = direction
    ? await fetchExactETA(line, station, direction, destinationStation)
    : null;

  res.json({
    request: {
      line,
      station,
      direction,
      destinationStation,
    },
    metadata,
    availableKeys: trainData ? Object.keys(trainData) : [],
    candidateDestinations: trains.map((train) => train.dest).filter(Boolean),
    selectedTrain,
    etaResult,
    trainData,
  });
});

function handleStartupError(error) {
  if (error.code === "EADDRINUSE") {
    console.error(
      `[Startup] Port ${PORT} is already in use. Run with a different port, e.g. PORT=3000 node backend.js`,
    );
    process.exit(1);
  }

  console.error("[Startup] Server failed to start:", error);
  process.exit(1);
}

server.on("error", handleStartupError);
wss.on("error", handleStartupError);

process.on("uncaughtException", (error) => {
  if (error?.code === "EADDRINUSE") {
    handleStartupError(error);
    return;
  }

  console.error("[Fatal] Uncaught exception:", error);
  process.exit(1);
});

// ==========================================
// FIX: Use server.listen so WebSockets and Express share the SAME port!
// ==========================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Routing Backend running on port ${PORT} and listening on 0.0.0.0`);
});
