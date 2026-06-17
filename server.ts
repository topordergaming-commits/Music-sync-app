import express from "express";
import path from "path";
import http from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import multer from "multer";

// Configure Multer to store uploaded MP3s in memory
const memoryStorage = multer.memoryStorage();
const upload = multer({
  storage: memoryStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // Limit custom files to 15MB
});

interface RoomSpeaker {
  socketId: string;
  deviceName: string;
  isHost: boolean;
}

interface RoomPlayback {
  status: "PLAYING" | "PAUSED";
  spot: number; // seconds elapsed in song
  anchor: number; // server timestamp (Date.now()) when status/spot was updated
}

interface SongInfo {
  url: string;
  title: string;
  artist: string;
  duration: number; // seconds
  isCustom?: boolean;
}

interface RoomState {
  roomId: string;
  songs: SongInfo[];
  currentSongIndex: number;
  playback: RoomPlayback;
  members: RoomSpeaker[];
}

// In-memory application data structures
const roomsState = new Map<string, RoomState>();
const customSongsMap = new Map<string, { buffer: Buffer; mimeType: string; filename: string }>();

// Default test tracks
const DEMO_TRACKS: SongInfo[] = [
  {
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
    title: "Vibrant Synthwave Pulse",
    artist: "Demo Sync Track A",
    duration: 372,
  },
  {
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
    title: "Chilled Ambient Horizon",
    artist: "Demo Sync Track B",
    duration: 423,
  },
  {
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
    title: "Upbeat Electro Wave",
    artist: "Demo Sync Track C",
    duration: 302,
  },
];

// Helper to generate elegant 4-letter room codes (e.g. "BEAT", "ZUNE")
function generateRoomId(): string {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // readable chars without confusing ones (0, 1, I, O)
  let result = "";
  for (let i = 0; i < 4; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  // Set up socket.io on the same server
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  app.use(express.json());

  // API Route: Upload a custom track for a room
  app.post("/api/upload/:roomId", upload.single("audio"), (req, res) => {
    try {
      const { roomId } = req.params;
      const { title, artist, duration } = req.body;
      const file = req.file;

      if (!file) {
        return res.status(400).json({ error: "Missing audio file element" });
      }

      const room = roomsState.get(roomId);
      if (!room) {
        return res.status(404).json({ error: "Room not found" });
      }

      // Store file in our custom in-memory map
      const songId = `custom_song_${roomId}_${Date.now()}`;
      customSongsMap.set(songId, {
        buffer: file.buffer,
        mimeType: file.mimetype,
        filename: file.originalname,
      });

      // Construct stream url
      const streamUrl = `/api/stream/${songId}`;

      const newSong: SongInfo = {
        url: streamUrl,
        title: title || file.originalname.replace(/\.[^/.]+$/, ""),
        artist: artist || "Uploaded Song",
        duration: Math.round(Number(duration)) || 180,
        isCustom: true,
      };

      // Append song to room's playlist
      room.songs.push(newSong);
      room.currentSongIndex = room.songs.length - 1;

      // Reset playback state to start of the new song
      room.playback = {
        status: "PAUSED",
        spot: 0,
        anchor: Date.now(),
      };

      // Broadcast update to the room membership via socket
      io.to(roomId).emit("room-updated", room);

      return res.json({ success: true, song: newSong });
    } catch (err: any) {
      console.error("Upload handler error:", err);
      return res.status(500).json({ error: "Server error handling upload: " + err.message });
    }
  });

  // API Route: Stream uploaded custom track with HTTP range support so seeking works beautifully
  app.get("/api/stream/:songId", (req, res) => {
    const { songId } = req.params;
    const songData = customSongsMap.get(songId);

    if (!songData) {
      return res.status(404).send("Song data not found or expired.");
    }

    const { buffer, mimeType } = songData;
    const totalLength = buffer.length;

    // Handle range headers for native seeking
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalLength - 1;

      if (start >= totalLength || end >= totalLength) {
        res.writeHead(416, {
          "Content-Range": `bytes */${totalLength}`,
        });
        return res.end();
      }

      const chunk = buffer.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${totalLength}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunk.length,
        "Content-Type": mimeType,
      });
      res.write(chunk);
      res.end();
    } else {
      res.writeHead(200, {
        "Content-Length": totalLength,
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
      });
      res.write(buffer);
      res.end();
    }
  });

  // API Route: Quick server health and specs check
  app.get("/api/health", (req, res) => {
    res.json({
      status: "healthy",
      time: Date.now(),
      roomsCount: roomsState.size,
    });
  });

  // Real-time synchronization hub with Socket.io
  io.on("connection", (socket) => {
    let currentSocketRoomId: string | null = null;

    // 1. Clock Offset Sync protocol (NTP pattern for high accuracy)
    socket.on("sync-time", (clientTime: number) => {
      socket.emit("sync-time-response", {
        clientTime,
        serverTime: Date.now(),
      });
    });

    // 2. Room creation
    socket.on("create-room", ({ deviceName }: { deviceName: string }) => {
      let roomId = generateRoomId();
      while (roomsState.has(roomId)) {
        roomId = generateRoomId(); // Ensure unique ID
      }

      const roomData: RoomState = {
        roomId,
        songs: [...DEMO_TRACKS],
        currentSongIndex: 0,
        playback: {
          status: "PAUSED",
          spot: 0,
          anchor: Date.now(),
        },
        members: [
          {
            socketId: socket.id,
            deviceName: deviceName || "Host Device",
            isHost: true,
          },
        ],
      };

      roomsState.set(roomId, roomData);
      socket.join(roomId);
      currentSocketRoomId = roomId;

      socket.emit("room-created", roomData);
    });

    // 3. Joining an existing room
    socket.on("join-room", ({ roomId, deviceName }: { roomId: string; deviceName: string }) => {
      const cleanRoomId = roomId.toUpperCase().trim();
      const room = roomsState.get(cleanRoomId);

      if (!room) {
        socket.emit("join-error", { error: "Room not found. Check the 4-character code!" });
        return;
      }

      // Check if this socket is already in the room
      const exists = room.members.some((m) => m.socketId === socket.id);
      if (!exists) {
        room.members.push({
          socketId: socket.id,
          deviceName: deviceName || `Speaker ${room.members.length + 1}`,
          isHost: false,
        });
      }

      socket.join(cleanRoomId);
      currentSocketRoomId = cleanRoomId;

      // Broadcast updated state to everybody in the room
      io.to(cleanRoomId).emit("room-updated", room);
      socket.emit("joined-successfully", room);
    });

    // 4. Track change / Custom track selected
    socket.on("change-track", ({ index }: { index: number }) => {
      if (!currentSocketRoomId) return;
      const room = roomsState.get(currentSocketRoomId);
      if (!room) return;

      // Only host can switch playlist track
      const member = room.members.find((m) => m.socketId === socket.id);
      if (!member?.isHost) return;

      if (index >= 0 && index < room.songs.length) {
        room.currentSongIndex = index;
        room.playback = {
          status: "PAUSED",
          spot: 0,
          anchor: Date.now(),
        };

        io.to(currentSocketRoomId).emit("room-updated", room);
      }
    });

    // 5. Playback Command updates (Host initiates Play, Pause, Seek)
    socket.on("playback-control", (control: { status: "PLAYING" | "PAUSED"; spot: number }) => {
      if (!currentSocketRoomId) return;
      const room = roomsState.get(currentSocketRoomId);
      if (!room) return;

      const member = room.members.find((m) => m.socketId === socket.id);
      if (!member?.isHost) return;

      // Update room authoritative state
      room.playback = {
        status: control.status,
        spot: control.spot,
        anchor: Date.now(), // Anchor with current SERVER timestamp
      };

      // Broadcast changes immediately to all occupants in room
      io.to(currentSocketRoomId).emit("playback-broadcast", room.playback);
    });

    // 6. Manual request from a standard speaker device to seek the latest state to sync up
    socket.on("request-resync", () => {
      if (!currentSocketRoomId) return;
      const room = roomsState.get(currentSocketRoomId);
      if (room) {
        socket.emit("playback-broadcast", room.playback);
      }
    });

    // 7. Handle client disconnection
    socket.on("disconnect", () => {
      if (!currentSocketRoomId) return;
      const room = roomsState.get(currentSocketRoomId);
      if (!room) return;

      const deletedMember = room.members.find((m) => m.socketId === socket.id);
      room.members = room.members.filter((m) => m.socketId !== socket.id);

      // If host disconnected and the room is not empty, reassign host role to keep the party alive
      if (deletedMember?.isHost && room.members.length > 0) {
        room.members[0].isHost = true;
      }

      // If room is empty, sweep memory
      if (room.members.length === 0) {
        // Find and delete any custom uploaded assets associated with this room
        const customPrefix = `custom_song_${currentSocketRoomId}_`;
        for (const songId of customSongsMap.keys()) {
          if (songId.startsWith(customPrefix)) {
            customSongsMap.delete(songId);
          }
        }
        roomsState.delete(currentSocketRoomId);
      } else {
        io.to(currentSocketRoomId).emit("room-updated", room);
      }
    });
  });

  // Serve static assets in production mode
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[Multi-Phone Synced Server] active on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Critical server bootstrap failure:", error);
});
