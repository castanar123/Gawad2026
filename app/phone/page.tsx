"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import { Peer, type DataConnection, type MediaConnection } from "peerjs";

type PhoneStatus = "ready" | "opening" | "pairing" | "connected" | "capturing" | "error";
type ImageCaptureLike = { takePhoto(settings?: Record<string, unknown>): Promise<Blob> };
type ImageCaptureConstructor = new (track: MediaStreamTrack) => ImageCaptureLike;

const PEER_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function blobFromVideo(video: HTMLVideoElement) {
  if (!video.videoWidth || !video.videoHeight) throw new Error("The phone camera is not ready yet.");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("The phone could not prepare this photo.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The phone could not encode this photo.")), "image/jpeg", 0.99);
  });
}

async function sendBlobInChunks(channel: DataConnection, requestId: string, blob: Blob) {
  channel.send(JSON.stringify({ type: "photo-start", requestId, size: blob.size, mime: blob.type || "image/jpeg" }));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 48 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    while ((channel.dataChannel?.bufferedAmount || 0) > 512 * 1024 && channel.open) await sleep(20);
    if (!channel.open) throw new Error("The booth connection was interrupted.");
    channel.send(bytes.slice(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  while ((channel.dataChannel?.bufferedAmount || 0) > 0 && channel.open) await sleep(20);
  channel.send(JSON.stringify({ type: "photo-end", requestId }));
}

export default function PhoneCameraPage() {
  const [room, setRoom] = useState("");
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<PhoneStatus>("ready");
  const [message, setMessage] = useState("Open your camera, then keep this page visible while the booth takes the photos.");
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [resolution, setResolution] = useState("");
  const [screenFlash, setScreenFlash] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const callRef = useRef<MediaConnection | null>(null);
  const senderRef = useRef<RTCRtpSender | null>(null);
  const channelRef = useRef<DataConnection | null>(null);
  const pairingRunRef = useRef(0);
  const facingModeRef = useRef<"environment" | "user">("environment");

  useEffect(() => {
    const loadPairingLink = () => {
      const params = new URLSearchParams(window.location.search);
      setRoom(params.get("room") || "");
      setSecret(params.get("secret") || "");
    };
    window.queueMicrotask(loadPairingLink);
  }, []);

  useEffect(() => () => {
    pairingRunRef.current += 1;
    channelRef.current?.close();
    callRef.current?.close();
    peerRef.current?.destroy();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const requestCamera = async (mode: "environment" | "user") => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot open a camera. Try current Chrome or Safari.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: mode },
        width: { ideal: 7680 },
        height: { ideal: 4320 },
      },
    });
    const video = videoRef.current;
    if (!video) throw new Error("The camera preview could not be opened.");
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    track.contentHint = "detail";
    const settings = track.getSettings();
    setResolution(settings.width && settings.height ? `${settings.width} × ${settings.height}` : "Native photo quality");
    return stream;
  };

  const setTorch = async (enabled: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return false;
    const capabilities = typeof track.getCapabilities === "function"
      ? track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean }
      : {} as MediaTrackCapabilities & { torch?: boolean };
    if (!capabilities.torch) return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: enabled } as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  };

  const capturePhoto = async (requestId: string, lightMode: "off" | "screen" | "torch") => {
    const channel = channelRef.current;
    const video = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!channel?.open || !video || !track) throw new Error("The phone camera is not connected.");
    setStatus("capturing");
    setMessage("Taking the full-quality photo…");
    let torchEnabled = false;
    try {
      if (lightMode === "torch") torchEnabled = await setTorch(true);
      if (lightMode === "screen" || (lightMode === "torch" && !torchEnabled)) setScreenFlash(true);
      await sleep(220);
      const ImageCaptureApi = (window as typeof window & { ImageCapture?: ImageCaptureConstructor }).ImageCapture;
      let photo: Blob;
      if (ImageCaptureApi) {
        try {
          photo = await new ImageCaptureApi(track).takePhoto();
        } catch {
          photo = await blobFromVideo(video);
        }
      } else {
        photo = await blobFromVideo(video);
      }
      setScreenFlash(false);
      if (torchEnabled) await setTorch(false);
      await sendBlobInChunks(channel, requestId, photo);
      setStatus("connected");
      setMessage(`Photo sent at ${resolution || "native camera quality"}. Keep the phone steady for the next shot.`);
    } catch (error) {
      setScreenFlash(false);
      if (torchEnabled) await setTorch(false);
      const errorMessage = error instanceof Error ? error.message : "The phone could not take the photo.";
      if (channel.open) channel.send(JSON.stringify({ type: "capture-error", requestId, message: errorMessage }));
      setStatus("error");
      setMessage(errorMessage);
    }
  };

  const connectChannel = (channel: DataConnection) => {
    channelRef.current = channel;
    channel.on("open", () => {
      setStatus("connected");
      setMessage("Connected to the booth. Keep this phone aimed at the guests—the booth controls the countdown and shutter.");
    });
    channel.on("close", () => {
      setStatus("error");
      setMessage("The booth disconnected. Reopen the QR link to pair again.");
    });
    channel.on("data", (data) => {
      if (typeof data !== "string") return;
      try {
        const command = JSON.parse(data) as { type?: string; requestId?: string; lightMode?: "off" | "screen" | "torch" };
        if (command.type === "capture" && command.requestId) void capturePhoto(command.requestId, command.lightMode || "off");
        if (command.type === "switch-camera") void switchPhoneCamera();
      } catch {
        // Ignore malformed control messages from a stale connection.
      }
    });
  };

  const startPhoneCamera = async () => {
    if (!room || !secret) {
      setStatus("error");
      setMessage("This pairing link is incomplete. Scan the QR code shown on the booth again.");
      return;
    }
    const run = pairingRunRef.current + 1;
    pairingRunRef.current = run;
    setStatus("opening");
    setMessage("Opening the highest-quality phone camera available…");
    try {
      const stream = await requestCamera(facingModeRef.current);
      streamRef.current = stream;
      setStatus("pairing");
      setMessage("Camera ready. Connecting securely to the booth…");

      const peer = new Peer({ config: PEER_CONFIG, debug: 1 });
      peerRef.current = peer;
      peer.on("open", () => {
        if (pairingRunRef.current !== run) return;
        const channel = peer.connect(room, { metadata: { secret }, reliable: true, serialization: "binary" });
        connectChannel(channel);
        const call = peer.call(room, stream, { metadata: { secret } });
        callRef.current = call;
        senderRef.current = call.peerConnection.getSenders().find((sender) => sender.track?.kind === "video") || null;
        call.on("error", () => {
          setStatus("error");
          setMessage("The phone live preview could not reach the booth. Keep both devices online and scan a new QR code.");
        });
        call.on("close", () => {
          if (peerRef.current?.destroyed) return;
          setStatus("error");
          setMessage("The booth ended the phone camera session.");
        });
      });
      peer.on("error", (error) => {
        if (pairingRunRef.current !== run) return;
        setStatus("error");
        setMessage(error.type === "network" ? "The pairing service is unreachable. Check this phone’s internet connection." : "The phone could not reach the booth. Scan a new QR code and try again.");
      });
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The phone camera could not connect.");
    }
  };

  const switchPhoneCamera = async () => {
    if (status === "opening" || status === "capturing") return;
    const nextMode = facingModeRef.current === "environment" ? "user" : "environment";
    setMessage("Switching phone camera…");
    try {
      const previousStream = streamRef.current;
      const nextStream = await requestCamera(nextMode);
      const nextTrack = nextStream.getVideoTracks()[0];
      await senderRef.current?.replaceTrack(nextTrack);
      streamRef.current = nextStream;
      previousStream?.getTracks().forEach((track) => track.stop());
      facingModeRef.current = nextMode;
      setFacingMode(nextMode);
      setStatus("connected");
      setMessage(`${nextMode === "environment" ? "Back" : "front"} camera is live at ${resolution || "native quality"}.`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The phone camera could not be switched.");
    }
  };

  const active = status !== "ready" && status !== "error";

  return (
    <main className={`phone-camera-page status-${status}`}>
      <header className="phone-camera-header">
        <span className="phone-brand-mark"><img src="/lspu-brand-source.png" alt="LSPU" /></span>
        <p><strong>Gawad Parangal</strong><small>PHONE CAMERA · ROOM {room ? room.slice(0, 8).toUpperCase() : "—"}</small></p>
      </header>
      <section className="phone-camera-stage">
        <video ref={videoRef} muted playsInline aria-label="Phone camera preview" />
        <div className="phone-camera-overlay" aria-hidden="true"><i /><i /><span>Keep guests inside the frame</span></div>
        {screenFlash && <div className="phone-screen-flash" />}
        {!active && (
          <div className="phone-camera-cover">
            <span className="phone-camera-symbol"><CameraGlyph /></span>
            <h1>Use this phone as the camera</h1>
            <p>{message}</p>
            <button type="button" onClick={startPhoneCamera}>Allow camera & connect</button>
            <small>For full-quality capture, use the back camera and keep this page open.</small>
          </div>
        )}
        {active && status !== "connected" && <div className="phone-connecting"><span className="spinner" /><strong>{status === "capturing" ? "Sending full-quality photo" : "Connecting to booth"}</strong></div>}
      </section>
      <footer className="phone-camera-footer">
        <div className="phone-status"><span className={status === "connected" ? "online" : ""} /><p><strong>{status === "connected" ? "Booth connected" : status === "capturing" ? "Capturing" : "Phone camera"}</strong><small>{message}</small></p></div>
        <button type="button" onClick={switchPhoneCamera} disabled={!active || status === "capturing"}><SwitchGlyph /> {facingMode === "environment" ? "Use front" : "Use back"}</button>
      </footer>
    </main>
  );
}

function CameraGlyph() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8.6 5.5 10 3.7h4l1.4 1.8H19a2 2 0 0 1 2 2v10.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2h3.6Z" /><circle cx="12" cy="12.6" r="4" /></svg>;
}

function SwitchGlyph() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 7h11l-3-3m3 3-3 3M17 17H6l3 3m-3-3 3-3" /></svg>;
}
