"use client";

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from "react";
import { zipSync } from "fflate";
import QRCode from "qrcode";

type Stage = "welcome" | "camera" | "review" | "sheet";
type CaptureLightMode = "off" | "screen" | "torch";
type CameraSource = "local" | "phone";
type PairingState = "idle" | "creating" | "waiting" | "connected" | "error";

type RemoteCameraSession = {
  id: string;
  token: string;
  link: string;
};

type RemotePhotoRequest = {
  requestId: string;
  chunks: ArrayBuffer[];
  mime: string;
  resolve: (photo: string) => void;
  reject: (error: Error) => void;
  timeout: number;
};

type PhotoGroup = {
  id: string;
  shots: string[];
  stripUrl: string;
  caption?: string;
};

type PersistedSession = {
  groups: PhotoGroup[];
  photos: (string | null)[];
  sheetUrl: string | null;
  stage: Stage;
  selectedPhotoIndex: number;
  autoPrint: boolean;
  stripCaption?: string;
  captureLightMode?: CaptureLightMode;
  updatedAt: number;
};

const TEMPLATE_URL = "/lspu-event-strip.png";
const SHOTS_PER_GROUP = 3;
const GROUPS_PER_SHEET = 4;
const COUNTDOWN_SECONDS = 10;
const A4_WIDTH = 2480;
const A4_HEIGHT = 3508;
const ENHANCED_WIDTH = 7680;
const ENHANCED_HEIGHT = 4320;
const SESSION_DATABASE = "gawad-parangal-photobooth";
const SESSION_STORE = "sessions";
const ACTIVE_SESSION_KEY = "active-sheet";
const PEER_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function openSessionDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SESSION_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SESSION_STORE)) request.result.createObjectStore(SESSION_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadPersistedSession() {
  if (typeof indexedDB === "undefined") return null;
  const database = await openSessionDatabase();
  return new Promise<PersistedSession | null>((resolve, reject) => {
    const transaction = database.transaction(SESSION_STORE, "readonly");
    const request = transaction.objectStore(SESSION_STORE).get(ACTIVE_SESSION_KEY);
    request.onsuccess = () => resolve((request.result as PersistedSession | undefined) ?? null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

async function savePersistedSession(session: PersistedSession) {
  if (typeof indexedDB === "undefined") return;
  const database = await openSessionDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(SESSION_STORE, "readwrite");
    transaction.objectStore(SESSION_STORE).put(session, ACTIVE_SESSION_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function clearPersistedSession() {
  if (typeof indexedDB === "undefined") return;
  const database = await openSessionDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(SESSION_STORE, "readwrite");
    transaction.objectStore(SESSION_STORE).delete(ACTIVE_SESSION_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

const CameraIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="M8.6 5.5 10 3.7h4l1.4 1.8H19a2 2 0 0 1 2 2v10.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2h3.6Z" />
    <circle cx="12" cy="12.6" r="4" />
  </svg>
);

const PhoneIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.2" />
    <path d="M10 5h4M11 18.5h2" />
  </svg>
);

const RetryIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4.5 8.5V4m0 0H9M4.5 4l3 3a7 7 0 1 1-1.3 8.2" /></svg>
);

const PrinterIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z" /><path d="M17.5 12h.01" /></svg>
);

const DownloadIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 20h16" /></svg>
);

const SwitchCameraIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M7 7h11l-3-3m3 3-3 3M17 17H6l3 3m-3-3 3-3" /></svg>
);

const FlashIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m13.5 2-7 11h5l-1 9 7-12h-5l1-8Z" /></svg>
);

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function waitForIceGathering(peer: RTCPeerConnection, timeout = 6500) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      peer.removeEventListener("icegatheringstatechange", checkState);
      window.clearTimeout(timer);
      resolve();
    };
    const checkState = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timer = window.setTimeout(finish, timeout);
    peer.addEventListener("icegatheringstatechange", checkState);
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error("The phone photo could not be read."));
    reader.readAsDataURL(blob);
  });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("An image could not be prepared for printing."));
    image.src = source;
  });
}

function drawImageCover(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource & { width: number; height: number },
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.max(width / image.width, height / image.height);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.width - sourceWidth) / 2;
  const sourceY = (image.height - sourceHeight) / 2;
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

async function composeStrip(shots: string[], stripCaption = "") {
  const [template, ...photos] = await Promise.all([loadImage(TEMPLATE_URL), ...shots.map(loadImage)]);
  const canvas = document.createElement("canvas");
  canvas.width = template.naturalWidth;
  canvas.height = template.naturalHeight;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser cannot create the photo strip.");

  context.fillStyle = "#fffaf0";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(template, 0, 0, canvas.width, canvas.height);

  const slots = [
    { x: 137, y: 569, width: 1802, height: 1115 },
    { x: 137, y: 1888, width: 1802, height: 1115 },
    { x: 151, y: 3200, width: 1825, height: 1115 },
  ];

  photos.forEach((photo, index) => {
    const slot = slots[index];
    context.save();
    context.beginPath();
    context.roundRect(slot.x, slot.y, slot.width, slot.height, 14);
    context.clip();
    context.filter = "brightness(1.025) contrast(1.055) saturate(1.06)";
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    drawImageCover(context, photo, slot.x, slot.y, slot.width, slot.height);
    context.restore();
  });

  const caption = stripCaption.trim();
  if (caption) {
    const maxWidth = 1500;
    let fontSize = 58;
    context.save();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `700 ${fontSize}px Arial, Helvetica, sans-serif`;
    while (context.measureText(caption).width > maxWidth && fontSize > 30) {
      fontSize -= 2;
      context.font = `700 ${fontSize}px Arial, Helvetica, sans-serif`;
    }
    context.lineWidth = 10;
    context.strokeStyle = "rgba(255, 250, 240, .94)";
    context.fillStyle = "#071a3b";
    context.strokeText(caption, canvas.width / 2, 505, maxWidth);
    context.fillText(caption, canvas.width / 2, 505, maxWidth);
    context.restore();
  }

  return canvas.toDataURL("image/jpeg", 0.97);
}

async function composeA4(groups: PhotoGroup[]) {
  const strips = await Promise.all(groups.slice(0, GROUPS_PER_SHEET).map((group) => loadImage(group.stripUrl)));
  const canvas = document.createElement("canvas");
  canvas.width = A4_WIDTH;
  canvas.height = A4_HEIGHT;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser cannot create the A4 sheet.");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, A4_WIDTH, A4_HEIGHT);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  const sideMargin = 40;
  const columnGap = 10;
  const stripWidth = (A4_WIDTH - sideMargin * 2 - columnGap * 2) / 3;
  const stripHeight = stripWidth * (6400 / 2131);
  const rowGap = 26;
  const contentHeight = stripHeight + rowGap + stripWidth;
  const topMargin = (A4_HEIGHT - contentHeight) / 2;

  strips.slice(0, 3).forEach((strip, index) => {
    const x = sideMargin + index * (stripWidth + columnGap);
    context.drawImage(strip, x, topMargin, stripWidth, stripHeight);
  });

  const lastStrip = strips[3];
  if (lastStrip) {
    const landscapeY = topMargin + stripHeight + rowGap;
    context.save();
    context.translate(sideMargin + stripHeight, landscapeY);
    context.rotate(Math.PI / 2);
    context.drawImage(lastStrip, 0, 0, stripWidth, stripHeight);
    context.restore();
  }

  return canvas.toDataURL("image/jpeg", 0.985);
}

function buildPdfFromJpeg(dataUrl: string) {
  const encoded = dataUrl.split(",")[1];
  const binary = atob(encoded);
  const jpeg = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) jpeg[index] = binary.charCodeAt(index);

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let byteLength = 0;
  const append = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    byteLength += bytes.length;
  };

  append("%PDF-1.4\n% Gawad Parangal Photo Booth\n");
  offsets[1] = byteLength;
  append("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets[2] = byteLength;
  append("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offsets[3] = byteLength;
  append("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n");
  offsets[4] = byteLength;
  append(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${A4_WIDTH} /Height ${A4_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  append(jpeg);
  append("\nendstream\nendobj\n");
  const pageDrawing = "q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ\n";
  offsets[5] = byteLength;
  append(`5 0 obj\n<< /Length ${encoder.encode(pageDrawing).length} >>\nstream\n${pageDrawing}endstream\nendobj\n`);

  const xrefOffset = byteLength;
  append("xref\n0 6\n0000000000 65535 f \n");
  for (let index = 1; index <= 5; index += 1) append(`${offsets[index].toString().padStart(10, "0")} 00000 n \n`);
  append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return new Blob(chunks as BlobPart[], { type: "application/pdf" });
}

function saveBlob(blob: Blob, filename: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function dataUrlToBytes(dataUrl: string) {
  const encoded = dataUrl.split(",")[1];
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function saveShotBackup(shots: string[], stripUrl: string, groupNumber: number) {
  const files = shots.reduce<Record<string, Uint8Array>>((backupFiles, shot, index) => {
    backupFiles[`shot-${String(index + 1).padStart(2, "0")}.jpg`] = dataUrlToBytes(shot);
    return backupFiles;
  }, {});
  files["completed-event-strip.jpg"] = dataUrlToBytes(stripUrl);
  const zipped = zipSync(files, { level: 0 });
  const filename = `gawad-parangal-group-${String(groupNumber).padStart(2, "0")}-original-shots.zip`;
  saveBlob(new Blob([zipped], { type: "application/zip" }), filename);
}

function saveDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export default function Home() {
  const [stage, setStage] = useState<Stage>("welcome");
  const [groups, setGroups] = useState<PhotoGroup[]>([]);
  const [photos, setPhotos] = useState<(string | null)[]>([null, null, null]);
  const [shotIndex, setShotIndex] = useState(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [sequenceRunning, setSequenceRunning] = useState(false);
  const [cameraState, setCameraState] = useState<"idle" | "starting" | "ready" | "error">("idle");
  const [cameraMessage, setCameraMessage] = useState("");
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [activeCameraId, setActiveCameraId] = useState("");
  const [mirrorCamera, setMirrorCamera] = useState(true);
  const [cameraOperation, setCameraOperation] = useState<"reset" | "switch" | null>(null);
  const [cameraResolution, setCameraResolution] = useState("");
  const [flash, setFlash] = useState(false);
  const [captureLightMode, setCaptureLightMode] = useState<CaptureLightMode>("screen");
  const [torchSupported, setTorchSupported] = useState(false);
  const [betweenShots, setBetweenShots] = useState(false);
  const [paused, setPaused] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [reviewStripUrl, setReviewStripUrl] = useState<string | null>(null);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0);
  const [autoPrint, setAutoPrint] = useState(true);
  const [stripCaption, setStripCaption] = useState("");
  const [layoutMessage, setLayoutMessage] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [expandedPreview, setExpandedPreview] = useState<{ src: string; alt: string } | null>(null);
  const [cameraSource, setCameraSource] = useState<CameraSource>("local");
  const [pairingState, setPairingState] = useState<PairingState>("idle");
  const [pairingMessage, setPairingMessage] = useState("");
  const [phoneSession, setPhoneSession] = useState<RemoteCameraSession | null>(null);
  const [phoneQrCode, setPhoneQrCode] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraSourceRef = useRef<CameraSource>("local");
  const remotePeerRef = useRef<RTCPeerConnection | null>(null);
  const remoteChannelRef = useRef<RTCDataChannel | null>(null);
  const remoteSessionRef = useRef<RemoteCameraSession | null>(null);
  const remotePhotoRef = useRef<RemotePhotoRequest | null>(null);
  const pairingRunRef = useRef(0);
  const runTokenRef = useRef(0);
  const pausedRef = useRef(false);
  const captureNowRef = useRef(false);

  const closePhoneCamera = useCallback((notifyServer = true) => {
    pairingRunRef.current += 1;
    const session = remoteSessionRef.current;
    if (notifyServer && session) {
      void fetch(`/api/remote-camera/session/${session.id}`, {
        method: "DELETE",
        headers: { "x-camera-token": session.token },
      }).catch(() => undefined);
    }
    if (remotePhotoRef.current) {
      window.clearTimeout(remotePhotoRef.current.timeout);
      remotePhotoRef.current.reject(new Error("The phone camera disconnected before the photo arrived."));
      remotePhotoRef.current = null;
    }
    remoteChannelRef.current?.close();
    remotePeerRef.current?.close();
    remoteChannelRef.current = null;
    remotePeerRef.current = null;
    remoteSessionRef.current = null;
    setPhoneSession(null);
    setPhoneQrCode("");
    setPairingState("idle");
    setPairingMessage("");
    setLinkCopied(false);
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    closePhoneCamera();
    setFlash(false);
    setTorchSupported(false);
    setCameraState("idle");
  }, [closePhoneCamera]);

  useEffect(() => () => {
    runTokenRef.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    closePhoneCamera();
  }, [closePhoneCamera]);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadPersistedSession().then((savedSession) => {
      if (!active || !savedSession) return;
      setGroups(savedSession.groups);
      setPhotos(savedSession.photos);
      setSheetUrl(savedSession.sheetUrl);
      setSelectedPhotoIndex(savedSession.selectedPhotoIndex);
      setAutoPrint(savedSession.autoPrint);
      setStripCaption(savedSession.stripCaption ?? "");
      setCaptureLightMode(savedSession.captureLightMode ?? "screen");
      if (savedSession.groups.length > 0 && savedSession.sheetUrl && savedSession.stage === "sheet") setStage("sheet");
      else if (savedSession.photos.every(Boolean)) setStage("review");
      else setStage("welcome");
    }).catch(() => undefined).finally(() => {
      if (active) setSessionLoaded(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!sessionLoaded) return;
    void savePersistedSession({ groups, photos, sheetUrl, stage, selectedPhotoIndex, autoPrint, stripCaption, captureLightMode, updatedAt: Date.now() }).catch(() => undefined);
  }, [autoPrint, captureLightMode, groups, photos, selectedPhotoIndex, sessionLoaded, sheetUrl, stage, stripCaption]);

  useEffect(() => {
    if (!expandedPreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedPreview(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expandedPreview]);

  const waitForVideo = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (videoRef.current) return videoRef.current;
      await sleep(50);
    }
    throw new Error("The camera preview could not be opened.");
  };

  const attachCamera = async () => {
    const video = await waitForVideo();
    if (streamRef.current) {
      video.srcObject = streamRef.current;
      await video.play();
    }
    return video;
  };

  useEffect(() => {
    const video = videoRef.current;
    const stream = streamRef.current;
    if (stage === "camera" && video && stream) {
      video.srcObject = stream;
      void video.play();
    }
  }, [stage]);

  const openConnectedPhoneBooth = async () => {
    setPairingState("connected");
    setPairingMessage("Phone connected. Opening the live camera…");
    setStage("camera");
    setCameraState("starting");
    setCameraMessage("Connecting the phone camera…");
    setMirrorCamera(false);
    setTorchSupported(true);
    for (let attempt = 0; attempt < 60 && !streamRef.current; attempt += 1) await sleep(100);
    if (!streamRef.current) {
      setCameraState("error");
      setCameraMessage("The phone connected, but its live camera feed did not arrive. Reconnect the phone camera.");
      return;
    }
    try {
      const video = await attachCamera();
      const settings = streamRef.current.getVideoTracks()[0]?.getSettings();
      const width = settings?.width || video.videoWidth;
      const height = settings?.height || video.videoHeight;
      setCameraResolution(width && height ? `${width} × ${height} phone preview` : "Phone camera · full-quality stills");
      setCameraState("ready");
      setCameraMessage("");
    } catch (error) {
      setCameraState("error");
      setCameraMessage(error instanceof Error ? error.message : "The phone preview could not be opened.");
    }
  };

  const connectRemoteChannel = (channel: RTCDataChannel) => {
    remoteChannelRef.current = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      const session = remoteSessionRef.current;
      if (session) {
        void fetch(`/api/remote-camera/session/${session.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-camera-token": session.token },
          body: JSON.stringify({ role: "booth", status: "connected" }),
        }).catch(() => undefined);
      }
      void openConnectedPhoneBooth();
    };
    channel.onclose = () => {
      if (!remoteSessionRef.current) return;
      setCameraState("error");
      setCameraMessage("The phone camera disconnected. Exit and scan a new QR code to reconnect.");
    };
    channel.onmessage = (event) => {
      const pending = remotePhotoRef.current;
      if (typeof event.data !== "string") {
        if (pending && event.data instanceof ArrayBuffer) pending.chunks.push(event.data);
        return;
      }
      try {
        const message = JSON.parse(event.data) as { type?: string; requestId?: string; mime?: string; message?: string };
        if (!pending || message.requestId !== pending.requestId) return;
        if (message.type === "photo-start") {
          pending.chunks = [];
          pending.mime = message.mime || "image/jpeg";
        } else if (message.type === "photo-end") {
          window.clearTimeout(pending.timeout);
          remotePhotoRef.current = null;
          const blob = new Blob(pending.chunks, { type: pending.mime });
          void blobToDataUrl(blob).then(pending.resolve, pending.reject);
        } else if (message.type === "capture-error") {
          window.clearTimeout(pending.timeout);
          remotePhotoRef.current = null;
          pending.reject(new Error(message.message || "The phone could not take the photo."));
        }
      } catch {
        // Ignore messages from an obsolete or malformed pairing session.
      }
    };
  };

  const startPhonePairing = async (resumeSession = false) => {
    closePhoneCamera();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    cameraSourceRef.current = "phone";
    setCameraSource("phone");
    if (!resumeSession) setPhotos([null, null, null]);
    setReviewStripUrl(null);
    const firstMissingShot = photos.findIndex((photo) => !photo);
    setSelectedPhotoIndex(resumeSession && firstMissingShot > -1 ? firstMissingShot : 0);
    setShotIndex(resumeSession && firstMissingShot > -1 ? firstMissingShot : 0);
    setCountdown(null);
    setPairingState("creating");
    setPairingMessage("Creating a private phone-camera link…");
    setLinkCopied(false);
    const run = pairingRunRef.current + 1;
    pairingRunRef.current = run;

    try {
      const createResponse = await fetch("/api/remote-camera/session", { method: "POST" });
      const created = await createResponse.json() as { id?: string; token?: string; error?: string };
      if (!createResponse.ok || !created.id || !created.token) throw new Error(created.error || "The phone pairing link could not be created.");
      if (pairingRunRef.current !== run) return;

      const link = `${window.location.origin}/phone?room=${encodeURIComponent(created.id)}&token=${encodeURIComponent(created.token)}`;
      const session = { id: created.id, token: created.token, link };
      remoteSessionRef.current = session;
      setPhoneSession(session);
      setPhoneQrCode(await QRCode.toDataURL(link, { width: 320, margin: 1, errorCorrectionLevel: "M", color: { dark: "#071a3b", light: "#fffaf0" } }));
      setPairingState("waiting");
      setPairingMessage("Scan the QR code with the phone, then tap “Allow camera & connect.”");

      const peer = new RTCPeerConnection(PEER_CONFIG);
      remotePeerRef.current = peer;
      peer.addTransceiver("video", { direction: "recvonly" });
      peer.ontrack = (event) => {
        const remoteStream = event.streams[0] || new MediaStream([event.track]);
        streamRef.current = remoteStream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = remoteStream;
          void video.play();
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") {
          setPairingState("error");
          setPairingMessage("The direct phone connection failed. Keep both devices online and create a new link.");
        }
      };
      connectRemoteChannel(peer.createDataChannel("gawad-camera", { ordered: true }));
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIceGathering(peer);

      const offerResponse = await fetch(`/api/remote-camera/session/${session.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-camera-token": session.token },
        body: JSON.stringify({ role: "booth", offer: peer.localDescription, status: "waiting" }),
      });
      if (!offerResponse.ok) throw new Error("The private phone-camera session could not be prepared.");

      let answer: RTCSessionDescriptionInit | null = null;
      for (let attempt = 0; attempt < 120 && pairingRunRef.current === run; attempt += 1) {
        const response = await fetch(`/api/remote-camera/session/${session.id}`, {
          headers: { "x-camera-token": session.token },
          cache: "no-store",
        });
        if (!response.ok) throw new Error("The pairing link expired. Create a new phone connection.");
        const signal = await response.json() as { answer?: RTCSessionDescriptionInit | null };
        if (signal.answer) {
          answer = signal.answer;
          break;
        }
        await sleep(750);
      }
      if (!answer || pairingRunRef.current !== run) throw new Error("The phone did not join before the pairing link timed out.");
      await peer.setRemoteDescription(answer);
      setPairingMessage("Phone camera found. Establishing the full-quality photo channel…");
    } catch (error) {
      if (pairingRunRef.current !== run) return;
      setPairingState("error");
      setPairingMessage(error instanceof Error ? error.message : "The phone camera could not be paired.");
    }
  };

  const copyPhoneLink = async () => {
    if (!phoneSession) return;
    try {
      await navigator.clipboard.writeText(phoneSession.link);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1800);
    } catch {
      setPairingMessage("Select and copy the link below, then open it on the phone.");
    }
  };

  const sharePhoneLink = async () => {
    if (!phoneSession) return;
    if (navigator.share) {
      await navigator.share({ title: "Gawad Parangal phone camera", text: `Connect phone camera · Room ${phoneSession.id}`, url: phoneSession.link }).catch(() => undefined);
    } else {
      await copyPhoneLink();
    }
  };

  useEffect(() => {
    if (stage !== "review") return;
    const completedShots = photos.filter((photo): photo is string => Boolean(photo));
    if (completedShots.length !== SHOTS_PER_GROUP) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void composeStrip(completedShots, stripCaption).then((strip) => {
        if (active) setReviewStripUrl(strip);
      }).catch((error) => {
        if (active) setCameraMessage(error instanceof Error ? error.message : "The strip preview could not be prepared.");
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [photos, stage, stripCaption]);

  const ensureCamera = async (deviceId?: string) => {
    cameraSourceRef.current = "local";
    setCameraSource("local");
    setCameraState("starting");
    setCameraMessage("Opening the camera…");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is not supported in this browser.");
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "user" } }),
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30 },
        },
      });
      streamRef.current = stream;
      const video = await attachCamera();
      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack.getSettings();
      const capabilities = typeof videoTrack.getCapabilities === "function"
        ? videoTrack.getCapabilities() as MediaTrackCapabilities & { torch?: boolean }
        : {} as MediaTrackCapabilities & { torch?: boolean };
      const supportsTorch = capabilities.torch === true;
      setTorchSupported(supportsTorch);
      setCaptureLightMode((currentMode) => currentMode === "torch" && !supportsTorch ? "screen" : currentMode);
      videoTrack.contentHint = "detail";
      const videoDevices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
      setCameras(videoDevices);
      setActiveCameraId(settings.deviceId || deviceId || "");
      setMirrorCamera(settings.facingMode !== "environment");
      const width = settings.width || video.videoWidth;
      const height = settings.height || video.videoHeight;
      setCameraResolution(width && height ? `${width} × ${height}` : "Native resolution");
      setCameraState("ready");
      setCameraMessage("");
      return true;
    } catch (error) {
      setCameraState("error");
      setCameraMessage(error instanceof Error ? error.message : "Please allow camera access and try again.");
      return false;
    }
  };

  const openBooth = async (resumeSession = false) => {
    closePhoneCamera();
    cameraSourceRef.current = "local";
    setCameraSource("local");
    setStage("camera");
    if (!resumeSession) setPhotos([null, null, null]);
    setReviewStripUrl(null);
    const firstMissingShot = photos.findIndex((photo) => !photo);
    setSelectedPhotoIndex(resumeSession && firstMissingShot > -1 ? firstMissingShot : 0);
    setShotIndex(resumeSession && firstMissingShot > -1 ? firstMissingShot : 0);
    setCountdown(null);
    await sleep(50);
    await ensureCamera();
  };

  const resetCamera = async () => {
    if (sequenceRunning) return;
    if (cameraSourceRef.current === "phone") {
      setCameraMessage("The phone camera is connected. Use Switch camera to change between its front and back lenses.");
      return;
    }
    setCameraOperation("reset");
    await ensureCamera(activeCameraId || undefined);
    setCameraOperation(null);
  };

  const switchCamera = async () => {
    if (sequenceRunning) return;
    if (cameraSourceRef.current === "phone") {
      const channel = remoteChannelRef.current;
      if (channel?.readyState !== "open") {
        setCameraMessage("The phone camera is not connected.");
        return;
      }
      setCameraOperation("switch");
      channel.send(JSON.stringify({ type: "switch-camera" }));
      setCameraMessage("The phone is switching between its front and back cameras…");
      window.setTimeout(() => {
        setCameraOperation(null);
        setCameraMessage("");
      }, 1800);
      return;
    }
    if (cameras.length < 2) return;
    const activeIndex = cameras.findIndex((camera) => camera.deviceId === activeCameraId);
    const nextCamera = cameras[(activeIndex + 1 + cameras.length) % cameras.length];
    setCameraOperation("switch");
    await ensureCamera(nextCamera.deviceId);
    setCameraOperation(null);
  };

  const captureFrame = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) throw new Error("The camera is not ready yet.");
    const canvas = document.createElement("canvas");
    const enhancementScale = Math.max(1, Math.min(ENHANCED_WIDTH / video.videoWidth, ENHANCED_HEIGHT / video.videoHeight));
    canvas.width = Math.round(video.videoWidth * enhancementScale);
    canvas.height = Math.round(video.videoHeight * enhancementScale);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("The photo could not be captured.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.filter = "brightness(1.025) contrast(1.06) saturate(1.065)";
    if (mirrorCamera) {
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.985);
  };

  const capturePhonePhoto = () => {
    const channel = remoteChannelRef.current;
    if (!channel || channel.readyState !== "open") return Promise.reject(new Error("The phone camera is no longer connected."));
    if (remotePhotoRef.current) return Promise.reject(new Error("The previous phone photo is still transferring."));
    return new Promise<string>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = window.setTimeout(() => {
        if (remotePhotoRef.current?.requestId === requestId) remotePhotoRef.current = null;
        reject(new Error("The full-quality phone photo took too long to arrive. Keep the phone page open and try again."));
      }, 45000);
      remotePhotoRef.current = { requestId, chunks: [], mime: "image/jpeg", resolve, reject, timeout };
      channel.send(JSON.stringify({ type: "capture", requestId, lightMode: captureLightMode }));
    });
  };

  const captureCurrentFrame = async () => cameraSourceRef.current === "phone" ? capturePhonePhoto() : captureFrame();

  const waitForActiveDelay = async (milliseconds: number, token: number, allowInstantCapture = false) => {
    let remaining = milliseconds;
    while (remaining > 0) {
      if (runTokenRef.current !== token) return "cancelled" as const;
      if (allowInstantCapture && captureNowRef.current) {
        captureNowRef.current = false;
        return "capture-now" as const;
      }
      if (pausedRef.current) {
        await sleep(120);
        continue;
      }
      const interval = Math.min(remaining, 120);
      await sleep(interval);
      remaining -= interval;
    }
    return runTokenRef.current === token ? "complete" as const : "cancelled" as const;
  };

  const togglePause = () => {
    const nextPaused = !pausedRef.current;
    pausedRef.current = nextPaused;
    setPaused(nextPaused);
  };

  const captureImmediately = () => {
    captureNowRef.current = true;
    pausedRef.current = false;
    setPaused(false);
  };

  const setCameraTorch = async (enabled: boolean) => {
    if (cameraSourceRef.current === "phone") return false;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || !torchSupported) return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: enabled } as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  };

  const activateCaptureLight = async () => {
    if (cameraSourceRef.current === "phone") return;
    if (captureLightMode === "off") return;
    if (captureLightMode === "torch" && await setCameraTorch(true)) {
      await sleep(180);
      return;
    }
    setFlash(true);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    await sleep(150);
  };

  const deactivateCaptureLight = async () => {
    if (cameraSourceRef.current === "phone") {
      setFlash(false);
      return;
    }
    if (captureLightMode === "torch") await setCameraTorch(false);
    setFlash(false);
  };

  const cycleCaptureLight = () => {
    if (sequenceRunning) return;
    const availableModes: CaptureLightMode[] = torchSupported ? ["screen", "torch", "off"] : ["screen", "off"];
    setCaptureLightMode((currentMode) => {
      const currentIndex = availableModes.indexOf(currentMode);
      return availableModes[(currentIndex + 1 + availableModes.length) % availableModes.length];
    });
  };

  const runSequence = async (indices: number[]) => {
    if (cameraSourceRef.current === "phone") {
      if (remoteChannelRef.current?.readyState !== "open" || !streamRef.current) {
        setCameraState("error");
        setCameraMessage("The phone camera is not connected. Exit and scan a new pairing QR code.");
        return;
      }
    } else if (!streamRef.current && !(await ensureCamera())) return;
    setReviewStripUrl(null);
    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
    captureNowRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setSequenceRunning(true);
    setCameraMessage("");
    const workingPhotos = [...photos];

    try {
      for (let position = 0; position < indices.length; position += 1) {
        const targetIndex = indices[position];
        setShotIndex(targetIndex);
        setBetweenShots(false);
        for (let value = COUNTDOWN_SECONDS; value >= 1; value -= 1) {
          if (runTokenRef.current !== token) return;
          setCountdown(value);
          const countdownResult = await waitForActiveDelay(1000, token, true);
          if (countdownResult === "cancelled") return;
          if (countdownResult === "capture-now") break;
        }
        if (runTokenRef.current !== token) return;
        setCountdown(null);
        await activateCaptureLight();
        if (runTokenRef.current !== token) return;
        const captured = await captureCurrentFrame();
        workingPhotos[targetIndex] = captured;
        setPhotos([...workingPhotos]);
        await sleep(180);
        await deactivateCaptureLight();

        if (position < indices.length - 1) {
          setBetweenShots(true);
          if (await waitForActiveDelay(1250, token) === "cancelled") return;
        }
      }
      if (runTokenRef.current === token) setStage("review");
    } catch (error) {
      setCameraMessage(error instanceof Error ? error.message : "The shot could not be captured.");
    } finally {
      await deactivateCaptureLight();
      if (runTokenRef.current === token) {
        pausedRef.current = false;
        setPaused(false);
        setCountdown(null);
        setBetweenShots(false);
        setSequenceRunning(false);
      }
    }
  };

  const retakeShot = async (index: number) => {
    setStage("camera");
    await sleep(50);
    await attachCamera();
    await runSequence([index]);
  };

  const cancelCapture = () => {
    runTokenRef.current += 1;
    captureNowRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setSequenceRunning(false);
    setCountdown(null);
    setBetweenShots(false);
    setPhotos([null, null, null]);
    setStripCaption("");
    stopCamera();
    setStage("welcome");
  };

  const approveGroup = async () => {
    const completedShots = photos.filter((photo): photo is string => Boolean(photo));
    if (completedShots.length !== SHOTS_PER_GROUP) return;
    setIsComposing(true);
    setBackupMessage("");
    setLayoutMessage("Building your high-resolution event strip...");
    try {
      const stripUrl = await composeStrip(completedShots, stripCaption);
      setLayoutMessage("Saving three enhanced photos and the completed strip...");
      saveShotBackup(completedShots, stripUrl, groups.length + 1);
      setBackupMessage(`Group ${groups.length + 1} enhanced photos and completed strip downloaded to this device.`);
      const nextGroup: PhotoGroup = {
        id: `${Date.now()}-${groups.length}`,
        shots: completedShots,
        stripUrl,
        caption: stripCaption.trim(),
      };
      const nextGroups = [...groups, nextGroup];
      setGroups(nextGroups);
      setSheetUrl(null);
      stopCamera();

      if (nextGroups.length === GROUPS_PER_SHEET) {
        setStage("sheet");
        setLayoutMessage("Arranging four groups on one A4 sheet…");
        const finalSheet = await composeA4(nextGroups);
        setSheetUrl(finalSheet);
        setLayoutMessage("");
        if (autoPrint) {
          setTimeout(() => window.print(), 650);
        }
      } else {
        setPhotos([null, null, null]);
        setStripCaption("");
        setShotIndex(0);
        setStage("welcome");
        setLayoutMessage("");
      }
    } catch (error) {
      setLayoutMessage(error instanceof Error ? error.message : "The print layout could not be prepared.");
    } finally {
      setIsComposing(false);
    }
  };

  const deleteGroup = (index: number) => {
    const nextGroups = groups.filter((_, groupIndex) => groupIndex !== index);
    setGroups(nextGroups);
    setSheetUrl(null);
    setLayoutMessage("");
    if (stage === "sheet") setStage("welcome");
  };

  const downloadPdf = () => {
    if (!sheetUrl) return;
    saveBlob(buildPdfFromJpeg(sheetUrl), "gawad-parangal-photo-strips-a4.pdf");
  };

  const printCurrentGroups = async () => {
    if (groups.length === 0 || isComposing) return;
    setIsComposing(true);
    setLayoutMessage(`Arranging ${groups.length} saved group${groups.length === 1 ? "" : "s"} on A4...`);
    try {
      const currentSheet = await composeA4(groups);
      setSheetUrl(currentSheet);
      setStage("sheet");
      setLayoutMessage("");
      setTimeout(() => window.print(), 650);
    } catch (error) {
      setLayoutMessage(error instanceof Error ? error.message : "The current A4 sheet could not be prepared.");
    } finally {
      setIsComposing(false);
    }
  };

  const continueAddingGroups = () => {
    setSheetUrl(null);
    setLayoutMessage("");
    setStage("welcome");
  };

  const startNewSheet = () => {
    void clearPersistedSession();
    setGroups([]);
    setPhotos([null, null, null]);
    setStripCaption("");
    setSheetUrl(null);
    setLayoutMessage("");
    setStage("welcome");
  };

  const progressText = groups.length === 0
    ? "A new A4 sheet is ready"
    : `${groups.length} of ${GROUPS_PER_SHEET} groups ready`;
  const captureLightLabel = captureLightMode === "torch" ? "Camera torch" : captureLightMode === "screen" ? "Screen flash" : "Flash off";

  return (
    <>
      <main className={`site-shell stage-${stage}`}>
        <header className="topbar no-print">
          <button className="brand" type="button" onClick={() => !sequenceRunning && setStage("welcome")} aria-label="Gawad Parangal Photo Booth home">
            <span className="brand-mark"><img className="lspu-logo-source" src="/lspu-brand-source.png" alt="" /></span>
            <span><strong>Gawad Parangal</strong><small>PHOTO BOOTH</small></span>
          </button>
          <div className="topbar-actions">
            <div className="sheet-progress"><span>{groups.length}</span><i>of {GROUPS_PER_SHEET}</i><b>{progressText}</b></div>
          </div>
        </header>

        {stage === "welcome" && (
          <section className="hero no-print">
            <div className="hero-copy">
              <p className="eyebrow"><span /> 5th Gawad Parangal</p>
              <h1>Your moment.<br /><em>Beautifully framed.</em></h1>
              <p className="lede">Three photos, one elegant event strip. Step in, smile, and we’ll take care of the rest.</p>
              <div className="capture-card">
                <div className="shot-count"><strong>3</strong><span>shots</span></div>
                <div className="capture-rule" />
                <div className="shot-count"><strong>10</strong><span>second timer</span></div>
                <button type="button" className="start-button" onClick={() => openBooth(photos.some(Boolean))}>
                  <span><CameraIcon /></span> {photos.some(Boolean) ? "Resume saved group" : groups.length ? `Capture group ${groups.length + 1}` : "Start photo session"} <b>→</b>
                </button>
              </div>
              <div className="phone-camera-entry">
                <button type="button" onClick={() => startPhonePairing(photos.some(Boolean))}><PhoneIcon /> <span><strong>Use phone camera</strong><small>Backup camera · scan QR or share a link</small></span><b>→</b></button>
              </div>
              <p className="privacy-note"><span>●</span> Full-quality shots auto-save on this device until a new sheet starts. Each approved group downloads the three photos plus its completed strip.</p>

              {groups.length > 0 && (
                <div className="group-queue" aria-label="Groups ready for printing">
                  <div className="queue-heading"><span>Current A4 sheet</span><strong>{GROUPS_PER_SHEET - groups.length} group{GROUPS_PER_SHEET - groups.length === 1 ? "" : "s"} to go</strong></div>
                  <div className="queue-strips">
                    {Array.from({ length: GROUPS_PER_SHEET }).map((_, index) => (
                      <div className={`queue-slot ${groups[index] ? "filled" : ""}`} key={index}>
                        {groups[index] ? <img src={groups[index].stripUrl} alt={`Completed group ${index + 1}`} /> : <span>{index + 1}</span>}
                        {groups[index] && <button type="button" onClick={() => deleteGroup(index)} aria-label={`Remove group ${index + 1}`}>×</button>}
                      </div>
                    ))}
                  </div>
                  <button type="button" className="print-current-sheet" onClick={printCurrentGroups} disabled={isComposing}>
                    {isComposing ? <><span className="spinner small" /> {layoutMessage}</> : <><PrinterIcon /> Print {groups.length} saved group{groups.length === 1 ? "" : "s"} now</>}
                  </button>
                </div>
              )}
            </div>

            <div className="strip-stage" aria-label="Event strip preview">
              <div className="gold-orbit orbit-one" />
              <div className="gold-orbit orbit-two" />
              <div className="strip-wrap">
                <img src="/lspu-event-strip.png" alt="Gawad Parangal photo strip template with three photo spaces" />
                <div className="photo-sample sample-one"><span>01</span></div>
                <div className="photo-sample sample-two"><span>02</span></div>
                <div className="photo-sample sample-three"><span>03</span></div>
              </div>
              <div className="ready-badge thank-you-badge"><strong>Thank you for coming</strong></div>
            </div>
          </section>
        )}

        {stage === "welcome" && pairingState !== "idle" && (
          <div className="phone-pairing-backdrop no-print" role="dialog" aria-modal="true" aria-labelledby="phone-pairing-title">
            <section className="phone-pairing-card">
              <button type="button" className="pairing-close" onClick={() => closePhoneCamera()} aria-label="Close phone camera pairing">×</button>
              <div className="pairing-heading">
                <span><PhoneIcon /></span>
                <div><p>Backup camera</p><h2 id="phone-pairing-title">Connect a phone camera</h2></div>
              </div>
              <div className="pairing-content">
                <div className="pairing-qr">
                  {phoneQrCode ? <img src={phoneQrCode} alt={`QR code for phone camera room ${phoneSession?.id || ""}`} /> : <span className="spinner" />}
                  {phoneSession && <strong>ROOM {phoneSession.id}</strong>}
                </div>
                <div className="pairing-instructions">
                  <ol><li>Connect both devices to Wi-Fi or the internet.</li><li>Scan this QR with the phone.</li><li>Tap <b>Allow camera & connect</b> on the phone.</li></ol>
                  <div className={`pairing-status ${pairingState}`}><span>{pairingState === "error" ? "!" : pairingState === "waiting" ? "2" : "✓"}</span><p><strong>{pairingState === "creating" ? "Creating secure link" : pairingState === "waiting" ? "Waiting for phone" : pairingState === "connected" ? "Phone connected" : "Connection needs attention"}</strong><small>{pairingMessage}</small></p></div>
                  {phoneSession && <label className="pairing-link"><span>Or open this link on the phone</span><input readOnly value={phoneSession.link} onFocus={(event) => event.currentTarget.select()} /></label>}
                  <div className="pairing-actions">
                    <button type="button" onClick={copyPhoneLink} disabled={!phoneSession}>{linkCopied ? "Link copied" : "Copy link"}</button>
                    <button type="button" onClick={sharePhoneLink} disabled={!phoneSession}>Share to phone</button>
                    {pairingState === "error" && <button type="button" className="retry-pairing" onClick={() => startPhonePairing(photos.some(Boolean))}>Create new link</button>}
                  </div>
                </div>
              </div>
              <p className="pairing-privacy">Live preview and original still photos travel directly between the phone and this booth. The pairing expires automatically.</p>
            </section>
          </div>
        )}

        {stage === "camera" && (
          <section className="booth-screen no-print">
            <div className="booth-heading">
              <div><p className="eyebrow"><span /> Group {groups.length + 1} of {GROUPS_PER_SHEET}</p><h2>Take your three shots</h2></div>
              <button type="button" className="quiet-button" onClick={cancelCapture}>Exit session</button>
            </div>

            <div className="camera-layout">
              <div className={`camera-frame ${flash ? "flash" : ""}`}>
                <video className={mirrorCamera ? "mirrored" : ""} ref={videoRef} muted playsInline aria-label="Live camera preview" />
                <div className="frame-corners" aria-hidden="true"><i /><i /><i /><i /></div>
                <div className="camera-design-overlay" aria-hidden="true">
                  <i className="overlay-flourish flourish-left" />
                  <i className="overlay-flourish flourish-right" />
                  <span className="camera-event-watermark"><b>5th</b><em>Gawad Parangal</em><small>2026 · LSPU Los Baños Campus</small></span>
                </div>
                <div className="camera-controls" aria-label="Camera controls">
                  <button type="button" onClick={cycleCaptureLight} disabled={sequenceRunning || cameraState !== "ready"} aria-label={`Capture light: ${captureLightLabel}. Click to change mode.`}><FlashIcon /> <span>{captureLightLabel}</span></button>
                  <button type="button" onClick={resetCamera} disabled={sequenceRunning || cameraState === "starting"} aria-label="Reset camera"><RetryIcon /> <span>{cameraOperation === "reset" ? "Resetting" : "Reset camera"}</span></button>
                  <button type="button" onClick={switchCamera} disabled={sequenceRunning || cameraState === "starting" || (cameraSource === "local" && cameras.length < 2)} aria-label="Switch camera"><SwitchCameraIcon /> <span>{cameraOperation === "switch" ? "Switching" : cameraSource === "phone" ? "Switch phone camera" : cameras.length < 2 ? "One camera" : "Switch camera"}</span></button>
                </div>
                {sequenceRunning && <div className="floating-sequence-controls"><button type="button" className={`floating-pause-control ${paused ? "paused" : ""}`} onClick={togglePause}>{paused ? "▶ Resume" : "Ⅱ Pause"}</button><button type="button" className="capture-now-control" onClick={captureImmediately} disabled={countdown === null}><CameraIcon /> Take shot now</button></div>}
                {cameraState === "starting" && <div className="camera-cover"><span className="spinner" /><strong>Opening camera</strong><small>Please allow access when your browser asks.</small></div>}
                {cameraState === "error" && <div className="camera-cover error-cover"><b>!</b><strong>Camera needs attention</strong><small>{cameraMessage}</small><button type="button" onClick={() => cameraSource === "phone" ? (stopCamera(), setStage("welcome")) : ensureCamera()}>{cameraSource === "phone" ? "Connect another phone" : "Try camera again"}</button></div>}
                {countdown !== null && <div className="countdown"><small>Photo {shotIndex + 1} of {SHOTS_PER_GROUP}</small><strong key={countdown}>{countdown}</strong><span>Get ready</span></div>}
                {betweenShots && <div className="between-shots"><span>✓</span><strong>Lovely!</strong><small>Getting the next shot ready…</small></div>}
                {paused && sequenceRunning && <div className="pause-layer"><span>Ⅱ</span><strong>Session paused</strong><small>Your countdown is frozen.</small><button type="button" onClick={togglePause}>Resume capture</button></div>}
                {flash && <div className="flash-layer" />}
                {cameraState === "ready" && !sequenceRunning && <div className="camera-ready"><span /> {cameraSource === "phone" ? "Phone camera ready" : "Camera ready"} <b>{cameraResolution}</b></div>}
              </div>

              <aside className="session-panel">
                <p className="panel-kicker">Your session</p>
                <h3>{paused ? "Session paused" : sequenceRunning ? `Capturing photo ${shotIndex + 1}` : photos.some(Boolean) ? "Ready to retake" : "Ready when you are"}</h3>
                <div className="mini-shots">
                  {photos.map((photo, index) => (
                    <div className={`mini-shot ${index === shotIndex && sequenceRunning ? "current" : ""} ${photo ? "done" : ""}`} key={index}>
                      {photo ? <img src={photo} alt={`Captured photo ${index + 1}`} /> : <span>{index + 1}</span>}
                      <small>{photo ? "Captured" : index === shotIndex ? "Next" : "Waiting"}</small>
                    </div>
                  ))}
                </div>
                <div className="timer-explainer"><span>10</span><p><strong>seconds between each smile</strong><small>We’ll take all three automatically.</small></p></div>
                {cameraMessage && cameraState !== "error" && <p className="inline-error">{cameraMessage}</p>}
                {!sequenceRunning && cameraState === "ready" && (
                  <button type="button" className="primary-wide" onClick={() => runSequence(photos.every(Boolean) ? [shotIndex] : [0, 1, 2])}>
                    <CameraIcon /> {photos.some(Boolean) ? "Retake this shot" : "Begin 3-shot capture"}
                  </button>
                )}
                {sequenceRunning && <div className="sequence-controls"><button type="button" className="pause-button" onClick={togglePause}>{paused ? "Resume" : "Pause"}</button><button type="button" className="secondary-wide" onClick={cancelCapture}>Cancel countdown</button></div>}
                <p className="look-note">{cameraSource === "phone" ? "Phone live preview · original still captured on the phone and sent at native photo quality." : "Look at the lens for the best result · Native camera feed · enhanced output up to 7680 × 4320."}</p>
              </aside>
            </div>
          </section>
        )}

        {stage === "review" && (
          <section className="review-screen no-print">
            <div className="review-copy">
              <p className="eyebrow"><span /> Group {groups.length + 1} review</p>
              <h2>Three great moments.</h2>
              <p>Keep them all, or retake any photo before it goes into the event strip.</p>
              <label className="strip-caption-field">
                <span>Optional text above the photos</span>
                <input type="text" value={stripCaption} maxLength={60} onChange={(event) => setStripCaption(event.target.value)} placeholder="Name, organization, #hashtag — or leave blank" />
              </label>
            </div>
            <div className="review-workspace">
              <div className="strip-review-card">
                <div className="strip-review-heading"><span>Final strip preview</span><strong>Click a photo to inspect it</strong></div>
                <div className="review-strip-preview">
                  {reviewStripUrl ? <img src={reviewStripUrl} alt="Completed event strip preview containing the three selected photos" /> : <div className="strip-preview-loading"><span className="spinner" /><small>Building strip preview</small></div>}
                  {photos.map((photo, index) => (
                    <button type="button" className={`strip-photo-target target-${index + 1} ${selectedPhotoIndex === index ? "selected" : ""}`} key={index} onClick={() => setSelectedPhotoIndex(index)} aria-label={`Zoom photo ${index + 1}`} disabled={!photo || isComposing}><span>0{index + 1}</span></button>
                  ))}
                  {reviewStripUrl && <button type="button" className="maximize-preview" onClick={() => setExpandedPreview({ src: reviewStripUrl, alt: "Full event strip preview" })} aria-label="Maximize the completed strip preview"><span aria-hidden="true">⛶</span></button>}
                </div>
              </div>

              <div className="selected-photo-card">
                <div className="selected-photo-heading"><p><span>Selected photo</span><strong>Photo {selectedPhotoIndex + 1} of {SHOTS_PER_GROUP}</strong></p><small>Zoomed preview</small></div>
                <div className="selected-photo-zoom">
                  {photos[selectedPhotoIndex] && <img src={photos[selectedPhotoIndex]} alt={`Selected photo ${selectedPhotoIndex + 1} enlarged preview`} />}
                  {photos[selectedPhotoIndex] && <button type="button" className="maximize-preview" onClick={() => setExpandedPreview({ src: photos[selectedPhotoIndex] as string, alt: `Full preview of photo ${selectedPhotoIndex + 1}` })} aria-label={`Maximize photo ${selectedPhotoIndex + 1} preview`}><span aria-hidden="true">⛶</span></button>}
                </div>
                <div className="photo-selector" aria-label="Choose a photo to inspect">
                  {photos.map((photo, index) => (
                    <button type="button" className={selectedPhotoIndex === index ? "selected" : ""} key={index} onClick={() => setSelectedPhotoIndex(index)} aria-label={`Select photo ${index + 1}`}>{photo && <img src={photo} alt="" />}<span>0{index + 1}</span></button>
                  ))}
                </div>
                <button type="button" className="retake-selected" onClick={() => retakeShot(selectedPhotoIndex)} disabled={isComposing}><RetryIcon /> Retake selected photo</button>
              </div>
            </div>
            <div className="review-actions">
              <button type="button" className="quiet-button" onClick={cancelCapture} disabled={isComposing}>Discard session</button>
              <div>
                <label className="auto-print-toggle"><input type="checkbox" checked={autoPrint} onChange={(event) => setAutoPrint(event.target.checked)} /><span /><b>Auto-open print when group 4 is ready</b></label>
                {backupMessage && <p className="backup-message">{backupMessage}</p>}
                <button type="button" className="approve-button" onClick={approveGroup} disabled={isComposing}>
                  {isComposing ? <><span className="spinner small" /> {layoutMessage}</> : <>Use these photos <b>→</b></>}
                </button>
              </div>
            </div>
          </section>
        )}

        {stage === "sheet" && (
          <section className="sheet-screen no-print">
            <div className="sheet-copy">
              <p className="eyebrow"><span /> {groups.length === GROUPS_PER_SHEET ? "A4 sheet complete" : "Current A4 sheet"}</p>
              <h2>{groups.length} group{groups.length === 1 ? "" : "s"}.<br /><em>Ready to print.</em></h2>
              <p>{groups.length === GROUPS_PER_SHEET ? "The first three strips run vertically. The fourth sits across the bottom, matching your supplied A4 layout." : `Your ${groups.length} saved strip${groups.length === 1 ? " is" : "s are"} placed in the original A4 positions. Unused positions stay blank.`}</p>
              <div className="quality-card"><span>300</span><p><strong>DPI print canvas</strong><small>2480 × 3508 px · A4 portrait</small></p></div>
              <div className="sheet-group-editor" aria-label="Four strips on this sheet">
                {groups.map((group, index) => (
                  <div className="sheet-group" key={group.id}>
                    <img src={group.stripUrl} alt={`Group ${index + 1} strip`} />
                    <span>Group {index + 1}</span>
                    <button type="button" onClick={() => deleteGroup(index)} aria-label={`Remove group ${index + 1} from sheet`}>Remove</button>
                  </div>
                ))}
              </div>
              {layoutMessage && <div className="composing-note"><span className="spinner" /> {layoutMessage}</div>}
              <div className="sheet-actions">
                <button type="button" className="print-button" onClick={() => window.print()} disabled={!sheetUrl}><PrinterIcon /> Print A4 sheet</button>
                <button type="button" className="download-button" onClick={downloadPdf} disabled={!sheetUrl}><DownloadIcon /> Export PDF</button>
                <button type="button" className="download-button secondary-download" onClick={() => sheetUrl && saveDataUrl(sheetUrl, "gawad-parangal-photo-strips-a4.jpg")} disabled={!sheetUrl}><DownloadIcon /> High-res JPG</button>
              </div>
              {groups.length < GROUPS_PER_SHEET && <button type="button" className="new-sheet-button continue-sheet-button" onClick={continueAddingGroups}>Continue adding groups <span>→</span></button>}
              <button type="button" className="new-sheet-button" onClick={startNewSheet}>Clear and start a new A4 sheet <span>→</span></button>
              <p className="print-tip"><strong>Print tip:</strong> choose A4, portrait, 100% scale, and highest quality. Turn off “fit to page” if your printer supports borderless A4.</p>
            </div>
            <div className="a4-preview-wrap">
              <div className="a4-shadow" />
              <div className="a4-preview">
                {sheetUrl ? <><img src={sheetUrl} alt={`A4 print sheet containing ${groups.length} completed event strip${groups.length === 1 ? "" : "s"}`} /><button type="button" className="maximize-preview" onClick={() => setExpandedPreview({ src: sheetUrl, alt: "Full A4 photo-strip sheet preview" })} aria-label="Maximize the A4 sheet preview"><span aria-hidden="true">⛶</span></button></> : <div className="a4-loading"><span className="spinner" /><strong>Arranging your strips</strong></div>}
              </div>
              <span className="a4-label">A4 · PORTRAIT</span>
            </div>
          </section>
        )}

        {stage === "welcome" && (
          <footer className="workflow-bar no-print">
            <div><span className="step-number active">1</span><p><strong>Step in</strong><small>Allow camera access</small></p></div><i />
            <div><span className="step-number">2</span><p><strong>Strike a pose</strong><small>3 timed photos</small></p></div><i />
            <div><span className="step-number">3</span><p><strong>Review</strong><small>Keep or retry</small></p></div><i />
            <div><span className="step-number">4</span><p><strong>Print</strong><small>Auto A4 layout</small></p></div>
          </footer>
        )}
      </main>

      {sheetUrl && <div className="print-only"><img src={sheetUrl} alt="Printable A4 photo strip sheet" /></div>}
      {expandedPreview && (
        <div className="preview-lightbox no-print" role="dialog" aria-modal="true" aria-label={expandedPreview.alt}>
          <button type="button" className="close-preview" onClick={() => setExpandedPreview(null)} aria-label="Close full-screen preview">× <span>Close</span></button>
          <img src={expandedPreview.src} alt={expandedPreview.alt} />
        </div>
      )}
    </>
  );
}
