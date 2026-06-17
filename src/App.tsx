import React, { useState, useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";
import { 
  Play, 
  Pause, 
  Users, 
  Volume2, 
  Upload, 
  Smartphone, 
  Info, 
  QrCode, 
  Copy, 
  ExternalLink, 
  RefreshCw, 
  FileAudio, 
  Check, 
  Wifi, 
  Radio, 
  HelpCircle,
  Clock,
  ChevronRight
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { RoomState, SongInfo, PlaybackState, SpeakerMember } from "./types";

// Random phone descriptors to skip boring typing
const FUN_PHONES = [
  "Ambient Speaker Pod",
  "Silver Sonic Phone",
  "Rhythm Booster One",
  "Neon Companion",
  "Pocket Subwoofer",
  "Retro Acoustic Link",
  "Symmetric Soundbox",
  "Waveform Sync Node"
];

export default function App() {
  // Connection and Identity
  const [socket, setSocket] = useState<Socket | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [inputRoomId, setInputRoomId] = useState("");
  const [activeRoom, setActiveRoom] = useState<RoomState | null>(null);
  const [isHost, setIsHost] = useState(false);

  // Sync details
  const [clockOffset, setClockOffset] = useState<number>(0);
  const [latency, setLatency] = useState<number>(0);
  const [isSyncingClock, setIsSyncingClock] = useState<boolean>(false);
  const [audioBlocked, setAudioBlocked] = useState<boolean>(false);
  const [showQrModal, setShowQrModal] = useState<boolean>(false);
  const [copySuccess, setCopySuccess] = useState<boolean>(false);

  // Audio loading/stream states
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [isAudioLoaded, setIsAudioLoaded] = useState<boolean>(false);
  const [currentTimeMs, setCurrentTimeMs] = useState<number>(0);

  // Refs
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clockOffsetRef = useRef<number>(0);
  const activeRoomRef = useRef<RoomState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Keep references updated for intervals
  useEffect(() => {
    clockOffsetRef.current = clockOffset;
  }, [clockOffset]);

  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  // Read query parameters on boot for QR-Code auto joins
  useEffect(() => {
    // Generate a default fun device name at startup
    const randName = FUN_PHONES[Math.floor(Math.random() * FUN_PHONES.length)] + " " + Math.floor(Math.random() * 900 + 100);
    setDeviceName(randName);

    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get("room");
    if (roomFromUrl) {
      setInputRoomId(roomFromUrl.toUpperCase());
    }

    // Allocate single stable HTMLAudioElement
    const audio = new Audio();
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    audioRef.current = audio;

    // Track audio progress natively
    const handleTimeUpdate = () => {
      setCurrentTimeMs(audio.currentTime * 1000);
    };
    audio.addEventListener("timeupdate", handleTimeUpdate);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.pause();
      audioRef.current = null;
    };
  }, []);

  // Socket Connection setup
  useEffect(() => {
    const devUrl = window.location.origin;
    const s = io(devUrl, {
      transports: ["websocket", "polling"]
    });
    setSocket(s);

    // Dynamic NTP Calibration Handler
    s.on("sync-time-response", ({ clientTime, serverTime }) => {
      const now = Date.now();
      const rtt = now - clientTime;
      const estServerTime = serverTime + rtt / 2;
      const offset = estServerTime - now;

      setClockOffset(offset);
      setLatency(Math.round(rtt / 2));
      setIsSyncingClock(false);
      console.log(`[Clock Sync] Calibration succeeded: offset ${offset}ms, latency ${rtt/2}ms`);
    });

    s.on("room-created", (room: RoomState) => {
      setActiveRoom(room);
      setIsHost(true);
      setAudioBlocked(false);
    });

    s.on("joined-successfully", (room: RoomState) => {
      setActiveRoom(room);
      setIsHost(false);
      // Automatically prompt mobile user to initialize audio context
      setAudioBlocked(true);
    });

    s.on("room-updated", (room: RoomState) => {
      setActiveRoom(room);
      // Sync Host/Speaker role just in case of host migration
      const localMember = room.members.find((m) => m.socketId === s.id);
      if (localMember) {
        setIsHost(localMember.isHost);
      }
    });

    s.on("playback-broadcast", (newPlayback: PlaybackState) => {
      const room = activeRoomRef.current;
      if (room) {
        const nextRoomState = { ...room, playback: newPlayback };
        setActiveRoom(nextRoomState);
      }
    });

    s.on("join-error", ({ error }: { error: string }) => {
      alert(error);
    });

    // Sync clock initially
    triggerClockSync(s);

    // Keep calibrating NTP every 12 seconds to prevent device clock drifting
    const driftCalculator = setInterval(() => {
      triggerClockSync(s);
    }, 12000);

    return () => {
      clearInterval(driftCalculator);
      s.disconnect();
    };
  }, []);

  // Align active audio tag based on current room State
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeRoom) return;

    const currentTrack = activeRoom.songs[activeRoom.currentSongIndex];
    if (!currentTrack) return;

    // Is the audio target pointing to the correct stream?
    const currentSrc = audio.src ? new URL(audio.src).pathname : "";
    let targetSrcPath = currentTrack.url;
    
    // Support playing local API stream and demo absolute urls
    if (targetSrcPath.startsWith("/api/")) {
      targetSrcPath = window.location.origin + targetSrcPath;
    }

    if (audio.src !== targetSrcPath) {
      audio.src = targetSrcPath;
      audio.load();
      setIsAudioLoaded(true);
    }
  }, [activeRoom?.currentSongIndex, activeRoom?.songs]);

  // Periodic Synchronization Thread loop
  useEffect(() => {
    const syncLoop = setInterval(() => {
      const audio = audioRef.current;
      const room = activeRoomRef.current;
      if (!audio || !room) return;

      const playback = room.playback;
      const currentTrack = room.songs[room.currentSongIndex];
      if (!currentTrack) return;

      const now = Date.now();
      const estServerTime = now + clockOffsetRef.current;

      if (playback.status === "PLAYING") {
        // Calculate the exact millisecond timeline position the server dictates
        const elapsedSinceAnchor = (estServerTime - playback.anchor) / 1000;
        const targetSeconds = playback.spot + elapsedSinceAnchor;

        if (targetSeconds >= currentTrack.duration) {
          // Song reached natural completion
          if (audio.paused === false) {
            audio.pause();
          }
          if (isHost) {
            // Host is responsible for cycling tracks or stopping playing
            handleHostCycleAuto();
          }
        } else if (targetSeconds >= 0) {
          // Playback is active
          if (audio.paused && !audioBlocked) {
            audio.play().catch((err) => {
              console.warn("Auto-play restricted. Unlock target needed.", err);
              setAudioBlocked(true);
            });
          }

          // Trigger continuous realignment only if drift is > 150ms
          const delta = Math.abs(audio.currentTime - targetSeconds);
          if (delta > 0.15) {
            console.log(`[Sync Drift Alignment] Drifted ${Math.round(delta * 1000)}ms. Seeking...`);
            audio.currentTime = targetSeconds;
          }
        }
      } else {
        // State is PAUSED
        if (!audio.paused) {
          audio.pause();
        }
        // Force clamp to the correct pause spot
        const delta = Math.abs(audio.currentTime - playback.spot);
        if (delta > 0.25) {
          audio.currentTime = playback.spot;
        }
      }
    }, 180); // Quick check interval 180ms

    return () => clearInterval(syncLoop);
  }, [audioBlocked, isHost]);

  // NTP Sync trigger
  const triggerClockSync = (activeSocket: Socket | null) => {
    const conn = activeSocket || socket;
    if (conn) {
      setIsSyncingClock(true);
      conn.emit("sync-time", Date.now());
    }
  };

  // Auto transition to next song once completed (Host authoritative rule)
  const handleHostCycleAuto = () => {
    if (!activeRoom || !socket) return;
    const nextIndex = (activeRoom.currentSongIndex + 1) % activeRoom.songs.length;
    socket.emit("change-track", { index: nextIndex });
  };

  // Host playback controls
  const handlePlayPause = () => {
    const audio = audioRef.current;
    if (!audio || !socket || !activeRoom) return;

    const currentStatus = activeRoom.playback.status;
    const targetStatus = currentStatus === "PLAYING" ? "PAUSED" : "PLAYING";

    socket.emit("playback-control", {
      status: targetStatus,
      spot: audio.currentTime,
    });
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    const targetValue = parseFloat(e.target.value);
    if (!audio || !socket || !activeRoom) return;

    // Update server position instantly
    socket.emit("playback-control", {
      status: activeRoom.playback.status,
      spot: targetValue,
    });
  };

  const handleNextTrack = () => {
    if (!activeRoom || !socket) return;
    const nextId = (activeRoom.currentSongIndex + 1) % activeRoom.songs.length;
    socket.emit("change-track", { index: nextId });
  };

  const handlePrevTrack = () => {
    if (!activeRoom || !socket) return;
    const prevId = (activeRoom.currentSongIndex - 1 + activeRoom.songs.length) % activeRoom.songs.length;
    socket.emit("change-track", { index: prevId });
  };

  const handleTrackSelect = (idx: number) => {
    if (!socket || !isHost) return;
    socket.emit("change-track", { index: idx });
  };

  // Audio Context mobile unlock trigger
  const unlockAudioSensor = () => {
    const audio = audioRef.current;
    if (audio) {
      // Play a minuscule system click sample to register user-touch audio gesture
      console.log("[Audio Safety] Unlock sequence initiated.");
      audio.play()
        .then(() => {
          audio.pause();
          setAudioBlocked(false);
          // Manually ask server for latest states to sync up instantly
          if (socket) {
            socket.emit("request-resync");
          }
        })
        .catch((e) => {
          console.error("Unlock error: Ensure speaker volume is turned up", e);
        });
    }
  };

  // Room creation and joining flows
  const handleCreateRoom = () => {
    if (!socket || !deviceName.trim()) return;
    socket.emit("create-room", { deviceName: deviceName.trim() });
  };

  const handleJoinRoom = () => {
    if (!socket || !inputRoomId.trim() || !deviceName.trim()) return;
    socket.emit("join-room", {
      roomId: inputRoomId.toUpperCase().trim(),
      deviceName: deviceName.trim(),
    });
  };

  // File Upload Handlers (Host Exclusive)
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      uploadCustomFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      uploadCustomFile(e.target.files[0]);
    }
  };

  const uploadCustomFile = (file: File) => {
    if (!activeRoom) return;
    if (!file.type.startsWith("audio/")) {
      alert("Invalid format. Please select an MP3 or standard audio file.");
      return;
    }

    setIsUploading(true);
    setUploadProgress(10);

    // Read the duration cleanly beforehand using an offline sandbox
    const tempAudio = document.createElement("audio");
    tempAudio.src = URL.createObjectURL(file);
    tempAudio.addEventListener("loadedmetadata", () => {
      const duration = tempAudio.duration || 180;
      setUploadProgress(30);

      // Construct form upload payload
      const fData = new FormData();
      fData.append("audio", file);
      fData.append("title", file.name.replace(/\.[^/.]+$/, ""));
      fData.append("artist", `${deviceName.split(" ")[0]}'s Phone Track`);
      fData.append("duration", String(duration));

      setUploadProgress(60);

      fetch(`/api/upload/${activeRoom.roomId}`, {
        method: "POST",
        body: fData,
      })
        .then((res) => {
          if (!res.ok) throw new Error("Upload response was negative");
          return res.json();
        })
        .then((data) => {
          setUploadProgress(100);
          setTimeout(() => {
            setIsUploading(false);
            setUploadProgress(0);
          }, 600);
        })
        .catch((err) => {
          console.error("Upload error:", err);
          alert("Audio upload failed. Check file bounds.");
          setIsUploading(false);
        });
    });
  };

  // Share and Utilities
  const copyRoomLink = () => {
    if (!activeRoom) return;
    const url = `${window.location.origin}${window.location.pathname}?room=${activeRoom.roomId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    });
  };

  const getShareUrl = () => {
    if (!activeRoom) return "";
    return `${window.location.origin}${window.location.pathname}?room=${activeRoom.roomId}`;
  };

  // Calculate local timers helper
  const renderTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const activeTrack = activeRoom ? activeRoom.songs[activeRoom.currentSongIndex] : null;

  return (
    <div className="min-h-screen bg-[#050505] text-slate-100 flex flex-col font-sans select-none relative overflow-hidden">
      
      {/* Visual background ambient glow spheres (Frosted Glass spec) */}
      <div className="absolute inset-0 pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[60vw] h-[60vw] rounded-full bg-blue-600/20 blur-[120px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[60vw] h-[60vw] rounded-full bg-orange-600/10 blur-[120px]"></div>
        <div className="absolute top-[20%] right-[10%] w-[40vw] h-[40vw] rounded-full bg-purple-600/15 blur-[100px]"></div>
      </div>

      {/* Global Header (Frosted Glass spec) */}
      <header className="h-16 flex items-center justify-between px-6 z-10 border-b border-white/5 bg-[#050505]/40 backdrop-blur-md sticky top-0">
        <div className="max-w-md w-full mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-gradient-to-tr from-blue-500 to-indigo-600 rounded-lg flex items-center justify-center font-bold italic shadow-lg shadow-blue-500/20 text-white text-base">
              S
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-tight text-white leading-tight">SymphonySync</h1>
              <p className="text-[10px] text-white/40 tracking-wider uppercase font-mono">Booster Active</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {activeRoom && (
              <div className="flex items-center gap-1.5 bg-white/5 border border-white/10 px-2.5 py-1 rounded-full text-[10px] font-medium text-white/90">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
                {activeRoom.members.length} Synced
              </div>
            )}
            <button 
              onClick={() => triggerClockSync(null)} 
              disabled={isSyncingClock}
              className="p-1.5 rounded-full bg-white/5 border border-white/10 text-white/60 hover:text-white transition-colors cursor-pointer"
              title="Calibrate Clock offset"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncingClock ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 flex flex-col px-4 py-8 max-w-md w-full mx-auto relative z-10 justify-center">
        
        <AnimatePresence mode="wait">
          {!activeRoom ? (
            
            /* LOBBY / INITIAL SETUP CARD (Frosted Glass style) */
            <motion.div
              key="lobby"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="space-y-6 flex flex-col"
            >
              <div className="text-center space-y-2">
                <span className="px-3 py-1 rounded-full text-[10px] uppercase font-mono tracking-[0.2em] bg-blue-500/10 text-blue-400 border border-blue-500/25 inline-block font-bold">
                  Phase Alignment Transmission
                </span>
                <h2 className="text-3xl font-black tracking-tight text-white mb-1 leading-tight">
                  Multi-Smartphones <br />
                  System Synced Song
                </h2>
                <p className="text-white/50 text-xs max-w-sm mx-auto leading-relaxed">
                  Join with another smartphone to automatically play the same track at the exact same millisecond. Multiply sound volume seamlessly!
                </p>
              </div>

              {/* Setting Panel (Frosted Glass theme) */}
              <div className="bg-white/5 border border-white/10 rounded-[32px] p-6 backdrop-blur-xl shadow-2xl space-y-5">
                
                {/* Device Name Field */}
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-[0.15em] text-white/40">Your Local Phone Identity</label>
                  <div className="flex items-center gap-2">
                    <div className="p-3 rounded-2xl bg-white/5 border border-white/10 text-white/60">
                      <Smartphone className="w-4 h-4" />
                    </div>
                    <input 
                      type="text" 
                      value={deviceName}
                      onChange={(e) => setDeviceName(e.target.value)}
                      placeholder="e.g. Galaxy S23"
                      className="flex-1 bg-black/40 border border-white/10 rounded-2xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 font-medium text-white placeholder:text-white/20"
                    />
                  </div>
                </div>

                <div className="border-t border-white/5 my-2" />

                <div className="space-y-4">
                  {/* Join Room */}
                  <div className="space-y-2.5">
                    <h3 className="text-xs font-bold text-white/70">Connect into Friend's Room</h3>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input 
                          type="text" 
                          maxLength={4}
                          value={inputRoomId}
                          onChange={(e) => setInputRoomId(e.target.value.toUpperCase())}
                          placeholder="4-LETTER CODE"
                          className="w-full bg-black/40 border border-white/10 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:border-blue-400/50 font-mono tracking-[0.2em] text-center text-blue-400 uppercase placeholder:tracking-normal placeholder:font-sans placeholder:text-xs font-bold placeholder:text-white/20"
                        />
                      </div>
                      <button 
                        onClick={handleJoinRoom}
                        disabled={!inputRoomId.trim()}
                        className="px-5 bg-white/10 hover:bg-white/20 text-white border border-white/10 font-bold text-xs rounded-2xl transition-colors cursor-pointer flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Join Room
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-center gap-2 my-1 text-white/20 font-mono text-[10px]">
                    <span className="h-[1px] bg-white/5 flex-1"></span>
                    <span>OR</span>
                    <span className="h-[1px] bg-white/5 flex-1"></span>
                  </div>

                  {/* Create Room Button (Frosted Blue spec) */}
                  <button 
                    onClick={handleCreateRoom}
                    className="w-full py-3.5 bg-gradient-to-tr from-blue-500 to-indigo-600 hover:from-blue-400 hover:to-indigo-500 text-white rounded-2xl text-xs font-extrabold tracking-wider transition-all shadow-lg shadow-blue-500/10 cursor-pointer flex items-center justify-center gap-1.5 text-center uppercase"
                  >
                    Host a New Sync Room
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Instructions Banner */}
              <div className="p-4 rounded-[20px] bg-white/5 border border-white/10 flex gap-3 text-[11px] text-white/60 leading-relaxed backdrop-blur-md">
                <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold text-white/80">Calibration Protocol:</span> Create a room on Phone A, tap <span className="text-white">Share QR</span>, then scan/join using Phone B. Keep both speaker volumes high to amplify the acoustic sound outputs!
                </div>
              </div>
            </motion.div>
          ) : (
            
            /* DYNAMIC SYNCED PLAYER IN ROOM (Frosted Glass specs) */
            <motion.div
              key="player"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="space-y-5"
            >
              
              {/* Room Access Panel */}
              <div className="p-4 rounded-[24px] bg-white/5 border border-white/10 backdrop-blur-xl flex items-center justify-between">
                <div>
                  <div className="text-[9px] font-mono uppercase text-white/40 tracking-[0.15em] font-bold">Synchronized Fleet ID</div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xl font-bold tracking-wider font-mono text-blue-400">{activeRoom.roomId}</span>
                    <button 
                      onClick={copyRoomLink}
                      className="p-1 rounded text-white/50 hover:text-white transition-colors cursor-pointer"
                      title="Copy join link"
                    >
                      {copySuccess ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setShowQrModal(true)}
                    className="p-2 px-3 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all text-[11px] font-bold cursor-pointer flex items-center gap-1.5 border border-white/10"
                  >
                    <QrCode className="w-3.5 h-3.5 text-blue-400" />
                    Share QR
                  </button>
                  {isHost && (
                    <span className="px-2.5 py-1 rounded-full text-[9px] font-extrabold bg-blue-500/10 text-blue-300 border border-blue-500/30 font-mono tracking-wider uppercase">
                      👑 Master
                    </span>
                  )}
                </div>
              </div>

              {/* Autoplay Blocker Overlay Trigger */}
              {audioBlocked && (
                <motion.div 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 rounded-2xl bg-gradient-to-r from-blue-500/15 to-indigo-500/15 border border-white/10 backdrop-blur-md text-center space-y-2.5"
                >
                  <p className="text-xs text-blue-300 font-medium leading-relaxed">
                    🔊 Mobile browsers require a gesture to connect audio streams. Click below to engage sound transmission.
                  </p>
                  <button 
                    onClick={unlockAudioSensor}
                    className="px-6 py-2.5 bg-white hover:bg-white/90 text-black font-extrabold text-xs rounded-full shadow-lg shadow-white/15 transition-all cursor-pointer animate-bounce"
                  >
                    Connect Speaker Stream
                  </button>
                </motion.div>
              )}

              {/* Music Visual Deck Card */}
              <div className="p-6 rounded-[32px] bg-white/5 border border-white/10 backdrop-blur-xl flex flex-col items-center text-center relative overflow-hidden shadow-2xl">
                
                {/* Visualizer beautiful reflective circles */}
                <div className="absolute w-48 h-48 rounded-full border border-white/5 flex items-center justify-center">
                  <div className="w-36 h-36 rounded-full border border-white/5 flex items-center justify-center">
                    <div className="w-24 h-24 rounded-full border border-white/10 flex items-center justify-center" />
                  </div>
                </div>

                {/* Simulated Waveform Visualizer with Indigo-Orange gradients */}
                <div className="h-28 flex items-center justify-center gap-[4px] relative z-20 w-full">
                  {activeRoom.playback.status === "PLAYING" && !audioBlocked ? (
                    // Emit pulsing audio bars in accordance with theme
                    Array.from({ length: 14 }).map((_, i) => (
                      <motion.span
                        key={i}
                        animate={{
                          height: [18, Math.random() * 64 + 20, 18],
                        }}
                        transition={{
                          duration: 0.7 + i * 0.05,
                          repeat: Infinity,
                          ease: "easeInOut",
                        }}
                        className={`w-[6px] rounded bg-gradient-to-t ${
                          i % 2 === 0 ? 'from-blue-500 to-indigo-500' : 'from-indigo-400 to-purple-400'
                        }`}
                      />
                    ))
                  ) : (
                    // Flat static wave bars when paused
                    Array.from({ length: 14 }).map((_, i) => (
                      <span
                        key={i}
                        className="w-[6px] h-3.5 rounded bg-white/10"
                      />
                    ))
                  )}
                </div>

                {/* Metadata */}
                <div className="mt-4 space-y-1 relative z-20 w-full">
                  <h3 className="text-lg font-bold text-white truncate px-3" title={activeTrack?.title}>
                    {activeTrack ? activeTrack.title : "No Song Active"}
                  </h3>
                  <p className="text-white/40 text-xs tracking-widest font-mono uppercase">
                    {activeTrack ? activeTrack.artist : "Awaiting Host Playlist"}
                  </p>
                </div>

                {/* Progress bar controller */}
                {activeTrack && (
                  <div className="mt-5 w-full space-y-1.5 relative z-20">
                    <div className="flex justify-between text-[10px] font-mono text-white/50 px-0.5">
                      <span>{renderTime(currentTimeMs / 1000)}</span>
                      <span>{renderTime(activeTrack.duration)}</span>
                    </div>
                    {isHost ? (
                      <input 
                        type="range"
                        min={0}
                        max={activeTrack.duration}
                        value={currentTimeMs / 1000}
                        onChange={handleSeek}
                        className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-blue-400 focus:outline-none"
                      />
                    ) : (
                      // Display simple read-only progress indicator for client speakers (to avoid user confusion/lag)
                      <div className="w-full h-1.5 bg-white/10 rounded-lg overflow-hidden">
                        <div 
                          className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-lg"
                          style={{ width: `${Math.min(100, ((currentTimeMs / 1000) / activeTrack.duration) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Host Control Deck panel (Frosted Glass spec layout) */}
              {isHost ? (
                <div className="bg-white/5 border border-white/10 rounded-[24px] p-4 backdrop-blur-xl flex items-center justify-around gap-4 shadow-xl">
                  <button 
                    onClick={handlePrevTrack}
                    className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 text-white hover:bg-white/10 transition-all flex items-center justify-center cursor-pointer"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12.062 12.551L18 16.5V7.5L12.062 11.449M6 12L12 8V16L6 12Z" />
                    </svg>
                  </button>

                  <button 
                    onClick={handlePlayPause}
                    className="w-14 h-14 rounded-full bg-white text-black hover:bg-white/90 shadow-xl flex items-center justify-center transition-all cursor-pointer hover:scale-105 active:scale-95 shrink-0"
                  >
                    {activeRoom.playback.status === "PLAYING" ? (
                      <Pause className="w-5 h-5 stroke-[2.5] text-black" fill="currentColor" />
                    ) : (
                      <Play className="w-5 h-5 stroke-[2.5] text-black" fill="currentColor" />
                    )}
                  </button>

                  <button 
                    onClick={handleNextTrack}
                    className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 text-white hover:bg-white/10 transition-all flex items-center justify-center cursor-pointer"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M11.938 11.449L6 7.5v9l5.938-3.951m5.938.451l-6 4V8l6 4Z" />
                    </svg>
                  </button>
                </div>
              ) : (
                /* CLIENT / SPEAKER HELPFUL NOTE PANEL */
                <div className="p-4 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-md space-y-1 text-center">
                  <div className="flex items-center justify-center gap-1.5 text-xs text-blue-300 font-bold">
                    <Volume2 className="w-4 h-4 text-blue-400 animate-bounce" />
                    Acoustic Output Synced
                  </div>
                  <p className="text-[10px] text-white/50 max-w-xs mx-auto">
                    The room host is steering the core transmission stream. Max out your phone's volume to act as a synced sound booster!
                  </p>
                </div>
              )}

              {/* Playlist & Upload Center (Frosted layouts) */}
              <div className="bg-white/5 border border-white/10 rounded-[32px] p-5 backdrop-blur-xl space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold uppercase tracking-[0.15em] text-white/40 flex items-center gap-1.5">
                    <FileAudio className="w-4 h-4 text-blue-400" />
                    Acoustic Fleet Playlist ({activeRoom.songs.length})
                  </h4>
                </div>

                {/* Integrated custom drag upload helper (Host Exclusive) */}
                {isHost && (
                  <div 
                    onDragEnter={handleDrag}
                    onDragOver={handleDrag}
                    onDragLeave={handleDrag}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`p-4 rounded-2xl border border-dashed text-center cursor-pointer transition-all ${
                      dragActive 
                        ? 'border-blue-400 bg-blue-500/10' 
                        : 'border-white/10 bg-white/5 hover:bg-white/10'
                    }`}
                  >
                    <input 
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileInput}
                      accept="audio/*"
                      className="hidden"
                    />
                    
                    {isUploading ? (
                      <div className="space-y-1">
                        <div className="flex items-center justify-center gap-1.5 text-xs font-mono text-blue-400">
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          Indexing Audio - {uploadProgress}%
                        </div>
                        <div className="w-full bg-white/10 h-1.5 rounded overflow-hidden">
                          <div className="bg-blue-400 h-full transition-all duration-300" style={{ width: `${uploadProgress}%` }} />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1 text-xs text-white/60">
                        <p className="text-xs font-bold text-white flex items-center justify-center gap-1">
                          <Upload className="w-4 h-4 text-blue-400" />
                          Host: Upload another custom song (MP3)
                        </p>
                        <p className="text-[10px] text-white/40">Select file or drag local files here</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Playlist item blocks */}
                <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
                  {activeRoom.songs.map((song, idx) => {
                    const isPlayingThis = activeRoom.currentSongIndex === idx;
                    return (
                      <button
                        key={idx}
                        disabled={!isHost}
                        onClick={() => handleTrackSelect(idx)}
                        className={`w-full text-left p-3 rounded-2xl border text-xs flex items-center justify-between group transition-all ${
                          isPlayingThis
                            ? 'bg-blue-500/10 border-blue-500/30 text-blue-300 font-bold'
                            : 'bg-white/5 border-white/5 hover:border-white/10 text-white/80 cursor-pointer disabled:cursor-not-allowed'
                        }`}
                      >
                        <div className="flex items-center gap-2 max-w-[85%]">
                          <span className="font-mono text-[9px] text-white/30">0{idx + 1}</span>
                          <div className="truncate text-left">
                            <p className="truncate text-xs font-semibold">{song.title}</p>
                            <p className="truncate text-[10px] text-white/40 font-mono font-normal">{song.artist}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-white/40 font-mono">{renderTime(song.duration)}</span>
                          {isPlayingThis && activeRoom.playback.status === "PLAYING" && (
                            <span className="w-2 h-2 rounded-full bg-blue-400 animate-ping shrink-0" />
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Connected Speaker Devices Network Panel */}
              <div className="bg-white/5 border border-white/10 rounded-[32px] p-5 backdrop-blur-xl space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold uppercase tracking-[0.15em] text-white/40 flex items-center gap-1.5">
                    <Users className="w-4 h-4 text-orange-400" />
                    Synced Fleet Grid ({activeRoom.members.length})
                  </h4>
                  <span className="text-[10px] font-mono text-white/40 font-semibold uppercase tracking-wider">Phase Aligned</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {activeRoom.members.map((member, index) => {
                    const isSocketMatch = socket?.id === member.socketId;
                    return (
                      <div 
                        key={index}
                        className={`p-3 rounded-2xl border flex items-center gap-2.5 ${
                          isSocketMatch 
                            ? 'border-indigo-500/30 bg-indigo-500/10' 
                            : 'border-white/5 bg-white/5'
                        }`}
                      >
                        <div className={`w-2 h-2 rounded-full ${member.isHost ? 'bg-indigo-400 shadow-md shadow-indigo-400/40' : 'bg-green-400 shadow-md shadow-green-400/40'} shrink-0`} />
                        <div className="truncate flex-1">
                          <p className="text-[11px] font-bold text-white truncate">{member.deviceName}</p>
                          <p className="text-[9px] text-white/40 font-mono truncate">
                            {member.isHost ? "👑 Master Node" : "🔊 Synced Node"}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="border-t border-white/5 pt-3.5 flex justify-between items-center text-[10px] text-white/50">
                  <span className="flex items-center gap-1 font-mono uppercase tracking-wider text-[9px] font-bold text-white/30">
                    <Clock className="w-3.5 h-3.5 text-blue-400" />
                    Latency: {Math.abs(clockOffset)}ms corrected
                  </span>
                  <button 
                    onClick={() => {
                      if (socket) socket.emit("request-resync");
                    }}
                    className="flex items-center gap-1 text-blue-400 font-extrabold uppercase tracking-wider text-[9px] hover:text-blue-300 transition-colors cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3 text-blue-400" />
                    Resync
                  </button>
                </div>
              </div>

              {/* Leaving room buttons */}
              <div className="text-center pt-2">
                <button 
                  onClick={() => {
                    if (audioRef.current) audioRef.current.pause();
                    setActiveRoom(null);
                  }}
                  className="px-5 py-2.5 rounded-full border border-white/5 text-white/40 hover:text-red-400 hover:bg-red-500/5 transition-colors cursor-pointer text-[10px] uppercase tracking-widest font-bold"
                >
                  Disconnect & Exit Room
                </button>
              </div>

            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Modern QR Code Modal popover */}
      <AnimatePresence>
        {showQrModal && activeRoom && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#0a0a0c]/90 border border-white/10 p-6 rounded-[32px] w-full max-w-xs text-center space-y-4 shadow-2xl backdrop-blur-2xl"
            >
              <div className="flex justify-between items-center pb-1">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white/40">Transmit Sound Link</h3>
                <button 
                  onClick={() => setShowQrModal(false)}
                  className="text-xs text-white/50 hover:text-white cursor-pointer font-bold font-mono"
                >
                  CLOSE
                </button>
              </div>

              <div className="bg-white p-2.5 rounded-2xl inline-block shadow-inner mx-auto">
                <img 
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(getShareUrl())}`}
                  alt={`SymphonSync Room QR Code - roomId ${activeRoom.roomId}`}
                  className="w-44 h-44 block"
                />
              </div>

              <div className="space-y-1">
                <p className="text-sm font-extrabold font-mono text-blue-400 tracking-wider">ROOM: {activeRoom.roomId}</p>
                <p className="text-[10px] text-white/50 px-2 leading-relaxed">
                  Hold another phone's camera up to join automatically, or send the URL to multiply your sound!
                </p>
              </div>

              <button 
                onClick={copyRoomLink}
                className="w-full py-2.5 bg-white/5 border border-white/10 hover:bg-white/10 text-white rounded-full text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {copySuccess ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-green-400" />
                    Copied link successfully
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-white/50" />
                    Copy invitation link
                  </>
                )}
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Screen Footer */}
      <footer className="py-4 border-t border-white/5 text-center text-[9px] text-white/30 tracking-widest font-mono mt-auto relative z-10 uppercase font-bold">
        <p>© 2026 SyncWave • Hyper-Sync Transmission • Phase Aligned</p>
      </footer>
    </div>
  );
}
