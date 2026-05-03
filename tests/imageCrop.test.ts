import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  cropPng,
  findFigmaSelectionCrop,
  findIllustrationAssetCrops,
  findLargestForegroundCrop,
  isLikelyFigmaLoadingScreenshot,
  isLikelyScreenCrop,
} from "../src/imageCrop";

describe("image crop helpers", () => {
  it("finds and crops the selected Figma frame outline", () => {
    const png = new PNG({ width: 240, height: 180 });
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = 30;
      png.data[index + 1] = 30;
      png.data[index + 2] = 30;
      png.data[index + 3] = 255;
    }

    drawBlueRect(png, 50, 30, 140, 100);
    const buffer = PNG.sync.write(png);
    const box = findFigmaSelectionCrop(buffer);

    expect(box).toEqual({ x: 53, y: 33, width: 134, height: 94 });
    const cropped = PNG.sync.read(cropPng(buffer, box!));
    expect(cropped.width).toBe(134);
    expect(cropped.height).toBe(94);
  });

  it("finds the largest light frame on a dark canvas", () => {
    const png = new PNG({ width: 420, height: 260 });
    fill(png, 28, 28, 28);
    drawRect(png, 80, 40, 230, 170, 252, 252, 252);
    drawRect(png, 80, 40, 48, 170, 0, 72, 190);
    drawRect(png, 340, 50, 48, 90, 252, 252, 252);

    expect(findLargestForegroundCrop(PNG.sync.write(png))).toEqual({
      x: 82,
      y: 42,
      width: 226,
      height: 166,
    });
  });

  it("extracts standalone illustration clusters while ignoring edge selection borders", () => {
    const png = new PNG({ width: 435, height: 688 });
    fill(png, 252, 252, 252);
    drawBlueRect(png, 0, 0, 435, 688);
    drawRect(png, 166, 233, 101, 100, 224, 231, 126);
    drawBlueRect(png, 196, 259, 41, 50);
    drawBlueRect(png, 152, 317, 30, 22);
    drawBlueRect(png, 255, 317, 30, 22);

    const assets = findIllustrationAssetCrops(PNG.sync.write(png));
    expect(assets).toHaveLength(1);
    expect(assets[0].box).toEqual({ x: 140, y: 221, width: 157, height: 130 });
  });

  it("detects Figma loading interstitial screenshots", () => {
    const png = new PNG({ width: 1000, height: 800 });
    fill(png, 230, 230, 230);
    drawRect(png, 480, 368, 40, 40, 72, 72, 72);
    drawRect(png, 430, 430, 140, 8, 252, 252, 252);

    expect(isLikelyFigmaLoadingScreenshot(PNG.sync.write(png))).toBe(true);
  });

  it("does not treat a mostly white mobile screen as Figma loading UI", () => {
    const png = new PNG({ width: 390, height: 844 });
    fill(png, 252, 252, 252);
    drawRect(png, 0, 0, 390, 140, 0, 92, 175);
    drawRect(png, 32, 190, 240, 24, 34, 34, 34);
    drawRect(png, 32, 260, 326, 52, 235, 241, 247);
    drawRect(png, 32, 330, 326, 52, 235, 241, 247);

    expect(isLikelyFigmaLoadingScreenshot(PNG.sync.write(png))).toBe(false);
  });

  it("rejects section-divider crops as screen screenshots", () => {
    expect(isLikelyScreenCrop({ x: 0, y: 0, width: 1916, height: 28 })).toBe(false);
    expect(isLikelyScreenCrop({ x: 0, y: 0, width: 390, height: 844 })).toBe(true);
  });
});

function drawBlueRect(png: PNG, x: number, y: number, width: number, height: number): void {
  for (let dx = 0; dx < width; dx += 1) {
    setPixel(png, x + dx, y);
    setPixel(png, x + dx, y + height - 1);
  }
  for (let dy = 0; dy < height; dy += 1) {
    setPixel(png, x, y + dy);
    setPixel(png, x + width - 1, y + dy);
  }
}

function setPixel(png: PNG, x: number, y: number): void {
  const offset = (y * png.width + x) * 4;
  png.data[offset] = 13;
  png.data[offset + 1] = 153;
  png.data[offset + 2] = 255;
  png.data[offset + 3] = 255;
}

function fill(png: PNG, r: number, g: number, b: number): void {
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = r;
    png.data[index + 1] = g;
    png.data[index + 2] = b;
    png.data[index + 3] = 255;
  }
}

function drawRect(
  png: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): void {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      const offset = (yy * png.width + xx) * 4;
      png.data[offset] = r;
      png.data[offset + 1] = g;
      png.data[offset + 2] = b;
      png.data[offset + 3] = 255;
    }
  }
}
