// Boxity cross-pod room directory: pushes this pod's live rooms to the matchmaker every ~2 s so the
// game page's "Open Rooms", friend joins and join-by-id work across pods. Without it the game page
// shows no rooms. No-op unless deployed by Boxity hosting (BLOXITY_REPORT_TOKEN, MATCHMAKER_REPORT_URL,
// BLOXITY_GAME_ID), so it is safe locally. Call installRoomReporter() after listen().

import { matchMaker } from "colyseus";

export function installRoomReporter(): void {
  const base = process.env.MATCHMAKER_REPORT_URL;
  const token = process.env.BLOXITY_REPORT_TOKEN;
  const gameId = process.env.BLOXITY_GAME_ID;
  const podName = process.env.POD_NAME || process.env.HOSTNAME || "";
  if (!base || !token || !gameId) return;

  const url = `${base.replace(/\/$/, "")}/${gameId}/rooms`;

  const tick = async (): Promise<void> => {
    try {
      const listings = await matchMaker.query({});
      const rooms = listings.map((listing) => ({
        colyseusRoomId: listing.roomId,
        name: listing.name || undefined,
        clients: listing.clients ?? 0,
        maxClients: listing.maxClients ?? 0,
        locked: !!listing.locked,
        private: !!listing.private,
        started: false,
        metadata: listing.metadata || undefined,
      }));
      const players = rooms.reduce((total, room) => total + room.clients, 0);
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ podName, players, rooms }),
        signal: AbortSignal.timeout(4_000),
      });
    } catch {
      // Best-effort; the directory tolerates gaps.
    }
  };

  setInterval(() => void tick(), 2000).unref();
  void tick();
}
