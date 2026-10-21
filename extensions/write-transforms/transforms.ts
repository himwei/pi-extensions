export interface WriteTransform {
  name: string;
  applies(path: string, content: string): boolean;
  transform(path: string, content: string): string;
}

/** Ordered, idempotent transforms. No transforms are currently enabled. */
export const TRANSFORMS: readonly WriteTransform[] = [];

export function applyTransforms(
  path: string,
  content: string,
  transforms: readonly WriteTransform[] = TRANSFORMS,
): string {
  return transforms.reduce((text, item) => item.applies(path, text) ? item.transform(path, text) : text, content);
}
