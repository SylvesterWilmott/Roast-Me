"use strict";

/**
 * Resizes a base64-encoded image to a max width, re-encoding as JPEG. Runs
 * in the service worker via OffscreenCanvas + createImageBitmap.
 * @param {string} base64 - The source image data, base64-encoded (no data: prefix).
 * @param {string} sourceMime - The source MIME type (e.g. "image/png").
 * @param {number} maxWidth - Maximum output width in pixels; height scales proportionally.
 * @param {number} quality - JPEG quality, 0..1.
 * @returns {Promise<{data: string, mediaType: string}>}
 */
export async function resizeBase64Image(base64, sourceMime, maxWidth, quality) {
  const bytes = Uint8Array.from(atob(base64), function (c) { return c.charCodeAt(0); });
  const blob = new Blob([bytes], { type: sourceMime });
  const bitmap = await createImageBitmap(blob);

  const scale = Math.min(maxWidth / bitmap.width, 1);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);

  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const outBuffer = new Uint8Array(await outBlob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < outBuffer.length; i++) binary += String.fromCharCode(outBuffer[i]);
  return { data: btoa(binary), mediaType: "image/jpeg", width: w, height: h };
}
