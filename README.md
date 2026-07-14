# Gawad Parangal Photo Booth

A browser-based event booth for the 5th Gawad Parangal at LSPU Los Baños Campus.

## Booth flow

1. Allow camera access and begin a session. The operator can reset the active camera or switch between available camera devices.
2. The booth takes three full-resolution shots with a 10-second countdown before each photo. The operator can pause and resume the active countdown or use **Take shot now** to bypass the remaining timer.
3. Review the completed event strip, click any of its three photo areas to inspect it at a larger size, and retake only the selected photo when needed.
4. Approve the set. The booth downloads one ZIP backup containing the three enhanced shots and the completed event strip.
5. Approve four groups. The booth inserts every set into the supplied event strip and composes one 300 DPI A4 sheet: three vertical strips on top and one rotated strip below. Any strip can be removed from the completed sheet and recaptured before final printing.
6. Print directly, export a real single-page PDF, or save the high-resolution A4 JPG.

Photos remain device-local and are cleared when a new A4 sheet begins. The downloaded ZIP backup is the portable device copy for each group.

Active photos, completed groups, and the current A4 sheet are also stored without re-encoding in the browser's IndexedDB. An accidental refresh, shutdown, or restart restores the last session. Starting a new A4 sheet clears that saved session. Captures use the camera's native feed and are adaptively enhanced into a canvas up to 7680 × 4320 pixels before strip composition.

## Offline installation

The production site is an installable PWA. Open it once while online so the service worker can cache the booth, event template, logo, and built application files. Use **Install app** in the top bar or the browser's **Add to Home Screen / Install app** command. After installation, the booth can reopen and capture, review, export, and print photos without Wi-Fi. Camera permission and downloaded shot backups remain device-local.

Development mode does not register the service worker, which prevents stale cached files from interfering with local code changes.

## Local use

```bash
npm ci
npm run dev
```

Open the local HTTPS/localhost address in a current Chromium, Firefox, or Safari browser. Camera access requires a secure context (production HTTPS or localhost).

For printing, use A4 portrait, 100% scale, and the highest available quality. Borderless A4 gives the closest match to the preview.

## Vercel

Import `castanar123/Gawad2026` in Vercel as a Next.js project. The default commands are:

- Install: `npm ci`
- Build: `npm run build`
- Start: `npm run start`

No database is required for the booth flow. Original shots are backed up by downloading a ZIP to the operator's device when each 3-shot group is approved.
