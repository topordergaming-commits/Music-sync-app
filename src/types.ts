export interface SpeakerMember {
  socketId: string;
  deviceName: string;
  isHost: boolean;
}

export interface SongInfo {
  url: string;
  title: string;
  artist: string;
  duration: number; // in seconds
  isCustom?: boolean;
}

export interface PlaybackState {
  status: "PLAYING" | "PAUSED";
  spot: number; // seconds offset elapsed
  anchor: number; // server timestamp in ms
}

export interface RoomState {
  roomId: string;
  songs: SongInfo[];
  currentSongIndex: number;
  playback: PlaybackState;
  members: SpeakerMember[];
}
