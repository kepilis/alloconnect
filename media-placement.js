'use strict';

// Координаты относятся к видимой части трансляции, без чёрных полос.
function mediaPlacement(rect, placement, aspect) {
  const angle = (placement.r || 0) * Math.PI / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const rotatedWidth = cos + aspect * sin;
  const rotatedHeight = sin + aspect * cos;
  const width = Math.min(placement.w * rect.w, rect.w / rotatedWidth, 0.9 * rect.h / rotatedHeight);
  const height = width * aspect;
  const halfWidth = width * rotatedWidth / 2;
  const halfHeight = width * rotatedHeight / 2;
  const x = Math.max(halfWidth, Math.min(rect.w - halfWidth, placement.x * rect.w));
  const y = Math.max(halfHeight, Math.min(rect.h - halfHeight, placement.y * rect.h));
  return { width, height, x, y };
}
