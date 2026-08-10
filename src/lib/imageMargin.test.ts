import { describe, expect, it } from "vitest";
import { addImageMargin, imageSizeWithMargin } from "./imageMargin";

describe("image margin", () => {
  it("defaults to the original image at zero", () => {
    const source = {
      data: new Uint8ClampedArray([10, 20, 30, 255]),
      width: 1,
      height: 1,
    };
    expect(addImageMargin(source, 0)).toBe(source);
  });

  it("adds an even margin based on the shorter edge", () => {
    expect(imageSizeWithMargin(8, 4, 0.25)).toEqual({
      width: 8,
      height: 4,
      photoWidth: 5,
      photoHeight: 2,
      inset: 1,
      offsetX: 1,
      offsetY: 1,
    });
  });

  it("expands the paper to a preset aspect without cropping the photo", () => {
    expect(imageSizeWithMargin(8, 4, 0, 1)).toEqual({
      width: 8,
      height: 8,
      photoWidth: 8,
      photoHeight: 4,
      inset: 0,
      offsetX: 0,
      offsetY: 2,
    });
  });

  it("keeps the paper size constant while the margin changes", () => {
    const zero = imageSizeWithMargin(600, 400, 0);
    const large = imageSizeWithMargin(600, 400, 0.5);

    expect({ width: large.width, height: large.height }).toEqual({
      width: zero.width,
      height: zero.height,
    });
    expect(large.photoWidth).toBeLessThan(zero.photoWidth);
    expect(large.photoHeight).toBeLessThan(zero.photoHeight);
  });

  it("centers the resized source and leaves the margin transparent", () => {
    const source = {
      data: new Uint8ClampedArray(4 * 4 * 4).fill(255),
      width: 4,
      height: 4,
    };
    const padded = addImageMargin(source, 0.5);

    expect({ width: padded.width, height: padded.height }).toEqual({
      width: 4,
      height: 4,
    });
    expect(Array.from(padded.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
    const center = (padded.width + 1) * 4;
    expect(Array.from(padded.data.slice(center, center + 4))).toEqual([255, 255, 255, 255]);
  });

  it("centers the photo on a differently shaped paper", () => {
    const source = {
      data: new Uint8ClampedArray([
        10, 20, 30, 255,
        40, 50, 60, 255,
      ]),
      width: 2,
      height: 1,
    };
    const padded = addImageMargin(source, 0, 1);

    expect({ width: padded.width, height: padded.height }).toEqual({
      width: 2,
      height: 2,
    });
    expect(Array.from(padded.data.slice(0, 8))).toEqual([
      10, 20, 30, 255,
      40, 50, 60, 255,
    ]);
    expect(Array.from(padded.data.slice(8, 16))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
