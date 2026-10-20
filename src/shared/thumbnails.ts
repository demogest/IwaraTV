// Iwara renders a strip of preview frames (thumbnail-00.jpg, thumbnail-01.jpg,
// …) for every upload; cards cycle through them on hover.

/** Frames shown in a hover preview. Iwara usually has more; a missing one ends the cycle. */
export const PREVIEW_FRAME_COUNT = 12;

export function thumbnailFrameUrl(base: string, index: number): string {
  return `${base}thumbnail-${String(index).padStart(2, "0")}.jpg`;
}
