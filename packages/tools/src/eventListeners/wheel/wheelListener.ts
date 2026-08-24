import { getEnabledElement, triggerEvent } from '@cornerstonejs/core';
import normalizeWheel from './normalizeWheel';
import Events from '../../enums/Events';
// ~~ VIEWPORT LIBRARY
import getMouseEventPoints from '../mouse/getMouseEventPoints';
import type { MouseWheelEventDetail } from '../../types/EventTypes';

/**
 * wheelListener - Captures and normalizes mouse wheel events. Emits as a
 * cornerstoneTools3D mouse wheel event.
 * @param evt - The mouse wheel event.
 */
function wheelListener(evt: WheelEvent) {
  const element = <HTMLDivElement>evt.currentTarget;
  const enabledElement = getEnabledElement(element);
  const { renderingEngineId, viewportId } = enabledElement;

  // Ignore true no-ops (e.g. middle-button click emits deltaY of 0).
  // Allow deltaX-only events so trackpad two-finger horizontal pan reaches tools.
  // See https://github.com/cornerstonejs/cornerstoneTools/issues/935
  if (evt.deltaY > -1 && evt.deltaY < 1 && evt.deltaX > -1 && evt.deltaX < 1) {
    return;
  }

  const points = getMouseEventPoints(evt);
  if (!points) {
    return;
  }

  evt.preventDefault();

  const { spinX, spinY, pixelX, pixelY } = normalizeWheel(evt);
  const direction = spinY < 0 ? -1 : 1;

  const eventDetail: MouseWheelEventDetail = {
    event: evt,
    eventName: Events.MOUSE_WHEEL,
    renderingEngineId,
    viewportId,
    element,
    camera: {},
    detail: evt as unknown as Record<string, unknown>,
    wheel: {
      spinX,
      spinY,
      pixelX,
      pixelY,
      direction,
    },
    points,
  };

  triggerEvent(element, Events.MOUSE_WHEEL, eventDetail);
}

export default wheelListener;
