# TRAFIK Tracker: Live Transit Chain

TRAFIK Tracker is a real-time, WebSocket-driven transit itinerary application designed for commuters in Hong Kong. It mathematically calculates the fastest multi-leg MTR journey and uses a continuous background polling engine to feed exact, live train ETAs directly from the Hong Kong Data.gov.hk API to the client.

## 🏗 Architecture Overview

- **Frontend (`index.html`)**: A lightweight Vanilla JS client. It handles local countdown timers based on exact epoch timestamps provided by the backend. It has no manual refresh or "missed train" buttons—it purely reflects the live data pushed to it.
- **Backend (`backend.js`)**: A Node.js Express/WebSocket server. It houses a complete MTR directional graph. It calculates the fastest route, determines the exact travel direction (UP/DOWN) for every wait, and polls the Data.gov.hk API every 10 seconds to keep all active itineraries perfectly synced with real-world train movements.

## ✨ Core Features & Pure API Logic

1. **Dijkstra Graph Routing**: The backend builds a node network from official MTR line sequences. It calculates the fastest path and auto-inserts transferring steps.
2. **Directional Intelligence**: The MTR API requires knowing if you are going `UP` or `DOWN` a line. The routing engine mathematically determines this by comparing the index of your current station against your next station on the specific line's sequence array.
3. **Exact Timestamps**: We extract the exact arrival time string (`YYYY-MM-DD HH:mm:ss`) from the MTR API, convert it to an Epoch timestamp, and send it to the frontend for precise countdowns.
4. **Auto-Polling & Self-Correction**: The backend runs a `setInterval` loop. Every 10 seconds, it fetches the latest API data for all users currently waiting for a train. If a train departs, the API naturally serves the next train's data, which is immediately broadcasted via WebSockets to auto-correct the user's UI.

## 🔌 API Contracts

- `POST /api/routes`: Submits `{ startCode, endCode }`. Returns a fully generated, multi-leg journey with exact train timestamps.
- `POST /api/routes/:id/advance`: Moves the user from "Waiting" to "Commuting", or "Commuting" to "Transferring".
- **WebSocket (`wss://trafiktrack.duckdns.org`)**: Broadcasts `new_route`, `route_deleted`, and `route_updated` (which fires every time the background API poll detects a change in the live train schedule).
