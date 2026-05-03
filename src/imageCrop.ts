import { PNG } from "pngjs";

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedAssetCrop {
  box: CropBox;
  confidence: number;
  reason: string;
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

export function isLikelyFigmaLoadingScreenshot(buffer: Buffer): boolean {
  const png = PNG.sync.read(buffer);
  const totalPixels = png.width * png.height;
  if (totalPixels < 160_000) return false;

  let opaquePixels = 0;
  let loadingGrayPixels = 0;
  let coloredPixels = 0;
  let darkPixels = 0;
  let brightnessSum = 0;
  let saturationSum = 0;

  for (let index = 0; index < png.data.length; index += 4) {
    const r = png.data[index];
    const g = png.data[index + 1];
    const b = png.data[index + 2];
    const a = png.data[index + 3];
    if (a < 180) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const brightness = (r + g + b) / 3;
    const saturation = max - min;

    opaquePixels += 1;
    brightnessSum += brightness;
    saturationSum += saturation;

    if (saturation <= 10 && brightness >= 210 && brightness <= 240) loadingGrayPixels += 1;
    if (saturation >= 24) coloredPixels += 1;
    if (brightness < 120) darkPixels += 1;
  }

  if (!opaquePixels) return false;

  const loadingGrayRatio = loadingGrayPixels / opaquePixels;
  const coloredRatio = coloredPixels / opaquePixels;
  const darkRatio = darkPixels / opaquePixels;
  const averageBrightness = brightnessSum / opaquePixels;
  const averageSaturation = saturationSum / opaquePixels;

  return (
    loadingGrayRatio >= 0.96 &&
    coloredRatio <= 0.01 &&
    darkRatio <= 0.01 &&
    averageBrightness >= 210 &&
    averageBrightness <= 240 &&
    averageSaturation <= 6
  );
}

export function findIllustrationAssetCrops(buffer: Buffer, maxAssets = 5): DetectedAssetCrop[] {
  const png = PNG.sync.read(buffer);
  const mask = new Uint8Array(png.width * png.height);

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const r = png.data[offset];
      const g = png.data[offset + 1];
      const b = png.data[offset + 2];
      const a = png.data[offset + 3];
      if (isIllustrationPixel(r, g, b, a)) {
        mask[y * png.width + x] = 1;
      }
    }
  }

  const visited = new Uint8Array(mask.length);
  const components: Array<CropBox & { pixels: number }> = [];

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) continue;
    const component = flood(mask, visited, png.width, png.height, index);
    const box = componentToBox(component);
    if (component.pixels < 8 || box.width < 3 || box.height < 3) continue;
    if (touchesImageEdge(box, png.width, png.height, 3)) continue;
    components.push({ ...box, pixels: component.pixels });
  }

  const merged = mergeNearbyBoxes(components, 36)
    .map((box) => padBox(box, 12, png.width, png.height))
    .filter((box) => isLikelyStandaloneAsset(box, png.width, png.height));

  return merged
    .map((box) => ({
      box,
      confidence: scoreAssetBox(box, png.width, png.height),
      reason: "colored illustration/icon cluster in the screen screenshot",
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxAssets);
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

function isIllustrationPixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 180) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const brightness = (r + g + b) / 3;
  const saturation = max - min;
  if (brightness > 235 && saturation < 35) return false;
  if (brightness < 80) return false;
  return saturation >= 30;
}

function componentToBox(component: Component): CropBox {
  return {
    x: component.xMin,
    y: component.yMin,
    width: component.xMax - component.xMin + 1,
    height: component.yMax - component.yMin + 1,
  };
}

function mergeNearbyBoxes(boxes: CropBox[], gap: number): CropBox[] {
  const merged = boxes.map((box) => ({ ...box }));
  let changed = true;

  while (changed) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        if (!boxesNear(merged[i], merged[j], gap)) continue;
        merged[i] = unionBoxes(merged[i], merged[j]);
        merged.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }

  return merged;
}

function boxesNear(a: CropBox, b: CropBox, gap: number): boolean {
  return !(
    a.x + a.width + gap < b.x ||
    b.x + b.width + gap < a.x ||
    a.y + a.height + gap < b.y ||
    b.y + b.height + gap < a.y
  );
}

function unionBoxes(a: CropBox, b: CropBox): CropBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: x2 - x, height: y2 - y };
}

function padBox(box: CropBox, padding: number, imageWidth: number, imageHeight: number): CropBox {
  const x = clamp(box.x - padding, 0, imageWidth - 1);
  const y = clamp(box.y - padding, 0, imageHeight - 1);
  const x2 = clamp(box.x + box.width + padding, x + 1, imageWidth);
  const y2 = clamp(box.y + box.height + padding, y + 1, imageHeight);
  return { x, y, width: x2 - x, height: y2 - y };
}

function isLikelyStandaloneAsset(box: CropBox, imageWidth: number, imageHeight: number): boolean {
  const area = box.width * box.height;
  const imageArea = imageWidth * imageHeight;
  if (box.width < 40 || box.height < 40) return false;
  if (area < 1400 || area > imageArea * 0.28) return false;
  if (touchesImageEdge(box, imageWidth, imageHeight, 4)) return false;
  const aspect = box.width / box.height;
  return aspect >= 0.25 && aspect <= 4;
}

function scoreAssetBox(box: CropBox, imageWidth: number, imageHeight: number): number {
  const areaScore = Math.min(1, (box.width * box.height) / (imageWidth * imageHeight * 0.08));
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const dx = Math.abs(centerX - imageWidth / 2) / (imageWidth / 2);
  const dy = Math.abs(centerY - imageHeight / 2) / (imageHeight / 2);
  const centerScore = 1 - Math.min(1, (dx + dy) / 2);
  return Number((areaScore * 0.65 + centerScore * 0.35).toFixed(4));
}

function touchesImageEdge(box: CropBox, imageWidth: number, imageHeight: number, margin: number): boolean {
  return (
    box.x <= margin ||
    box.y <= margin ||
    box.x + box.width >= imageWidth - margin ||
    box.y + box.height >= imageHeight - margin
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
