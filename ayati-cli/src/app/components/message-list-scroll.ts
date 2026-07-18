export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function scrollByLines(
  scrollTop: number,
  delta: number,
  maxScrollTop: number,
): number {
  return clamp(scrollTop + delta, 0, maxScrollTop);
}

export function scrollByPages(
  scrollTop: number,
  pageDelta: number,
  viewportHeight: number,
  maxScrollTop: number,
): number {
  const pageSize = Math.max(1, viewportHeight);
  return scrollByLines(scrollTop, pageDelta * pageSize, maxScrollTop);
}

export function resolveScrollTopAfterContentChange(params: {
  scrollTop: number;
  nextMaxScrollTop: number;
  followOutput: boolean;
}): number {
  const { scrollTop, nextMaxScrollTop, followOutput } = params;
  if (followOutput) {
    return nextMaxScrollTop;
  }

  return clamp(scrollTop, 0, nextMaxScrollTop);
}
