"use client";

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from "react";
import { zipSync } from "fflate";

type Stage = "welcome" | "camera" | "review" | "sheet";

type PhotoGroup = {
  id: string;
  shots: string[];
  stripUrl: string;
};

const TEMPLATE_URL = "/lspu-event-strip.png";
const SHOTS_PER_GROUP = 3;
const GROUPS_PER_SHEET = 4;
const COUNTDOWN_SECONDS = 10;
const A4_WIDTH = 2480;
const A4_HEIGHT = 3508;

const CameraIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="M8.6 5.5 10 3.7h4l1.4 1.8H19a2 2 0 0 1 2 2v10.8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2h3.6Z" />
    <circle cx="12" cy="12.6" r="4" />
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

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

async function composeStrip(shots: string[]) {
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
  const landscapeY = topMargin + stripHeight + rowGap;
  context.save();
  context.translate(sideMargin + stripHeight, landscapeY);
  context.rotate(Math.PI / 2);
  context.drawImage(lastStrip, 0, 0, stripWidth, stripHeight);
  context.restore();

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

function saveShotBackup(shots: string[], groupNumber: number) {
  const files = shots.reduce<Record<string, Uint8Array>>((backupFiles, shot, index) => {
    backupFiles[`shot-${String(index + 1).padStart(2, "0")}.jpg`] = dataUrlToBytes(shot);
    return backupFiles;
  }, {});
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
  const [flash, setFlash] = useState(false);
  const [betweenShots, setBetweenShots] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const [autoPrint, setAutoPrint] = useState(true);
  const [layoutMessage, setLayoutMessage] = useState("");
  const [backupMessage, setBackupMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const runTokenRef = useRef(0);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraState("idle");
  }, []);

  useEffect(() => () => {
    runTokenRef.current += 1;
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

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

  const ensureCamera = async () => {
    setCameraState("starting");
    setCameraMessage("Opening the camera…");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is not supported in this browser.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      });
      streamRef.current = stream;
      await attachCamera();
      setCameraState("ready");
      setCameraMessage("");
      return true;
    } catch (error) {
      setCameraState("error");
      setCameraMessage(error instanceof Error ? error.message : "Please allow camera access and try again.");
      return false;
    }
  };

  const openBooth = async () => {
    setStage("camera");
    setPhotos([null, null, null]);
    setShotIndex(0);
    setCountdown(null);
    await sleep(50);
    await ensureCamera();
  };

  const captureFrame = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) throw new Error("The camera is not ready yet.");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("The photo could not be captured.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.filter = "brightness(1.02) contrast(1.045) saturate(1.05)";
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.96);
  };

  const runSequence = async (indices: number[]) => {
    if (!streamRef.current && !(await ensureCamera())) return;
    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
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
          await sleep(1000);
        }
        if (runTokenRef.current !== token) return;
        setCountdown(null);
        setFlash(true);
        const captured = captureFrame();
        workingPhotos[targetIndex] = captured;
        setPhotos([...workingPhotos]);
        await sleep(180);
        setFlash(false);

        if (position < indices.length - 1) {
          setBetweenShots(true);
          await sleep(1250);
        }
      }
      if (runTokenRef.current === token) setStage("review");
    } catch (error) {
      setCameraMessage(error instanceof Error ? error.message : "The shot could not be captured.");
    } finally {
      if (runTokenRef.current === token) {
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
    setSequenceRunning(false);
    setCountdown(null);
    setBetweenShots(false);
    setPhotos([null, null, null]);
    stopCamera();
    setStage("welcome");
  };

  const approveGroup = async () => {
    const completedShots = photos.filter((photo): photo is string => Boolean(photo));
    if (completedShots.length !== SHOTS_PER_GROUP) return;
    setIsComposing(true);
    setBackupMessage("");
    setLayoutMessage("Saving the original 3-shot backup...");
    try {
      saveShotBackup(completedShots, groups.length + 1);
      setBackupMessage(`Group ${groups.length + 1} original shots downloaded to this device.`);
      setLayoutMessage("Building your high-resolution event strip...");
      const stripUrl = await composeStrip(completedShots);
      const nextGroup: PhotoGroup = {
        id: `${Date.now()}-${groups.length}`,
        shots: completedShots,
        stripUrl,
      };
      const nextGroups = [...groups, nextGroup];
      setGroups(nextGroups);
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
    setGroups((current) => current.filter((_, groupIndex) => groupIndex !== index));
  };

  const downloadPdf = () => {
    if (!sheetUrl) return;
    saveBlob(buildPdfFromJpeg(sheetUrl), "gawad-parangal-photo-strips-a4.pdf");
  };

  const startNewSheet = () => {
    setGroups([]);
    setPhotos([null, null, null]);
    setSheetUrl(null);
    setLayoutMessage("");
    setStage("welcome");
  };

  const progressText = groups.length === 0
    ? "A new A4 sheet is ready"
    : `${groups.length} of ${GROUPS_PER_SHEET} groups ready`;

  return (
    <>
      <main className={`site-shell stage-${stage}`}>
        <header className="topbar no-print">
          <button className="brand" type="button" onClick={() => !sequenceRunning && setStage("welcome")} aria-label="Gawad Parangal Photo Booth home">
            <span className="brand-mark"><CameraIcon /></span>
            <span><strong>Gawad Parangal</strong><small>PHOTO BOOTH</small></span>
          </button>
          <div className="topbar-actions">
            <div className="sheet-progress"><span>{groups.length}</span><i>of {GROUPS_PER_SHEET}</i><b>{progressText}</b></div>
            <div className="event-pill"><span /> LSPU Los Baños Campus · 2026</div>
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
                <button type="button" className="start-button" onClick={openBooth}>
                  <span><CameraIcon /></span> {groups.length ? `Capture group ${groups.length + 1}` : "Start photo session"} <b>→</b>
                </button>
              </div>
              <p className="privacy-note"><span>●</span> Camera access stays on this device. Each approved group downloads a 3-shot backup ZIP.</p>

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
              <div className="ready-badge"><span>✓</span><strong>Print ready</strong><small>A4 · 4 groups</small></div>
            </div>
          </section>
        )}

        {stage === "camera" && (
          <section className="booth-screen no-print">
            <div className="booth-heading">
              <div><p className="eyebrow"><span /> Group {groups.length + 1} of {GROUPS_PER_SHEET}</p><h2>Take your three shots</h2></div>
              <button type="button" className="quiet-button" onClick={cancelCapture}>Exit session</button>
            </div>

            <div className="camera-layout">
              <div className={`camera-frame ${flash ? "flash" : ""}`}>
                <video ref={videoRef} muted playsInline aria-label="Live camera preview" />
                <div className="frame-corners" aria-hidden="true"><i /><i /><i /><i /></div>
                {cameraState === "starting" && <div className="camera-cover"><span className="spinner" /><strong>Opening camera</strong><small>Please allow access when your browser asks.</small></div>}
                {cameraState === "error" && <div className="camera-cover error-cover"><b>!</b><strong>Camera needs attention</strong><small>{cameraMessage}</small><button type="button" onClick={ensureCamera}>Try camera again</button></div>}
                {countdown !== null && <div className="countdown"><small>Photo {shotIndex + 1} of {SHOTS_PER_GROUP}</small><strong key={countdown}>{countdown}</strong><span>Get ready</span></div>}
                {betweenShots && <div className="between-shots"><span>✓</span><strong>Lovely!</strong><small>Getting the next shot ready…</small></div>}
                {flash && <div className="flash-layer" />}
                {cameraState === "ready" && !sequenceRunning && <div className="camera-ready"><span /> Camera ready</div>}
              </div>

              <aside className="session-panel">
                <p className="panel-kicker">Your session</p>
                <h3>{sequenceRunning ? `Capturing photo ${shotIndex + 1}` : photos.some(Boolean) ? "Ready to retake" : "Ready when you are"}</h3>
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
                {sequenceRunning && <button type="button" className="secondary-wide" onClick={cancelCapture}>Cancel countdown</button>}
                <p className="look-note">Look at the camera lens—not your reflection—for the best result.</p>
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
            </div>
            <div className="review-grid">
              {photos.map((photo, index) => (
                <article className="review-photo" key={index}>
                  {photo && <img src={photo} alt={`Photo ${index + 1} preview`} />}
                  <span className="photo-label">0{index + 1}</span>
                  <button type="button" onClick={() => retakeShot(index)} disabled={isComposing}><RetryIcon /> Retake</button>
                </article>
              ))}
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
              <p className="eyebrow"><span /> A4 sheet complete</p>
              <h2>Four groups.<br /><em>Ready to print.</em></h2>
              <p>The first three strips run vertically. The fourth sits across the bottom, matching your supplied A4 layout.</p>
              <div className="quality-card"><span>300</span><p><strong>DPI print canvas</strong><small>2480 × 3508 px · A4 portrait</small></p></div>
              {layoutMessage && <div className="composing-note"><span className="spinner" /> {layoutMessage}</div>}
              <div className="sheet-actions">
                <button type="button" className="print-button" onClick={() => window.print()} disabled={!sheetUrl}><PrinterIcon /> Print A4 sheet</button>
                <button type="button" className="download-button" onClick={downloadPdf} disabled={!sheetUrl}><DownloadIcon /> Export PDF</button>
                <button type="button" className="download-button secondary-download" onClick={() => sheetUrl && saveDataUrl(sheetUrl, "gawad-parangal-photo-strips-a4.jpg")} disabled={!sheetUrl}><DownloadIcon /> High-res JPG</button>
              </div>
              <button type="button" className="new-sheet-button" onClick={startNewSheet}>Start a new A4 sheet <span>→</span></button>
              <p className="print-tip"><strong>Print tip:</strong> choose A4, portrait, 100% scale, and highest quality. Turn off “fit to page” if your printer supports borderless A4.</p>
            </div>
            <div className="a4-preview-wrap">
              <div className="a4-shadow" />
              <div className="a4-preview">
                {sheetUrl ? <img src={sheetUrl} alt="A4 print sheet containing four completed event strips" /> : <div className="a4-loading"><span className="spinner" /><strong>Arranging your strips</strong></div>}
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
    </>
  );
}
