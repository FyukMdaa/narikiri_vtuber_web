// ──────────────────────────────────────────────────────────────
// tga-decoder.js — TGA (Truevision TARGA) デコーダ
//   Inochi2D v0.8+ の .inp は内部テクスチャを TGA で保持する。
//   ブラウザは TGA をネイティブサポートしないため自前でデコード。
//
//   対応範囲:
//     - Image type 2  (uncompressed truecolor, 24/32bpp)
//     - Image type 10 (RLE-compressed truecolor, 24/32bpp)
//     - Top-left / bottom-left origin
//     - 8-bit grayscale (type 3) — Inochi2D では稀
//   出力: { width, height, data: Uint8ClampedArray (RGBA, **premultiplied**) }
//   v5: WebGL2 ミップマップ生成が数学的に正しくなるよう、RGB を alpha で
//   事前乗算して返す (公式 part.frag の premultiplied 規約と対)。
// ──────────────────────────────────────────────────────────────

export function decodeTga(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length < 18) throw new Error('TGA: header too short');

  // ── TGA v1 header (18 bytes) ──
  const idLen        = bytes[0];
  const colorMapType = bytes[1];
  const imageType    = bytes[2];   // 2=uncompressed TC, 10=RLE TC, 3=uncompressed grayscale
  // bytes[3..7]: color map spec (Inochi2D では使用しない)
  const xOrigin = readU16LE(bytes, 8);
  const yOrigin = readU16LE(bytes, 10);
  const width   = readU16LE(bytes, 12);
  const height  = readU16LE(bytes, 14);
  const bpp     = bytes[16];       // 8/16/24/32
  const desc    = bytes[17];
  const topOrigin = (desc & 0x20) !== 0; // bit 5 = top-left origin
  // bytes[18 .. 18+idLen-1]: image ID (skip)

  if (colorMapType !== 0) {
    throw new Error(`TGA: color map not supported (colorMapType=${colorMapType})`);
  }
  if (imageType !== 2 && imageType !== 10 && imageType !== 3) {
    throw new Error(`TGA: unsupported image type ${imageType}`);
  }
  if (bpp !== 8 && bpp !== 24 && bpp !== 32) {
    throw new Error(`TGA: unsupported bpp ${bpp}`);
  }

  const isGrayscale = (imageType === 3) || (bpp === 8);
  const isRLE = (imageType === 10);
  const hasAlpha = (bpp === 32);
  const bytesPerPixel = bpp / 8;

  // ピクセルデータ開始位置 = 18 + idLen (color map は Inochi2D では 0 のみ)
  let off = 18 + idLen;

  // 出力バッファ (RGBA8)
  const out = new Uint8ClampedArray(width * height * 4);

  if (isRLE) {
    off = decodeRleTruecolor(bytes, off, out, width, height, bpp, bytesPerPixel);
  } else if (imageType === 2 || imageType === 3) {
    off = decodeUncompressedTruecolor(bytes, off, out, width, height, bpp, bytesPerPixel);
  }

  // Origin 反転: TGA は bottom-left がデフォルト。WebGL は top-left が標準。
  // desc bit 5 が 1 なら top-left (反転不要)、0 なら bottom-left (反転必要)
  if (!topOrigin) {
    flipVertical(out, width, height);
  }

  // v5: premultiply (RGB *= A/255)
  //   ミップマップの平均が premultiplied 空間で正しくなり、
  //   縮小時のパーツ境界の暗いフリンジ (つなぎ目) を防ぐ。
  premultiply(out);

  return { width, height, data: out };
}

// ── 非圧縮 truecolor / grayscale ──
function decodeUncompressedTruecolor(bytes, off, out, w, h, bpp, bytesPerPixel) {
  const total = w * h;
  for (let i = 0; i < total; i++) {
    if (bytesPerPixel === 4) {
      // BGRA → RGBA
      out[i * 4 + 0] = bytes[off + 2]; // R
      out[i * 4 + 1] = bytes[off + 1]; // G
      out[i * 4 + 2] = bytes[off + 0]; // B
      out[i * 4 + 3] = bytes[off + 3]; // A
    } else if (bytesPerPixel === 3) {
      // BGR → RGB
      out[i * 4 + 0] = bytes[off + 2];
      out[i * 4 + 1] = bytes[off + 1];
      out[i * 4 + 2] = bytes[off + 0];
      out[i * 4 + 3] = 255;
    } else if (bytesPerPixel === 1) {
      // Grayscale
      const v = bytes[off];
      out[i * 4 + 0] = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = 255;
    }
    off += bytesPerPixel;
  }
  return off;
}

// ── RLE 圧縮 truecolor (TGA type 10) ──
//   TGA RLE packet:
//     1 byte header: bit7=continuation flag, bits0-6=count-1
//     if continuation (bit7=1): pixel data = 1 pixel (bytesPerPixel bytes), repeated count times
//     if raw (bit7=0): pixel data = count consecutive pixels (count * bytesPerPixel bytes)
function decodeRleTruecolor(bytes, off, out, w, h, bpp, bytesPerPixel) {
  const total = w * h;
  let pixelIdx = 0;
  while (pixelIdx < total) {
    if (off >= bytes.length) throw new Error('TGA RLE: unexpected EOF');
    const header = bytes[off++];
    const count = (header & 0x7f) + 1;
    const isRun = (header & 0x80) !== 0;
    if (pixelIdx + count > total) throw new Error('TGA RLE: count exceeds image size');

    if (isRun) {
      // 1 pixel repeated `count` times
      if (off + bytesPerPixel > bytes.length) throw new Error('TGA RLE: run packet EOF');
      const r = bytesPerPixel === 4 ? bytes[off + 2] : bytesPerPixel === 3 ? bytes[off + 2] : bytes[off];
      const g = bytesPerPixel === 4 ? bytes[off + 1] : bytesPerPixel === 3 ? bytes[off + 1] : bytes[off];
      const b = bytesPerPixel === 4 ? bytes[off + 0] : bytesPerPixel === 3 ? bytes[off + 0] : bytes[off];
      const a = bytesPerPixel === 4 ? bytes[off + 3] : 255;
      for (let i = 0; i < count; i++) {
        out[pixelIdx * 4 + 0] = r;
        out[pixelIdx * 4 + 1] = g;
        out[pixelIdx * 4 + 2] = b;
        out[pixelIdx * 4 + 3] = a;
        pixelIdx++;
      }
      off += bytesPerPixel;
    } else {
      // `count` raw pixels
      for (let i = 0; i < count; i++) {
        if (off + bytesPerPixel > bytes.length) throw new Error('TGA RLE: raw packet EOF');
        if (bytesPerPixel === 4) {
          out[pixelIdx * 4 + 0] = bytes[off + 2];
          out[pixelIdx * 4 + 1] = bytes[off + 1];
          out[pixelIdx * 4 + 2] = bytes[off + 0];
          out[pixelIdx * 4 + 3] = bytes[off + 3];
        } else if (bytesPerPixel === 3) {
          out[pixelIdx * 4 + 0] = bytes[off + 2];
          out[pixelIdx * 4 + 1] = bytes[off + 1];
          out[pixelIdx * 4 + 2] = bytes[off + 0];
          out[pixelIdx * 4 + 3] = 255;
        } else if (bytesPerPixel === 1) {
          const v = bytes[off];
          out[pixelIdx * 4 + 0] = v;
          out[pixelIdx * 4 + 1] = v;
          out[pixelIdx * 4 + 2] = v;
          out[pixelIdx * 4 + 3] = 255;
        }
        off += bytesPerPixel;
        pixelIdx++;
      }
    }
  }
  return off;
}

// ── v5: premultiply (RGB *= A/255) ──
function premultiply(out) {
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a === 255) continue;
    if (a === 0) {
      out[i] = 0; out[i + 1] = 0; out[i + 2] = 0;
      continue;
    }
    out[i]     = (out[i]     * a + 127) / 255 | 0;
    out[i + 1] = (out[i + 1] * a + 127) / 255 | 0;
    out[i + 2] = (out[i + 2] * a + 127) / 255 | 0;
  }
}

// ── 上下反転 (bottom-left origin → top-left) ──
function flipVertical(out, w, h) {
  const rowBytes = w * 4;
  const half = Math.floor(h / 2);
  const tmp = new Uint8Array(rowBytes);
  for (let y = 0; y < half; y++) {
    const top = y * rowBytes;
    const bot = (h - 1 - y) * rowBytes;
    tmp.set(out.subarray(top, top + rowBytes));
    out.copyWithin(top, bot, bot + rowBytes);
    out.set(tmp, bot);
  }
}

function readU16LE(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8);
}

// ── ImageBitmap 生成ヘルパ ──
//   デコード結果を ImageData 経由で ImageBitmap に変換。
//   WebGL へのテクスチャアップロード用。
export async function decodeTgaToBitmap(buf) {
  const { width, height, data } = decodeTga(buf); // data は premultiplied 済み
  // v5: canvas を経由しない (2D canvas は内部 premultiply を二重適用する恐れ)。
  //   data は既に premultiplied なので、createImageBitmap 側の自動 premultiply
  //   ('default' は ImageData ソースで再 premultiply される) を 'none' で抑止する。
  let bitmap;
  try {
    bitmap = await createImageBitmap(new ImageData(data, width, height), { premultiplyAlpha: 'none' });
  } catch (_e) {
    bitmap = await createImageBitmap(new ImageData(data, width, height));
  }
  return { width, height, bitmap };
}
