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

/**
 * Renders the final screenshot that's sent to the LLM: applies an optional
 * color-matrix transform (color-blindness simulation) and draws numbered
 * annotation boxes on top — all on a single OffscreenCanvas in the service
 * worker. The live tab is never touched.
 * @param {string} base64Png - Clean screenshot base64 (no data: prefix).
 * @param {Array<{index: number, tag: string, boundingBox: {x: number, y: number, width: number, height: number}}>} elements - Elements to annotate. boundingBox is in CSS pixels, center-aligned.
 * @param {number} devicePixelRatio - DPR at capture time; used to scale CSS-pixel bboxes to device-pixel canvas coords.
 * @param {Object<string,string>} tagColors - Map of tag name → CSS color.
 * @param {string} defaultColor - Fallback CSS color for unknown tags.
 * @param {number[]|null} colorMatrix - Optional 20-value row-major 4x5 matrix (feColorMatrix format). Null = skip.
 * @returns {Promise<{data: string, mediaType: string, width: number, height: number}>}
 */
export async function renderAnnotatedScreenshot(
  base64Png,
  elements,
  devicePixelRatio,
  tagColors,
  defaultColor,
  colorMatrix,
) {
  const bytes = Uint8Array.from(atob(base64Png), function (c) { return c.charCodeAt(0); });
  const blob = new Blob([bytes], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);

  if (colorMatrix) {
    applyColorMatrix(ctx, bitmap.width, bitmap.height, colorMatrix);
  }

  drawAnnotations(ctx, elements || [], devicePixelRatio || 1, tagColors || {}, defaultColor);

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  const outBuffer = new Uint8Array(await outBlob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < outBuffer.length; i++) binary += String.fromCharCode(outBuffer[i]);
  return {
    data: btoa(binary),
    mediaType: "image/png",
    width: bitmap.width,
    height: bitmap.height,
  };
}

/**
 * Applies a 4x5 feColorMatrix transform to the canvas in place.
 * Matches SVG feColorMatrix with color-interpolation-filters="sRGB" because
 * ImageData is already in sRGB gamma-compressed space (no linearization).
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {number[]} m - 20 values: [r_r, r_g, r_b, r_a, r_o, g_r, ...].
 */
function applyColorMatrix(ctx, w, h, m) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4] * 255;
  const m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8], m9 = m[9] * 255;
  const m10 = m[10], m11 = m[11], m12 = m[12], m13 = m[13], m14 = m[14] * 255;
  const m15 = m[15], m16 = m[16], m17 = m[17], m18 = m[18], m19 = m[19] * 255;
  const alphaIdentity = m15 === 0 && m16 === 0 && m17 === 0 && m18 === 1 && m[19] === 0;

  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
    const nr = m0 * r + m1 * g + m2 * b + m3 * a + m4;
    const ng = m5 * r + m6 * g + m7 * b + m8 * a + m9;
    const nb = m10 * r + m11 * g + m12 * b + m13 * a + m14;
    d[i] = nr < 0 ? 0 : nr > 255 ? 255 : nr;
    d[i + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
    d[i + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
    if (!alphaIdentity) {
      const na = m15 * r + m16 * g + m17 * b + m18 * a + m19;
      d[i + 3] = na < 0 ? 0 : na > 255 ? 255 : na;
    }
  }

  ctx.putImageData(img, 0, 0);
}

/**
 * Draws dashed colored bounding boxes and numeric index labels onto the canvas.
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {Array} elements
 * @param {number} s - DPR scale factor.
 * @param {Object<string,string>} tagColors
 * @param {string} defaultColor
 */
function drawAnnotations(ctx, elements, s, tagColors, defaultColor) {
  ctx.lineWidth = 2 * s;
  ctx.font = `bold ${10 * s}px monospace`;
  ctx.textBaseline = "top";
  const dash = [4 * s, 4 * s];

  const padX = 4 * s;
  const padY = 1 * s;
  const labelH = 12 * s;

  for (const el of elements) {
    const bb = el && el.boundingBox;
    if (!bb) continue;
    const w = bb.width * s;
    const h = bb.height * s;
    if (w <= 0 || h <= 0) continue;
    const left = (bb.x - bb.width / 2) * s;
    const top = (bb.y - bb.height / 2) * s;

    const color = tagColors[el.tag] || defaultColor;

    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.strokeRect(left + 0.5, top + 0.5, w, h);

    const label = String(el.index);
    const textW = ctx.measureText(label).width;
    const labelW = textW + padX * 2;
    const tight = h < 20 * s;
    const lx = tight ? left + w / 2 - labelW / 2 : left + 2 * s;
    const ly = tight ? top - labelH - 2 * s : top + 2 * s;

    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly, labelW, labelH);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, lx + padX, ly + padY);
  }
}
