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
      width: 10,
      height: 6,
      inset: 1,
      offsetX: 1,
      offsetY: 1,
    });
  });

  it("expands the paper to a preset aspect without cropping the photo", () => {
    expect(imageSizeWithMargin(8, 4, 0, 1)).toEqual({
      width: 8,
      height: 8,
      inset: 0,
      offsetX: 0,
      offsetY: 2,
    });
  });

  it("centers the source and leaves the margin transparent", () => {
    const source = {
      data: new Uint8ClampedArray([
        1, 2, 3, 255,
        4, 5, 6, 255,
      ]),
      width: 2,
      height: 1,
    };
    const padded = addImageMargin(source, 1);

    expect({ width: padded.width, height: padded.height }).toEqual({
      width: 4,
      height: 3,
    });
    expect(Array.from(padded.data.slice(0, 4))).toEqual([0, 0, 0, 0]);
    const center = (padded.width + 1) * 4;
    expect(Array.from(padded.data.slice(center, center + 8))).toEqual([
      1, 2, 3, 255,
      4, 5, 6, 255,
    ]);
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
