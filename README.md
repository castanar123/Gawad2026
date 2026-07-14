# Gawad Parangal Photo Booth

A browser-based event booth for the 5th Gawad Parangal at LSPU Los Baños Campus.

## Booth flow

1. Allow camera access and begin a session.
2. The booth takes three full-resolution shots with a 10-second countdown before each photo.
3. Review the set and retake any individual photo.
4. Approve four groups. The booth inserts every set into the supplied event strip and composes one 300 DPI A4 sheet: three vertical strips on top and one rotated strip below.
5. Print directly, export a real single-page PDF, or save the high-resolution A4 JPG.

Photos remain in browser memory and are cleared when a new A4 sheet begins or the page closes.

## Local use

```bash
npm ci
npm run dev
```

Open the local HTTPS/localhost address in a current Chromium, Firefox, or Safari browser. Camera access requires a secure context (production HTTPS or localhost).

For printing, use A4 portrait, 100% scale, and the highest available quality. Borderless A4 gives the closest match to the preview.
