import { PNG } from "pngjs";

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Component {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  pixels: number;
}

export function cropPng(buffer: Buffer, box: CropBox): Buffer {
  const source = PNG.sync.read(buffer);
  const x = clamp(Math.floor(box.x), 0, source.width - 1);
  const y = clamp(Math.floor(box.y), 0, source.height - 1);
  const width = clamp(Math.floor(box.width), 1, source.width - x);
  const height = clamp(Math.floor(box.height), 1, source.height - y);
  const target = new PNG({ width, height });

  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((y + row) * source.width + x) * 4;
    const targetStart = row * width * 4;
    source.data.copy(target.data, targetStart, sourceStart, sourceStart + width * 4);
  }

  return PNG.sync.write(target);
}

export function findFigmaSelectionCrop(buffer: Buffer, searchBox?: CropBox): CropBox | undefined {
  const png = PNG.sync.read(buffer);
  const xStart = searchBox ? clamp(Math.floor(searchBox.x), 0, png.width - 1) : 0;
  const yStart = searchBox ? clamp(Math.floor(searchBox.y), 0, png.height - 1) : 0;
  const xEnd = searchBox
    ? clamp(Math.ceil(searchBox.x + searchBox.width), xStart + 1, png.width)
    : png.width;
  const yEnd = searchBox
    ? clamp(Math.ceil(searchBox.y + searchBox.height), yStart + 1, png.height)
    : png.height;

  const maskWidth = xEnd - xStart;
  const maskHeight = yEnd - yStart;
  const mask = new Uint8Array(maskWidth * maskHeight);

  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const offset = (y * png.width + x) * 4;
      const r = png.data[offset];
      const g = png.data[offset + 1];
      const b = png.data[offset + 2];
      const a = png.data[offset + 3];
      if (isFigmaSelectionBlue(r, g, b, a)) {
        mask[(y - yStart) * maskWidth + (x - xStart)] = 1;
      }
    }
  }

  const visited = new Uint8Array(mask.length);
  let best: Component | undefined;

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) continue;
    const component = flood(mask, visited, maskWidth, maskHeight, index);
    const width = component.xMax - component.xMin + 1;
    const height = component.yMax - component.yMin + 1;
    const area = width * height;
    if (width < 80 || height < 80 || component.pixels < 120) continue;
    if (!best || area > (best.xMax - best.xMin + 1) * (best.yMax - best.yMin + 1)) {
      best = component;
    }
  }

  if (!best) return undefined;
  const inset = 3;
  const x = xStart + best.xMin + inset;
  const y = yStart + best.yMin + inset;
  const width = best.xMax - best.xMin + 1 - inset * 2;
  const height = best.yMax - best.yMin + 1 - inset * 2;
  if (width < 40 || height < 40) return undefined;

  return { x, y, width, height };
}

export function findLargestForegroundCrop(buffer: Buffer, searchBox?: CropBox): CropBox | undefined {
  const png = PNG.sync.read(buffer);
  const xStart = searchBox ? clamp(Math.floor(searchBox.x), 0, png.width - 1) : 0;
  const yStart = searchBox ? clamp(Math.floor(searchBox.y), 0, png.height - 1) : 0;
  const xEnd = searchBox
    ? clamp(Math.ceil(searchBox.x + searchBox.width), xStart + 1, png.width)
    : png.width;
  const yEnd = searchBox
    ? clamp(Math.ceil(searchBox.y + searchBox.height), yStart + 1, png.height)
    : png.height;
  const maskWidth = xEnd - xStart;
  const maskHeight = yEnd - yStart;
  const mask = new Uint8Array(maskWidth * maskHeight);

  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const offset = (y * png.width + x) * 4;
      const r = png.data[offset];
      const g = png.data[offset + 1];
      const b = png.data[offset + 2];
      const a = png.data[offset + 3];
      if (isForegroundPixel(r, g, b, a)) {
        mask[(y - yStart) * maskWidth + (x - xStart)] = 1;
      }
    }
  }

  const visited = new Uint8Array(mask.length);
  let best: Component | undefined;

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) continue;
    const component = flood(mask, visited, maskWidth, maskHeight, index);
    const width = component.xMax - component.xMin + 1;
    const height = component.yMax - component.yMin + 1;
    const area = width * height;
    if (width < 120 || height < 120 || component.pixels < 5000) continue;
    if (!best || area > (best.xMax - best.xMin + 1) * (best.yMax - best.yMin + 1)) {
      best = component;
    }
  }

  if (!best) return undefined;
  const inset = 2;
  const width = best.xMax - best.xMin + 1 - inset * 2;
  const height = best.yMax - best.yMin + 1 - inset * 2;
  if (width < 40 || height < 40) return undefined;
  return {
    x: xStart + best.xMin + inset,
    y: yStart + best.yMin + inset,
    width,
    height,
  };
}

function flood(
  mask: Uint8Array,
  visited: Uint8Array,
  width: number,
  height: number,
  start: number,
): Component {
  const queue = [start];
  visited[start] = 1;
  let head = 0;
  let xMin = start % width;
  let xMax = xMin;
  let yMin = Math.floor(start / width);
  let yMax = yMin;
  let pixels = 0;

  while (head < queue.length) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    pixels += 1;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;

    const neighbors = [
      x > 0 ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y < height - 1 ? index + width : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || visited[neighbor] || !mask[neighbor]) continue;
      visited[neighbor] = 1;
      queue.push(neighbor);
    }
  }

  return { xMin, yMin, xMax, yMax, pixels };
}

function isFigmaSelectionBlue(r: number, g: number, b: number, a: number): boolean {
  return a > 180 && r <= 80 && g >= 120 && g <= 190 && b >= 200 && b - r >= 140 && b - g >= 40;
}

function isForegroundPixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 180) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const brightness = (r + g + b) / 3;
  if (brightness <= 62 && max <= 95) return false;
  if (max - min < 18 && brightness < 84) return false;
  return max >= 88 || brightness >= 96;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
