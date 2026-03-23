const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let routes = [];

// ==========================================
// 1. FULL MTR NETWORK (10 Lines + Branches)
// ==========================================
const lineSequences = {
  TWL: [
    "CEN",
    "ADM",
    "TST",
    "JOR",
    "YMT",
    "MOK",
    "PRE",
    "SSP",
    "CSW",
    "LCK",
    "MEI",
    "LAK",
    "KWF",
    "KWH",
    "TWH",
    "TSW",
  ],
  ISL: [
    "KET",
    "HKU",
    "SYP",
    "SHW",
    "CEN",
    "ADM",
    "WAC",
    "CAB",
    "TIN",
    "FOH",
    "NOP",
    "QUO",
    "TAK",
    "SWH",
    "SKW",
    "CHW",
  ],
  KTL: [
    "WHA",
    "HOM",
    "YMT",
    "MOK",
    "PRE",
    "SKM",
    "KOT",
    "LOF",
    "WTS",
    "DIH",
    "CHH",
    "KOB",
    "NTK",
    "KWT",
    "LAT",
    "YAT",
    "TIK",
  ],
  SIL: ["ADM", "OCP", "WCH", "LET", "SOH"],
  TML: [
    "WKS",
    "MOS",
    "HEO",
    "TSH",
    "SHM",
    "CIO",
    "STW",
    "CKT",
    "HIK",
    "TAW",
    "DIH",
    "KAK",
    "SUW",
    "TKW",
    "HOM",
    "HUH",
    "ETS",
    "AUS",
    "NAC",
    "MEI",
    "TWC",
    "TWW",
    "KSR",
    "YUL",
    "LOP",
    "TIS",
    "TUM",
  ],
  TCL: ["HOK", "KOW", "OLY", "NAC", "LAK", "TSY", "SUN", "TUC"],
  AEL: ["HOK", "KOW", "TSY", "AIR", "AWE"],
  DRL: ["SUN", "DIS"],
  EAL: [
    "ADM",
    "EXH",
    "HUH",
    "MKK",
    "KOT",
    "TAW",
    "SHT",
    "FOT",
    "UNI",
    "TAP",
    "TWO",
    "FAN",
    "SHS",
    "LOW",
  ],
  EAL_LMC: [
    "ADM",
    "EXH",
    "HUH",
    "MKK",
    "KOT",
    "TAW",
    "SHT",
    "FOT",
    "UNI",
    "TAP",
    "TWO",
    "FAN",
    "SHS",
    "LMC",
  ],
  EAL_RAC: [
    "ADM",
    "EXH",
    "HUH",
    "MKK",
    "KOT",
    "TAW",
    "SHT",
    "RAC",
    "UNI",
    "TAP",
    "TWO",
    "FAN",
    "SHS",
    "LOW",
  ],
  TKL: ["NOP", "QUO", "YAT", "TIK", "TKO", "HAH", "POA"],
  TKL_LHP: ["NOP", "QUO", "YAT", "TIK", "TKO", "LHP"],
};

const apiLineCodes = { EAL_LMC: "EAL", EAL_RAC: "EAL", TKL_LHP: "TKL" };

// ==========================================
// 2. GRAPH BUILDER & ROUTING LOGIC
// ==========================================
const graph = {};
function addEdge(a, b, line) {
  if (!graph[a]) graph[a] = [];
  if (!graph[b]) graph[b] = [];
  graph[a].push({ node: b, weight: 2, line });
  graph[b].push({ node: a, weight: 2, line });
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

function findShortestPath(start, end) {
  const distances = {};
  const previous = {};
  const queue = new Set(Object.keys(graph));

  for (let node of queue) {
    distances[node] = Infinity;
    previous[node] = null;
  }
  distances[start] = 0;

  while (queue.size > 0) {
    let currNode = null;
    let minDistance = Infinity;
    for (let node of queue) {
      if (distances[node] < minDistance) {
        minDistance = distances[node];
        currNode = node;
      }
    }
    if (currNode === null || currNode === end) break;
    queue.delete(currNode);

    for (let neighbor of graph[currNode] || []) {
      let transferPenalty =
        previous[currNode] && previous[currNode].line !== neighbor.line ? 5 : 0;
      let alt = distances[currNode] + neighbor.weight + transferPenalty;
      if (alt < distances[neighbor.node]) {
        distances[neighbor.node] = alt;
        previous[neighbor.node] = { node: currNode, line: neighbor.line };
      }
    }
  }

  const path = [];
  let current = end;
  while (current) {
    path.unshift(current);
    current = previous[current] ? previous[current].node : null;
  }
  return path;
}

function generateItinerary(start, end) {
  const path = findShortestPath(start, end);
  if (path.length < 2) return [];

  const legs = [];
  let currentLine = null;
  let legStart = path[0];
  let commuteTime = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    const edge = graph[from].find((e) => e.node === to);

    if (currentLine === null) {
      currentLine = edge.line;
      legs.push({
        type: "WAITING",
        line: currentLine,
        station: legStart,
        direction: getDirection(currentLine, from, to),
        targetTime: null,
      });
    }

    if (edge.line !== currentLine) {
      legs.push({
        type: "COMMUTING",
        line: currentLine,
        start: legStart,
        end: from,
        duration: commuteTime,
      });
      legs.push({
        type: "TRANSFERRING",
        station: from,
        toLine: edge.line,
        duration: 4,
      });
      legs.push({
        type: "WAITING",
        line: edge.line,
        station: from,
        direction: getDirection(edge.line, from, to),
        targetTime: null,
      });

      currentLine = edge.line;
      legStart = from;
      commuteTime = 0;
    }
    commuteTime += edge.weight;
  }
  legs.push({
    type: "COMMUTING",
    line: currentLine,
    start: legStart,
    end: path[path.length - 1],
    duration: commuteTime,
  });
  return legs;
}

// ==========================================
// 3. EXACT API TIMESTAMPS & POLLING CACHE
// ==========================================
const apiCache = new Map();

async function fetchExactETA(line, station, direction) {
  const officialLine = apiLineCodes[line] || line;
  const cacheKey = `${officialLine}-${station}-${direction}`;

  if (apiCache.has(cacheKey) && apiCache.get(cacheKey).expires > Date.now()) {
    return apiCache.get(cacheKey).time;
  }

  try {
    const url = `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${officialLine}&sta=${station}`;
    const res = await fetch(url);
    const data = await res.json();
    const trainData = data?.data?.[`${officialLine}-${station}`];

    if (trainData && trainData[direction] && trainData[direction].length > 0) {
      const timeStr = trainData[direction][0].time.replace(" ", "T") + "+08:00";
      const epoch = new Date(timeStr).getTime();
      apiCache.set(cacheKey, { time: epoch, expires: Date.now() + 8000 });
      return epoch;
    }
  } catch (e) {
    console.error(`ETA Error [${officialLine} ${station}]:`, e.message);
  }
  return null;
}

setInterval(async () => {
  let hasUpdates = false;
  for (let route of routes) {
    if (route.status !== "ACTIVE") continue;
    const leg = route.legs[route.currentLegIndex];

    if (leg && leg.type === "WAITING") {
      const liveEpoch = await fetchExactETA(
        leg.line,
        leg.station,
        leg.direction,
      );
      if (liveEpoch && liveEpoch !== leg.targetTime) {
        leg.targetTime = liveEpoch;
        hasUpdates = true;
      }
    }
  }
  if (hasUpdates) broadcast("routes_updated", routes);
}, 10000);

// ==========================================
// 4. API & WEBSOCKET ROUTES
// ==========================================
function broadcast(type, data) {
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type, data }));
  });
}

app.post("/api/routes", async (req, res) => {
  const { name, startCode, endCode } = req.body;
  if (!graph[startCode] || !graph[endCode])
    return res.status(400).json({ error: "Station not in core map." });

  const legs = generateItinerary(startCode, endCode);

  if (legs[0] && legs[0].type === "WAITING") {
    const liveEpoch = await fetchExactETA(
      legs[0].line,
      legs[0].station,
      legs[0].direction,
    );
    legs[0].targetTime = liveEpoch || Date.now() + 180000;
  }

  const newRoute = {
    id: `R-${Date.now()}`,
    name,
    legs,
    currentLegIndex: 0,
    status: "ACTIVE",
  };
  routes.push(newRoute);
  broadcast("new_route", newRoute);
  res.status(201).json(newRoute);
});

app.post("/api/routes/:id/advance", async (req, res) => {
  const route = routes.find((r) => r.id === req.params.id);
  if (!route) return res.status(404).json({ error: "Not found" });

  route.currentLegIndex++;
  if (route.currentLegIndex >= route.legs.length) {
    route.status = "COMPLETED";
  } else {
    const nextLeg = route.legs[route.currentLegIndex];
    if (nextLeg.type === "WAITING") {
      nextLeg.targetTime =
        (await fetchExactETA(
          nextLeg.line,
          nextLeg.station,
          nextLeg.direction,
        )) || Date.now() + 180000;
    } else {
      nextLeg.targetTime = Date.now() + nextLeg.duration * 60000;
    }
  }
  broadcast("routes_updated", routes);
  res.json(route);
});

app.delete("/api/routes/:id", (req, res) => {
  routes = routes.filter((r) => r.id !== req.params.id);
  broadcast("route_deleted", req.params.id);
  res.sendStatus(204);
});

app.get("/api/routes", (req, res) => res.json(routes));

server.listen(3000, () => console.log("Routing Backend running on port 3000"));
