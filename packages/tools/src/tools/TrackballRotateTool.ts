import vtkMath from '@kitware/vtk.js/Common/Core/Math';
import { Events } from '../enums';
import {
  eventTarget,
  getEnabledElement,
  getEnabledElementByIds,
  beginWebGPUViewportAnimation,
  endWebGPUViewportAnimation,
  beginMviewVolume3DInteraction,
  endMviewVolume3DInteraction,
  beginSlicerLiveVolume3DInteraction,
  endSlicerLiveVolume3DInteraction,
  getMviewVolume3D,
  getSlicerLiveVolume3D,
  getVtkWasmVolume3D,
} from '@cornerstonejs/core';
import type { Types } from '@cornerstonejs/core';
import { mat4, vec3 } from 'gl-matrix';
import type { EventTypes, PublicToolProps, ToolProps } from '../types';
import { BaseTool } from './base';
import { getToolGroup } from '../store/ToolGroupManager';
import getViewportICamera from '../utilities/getViewportICamera';
import setViewportCamera, {
  resetViewportCamera,
} from '../utilities/setViewportCamera';
import {
  applyViewportPresentation,
  getViewportPresentation,
} from '../utilities/viewportPresentation';

class TrackballRotateTool extends BaseTool {
  static toolName;
  touchDragCallback: (evt: EventTypes.InteractionEventType) => void;
  mouseDragCallback: (evt: EventTypes.InteractionEventType) => void;
  cleanUp: (() => void) | null = null;
  _resizeObservers = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _viewportAddedListener: (evt: any) => void;
  _hasResolutionChanged = false;

  constructor(
    toolProps: PublicToolProps = {},
    defaultToolProps: ToolProps = {
      supportedInteractionTypes: ['Mouse', 'Touch'],
      configuration: {
        rotateIncrementDegrees: 2,
        rotateSampleDistanceFactor: 2, // Factor to increase sample distance (lower resolution) when rotating
      },
    }
  ) {
    super(toolProps, defaultToolProps);
    this.touchDragCallback = this._dragCallback.bind(this);
    this.mouseDragCallback = this._dragCallback.bind(this);
  }

  /** Remove mouse + touch end listeners so interaction can settle on tablets. */
  private _detachInteractionEndListeners(handler: () => void): void {
    document.removeEventListener('mouseup', handler);
    document.removeEventListener('touchend', handler);
    document.removeEventListener('touchcancel', handler);
  }

  /** Arm end-of-drag cleanup for both mouse and touch (Android tablets). */
  private _attachInteractionEndListeners(handler: () => void): void {
    document.addEventListener('mouseup', handler);
    document.addEventListener('touchend', handler);
    document.addEventListener('touchcancel', handler);
  }

  preMouseDownCallback = (evt: EventTypes.InteractionEventType) => {
    const eventDetail = evt.detail;
    const { element } = eventDetail;
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;

    // Specialized Volume3D (mview): no VTK volume mapper — drop interactive
    // quality via VolumeRenderer.beginInteraction / endInteraction.
    if (
      beginMviewVolume3DInteraction(viewport.id) ||
      beginSlicerLiveVolume3DInteraction(viewport.id)
    ) {
      // Keep VTK orbit centered on the volume; screen pan lives in panOffset /
      // mview panX/Y. If an older pan moved the focal point, snap it back so the
      // first rotate click does not jump around a mismatched center.
      this._recenterSpecializedOrbit(viewport);

      if (!this._hasResolutionChanged) {
        this._hasResolutionChanged = true;

        if (this.cleanUp) {
          this._detachInteractionEndListeners(this.cleanUp);
        }

        this.cleanUp = () => {
          if (this.cleanUp) {
            this._detachInteractionEndListeners(this.cleanUp);
          }
          endMviewVolume3DInteraction(viewport.id);
          endSlicerLiveVolume3DInteraction(viewport.id);
          viewport.render();
          this._hasResolutionChanged = false;
          this.cleanUp = null;
        };

        this._attachInteractionEndListeners(this.cleanUp);
      }
      return true;
    }

    // vtk-wasm Volume3D: no vtk-js volume mapper / sample-distance LOD, but
    // TrackballRotate still orbits volumeCenter. Snap focal there on pointer
    // down so tall MultiBlock series don't rotate about a mismatched IJK center.
    if (getVtkWasmVolume3D(viewport.id)) {
      this._recenterSpecializedOrbit(viewport);
      return true;
    }

    const actorEntry = viewport.getDefaultActor();
    const actor = actorEntry?.actor as Types.VolumeActor | undefined;

    if (!actor?.getMapper) {
      return true;
    }

    const mapper = actor.getMapper();

    const hasSampleDistance =
      'getSampleDistance' in mapper || 'getCurrentSampleDistance' in mapper;

    if (!hasSampleDistance) {
      return true;
    }

    const originalSampleDistance = mapper.getSampleDistance();

    if (!this._hasResolutionChanged) {
      const { rotateSampleDistanceFactor } = this.configuration;
      mapper.setSampleDistance(
        originalSampleDistance * rotateSampleDistanceFactor
      );
      this._hasResolutionChanged = true;

      // Drive vtk WebGPU VolumePass interaction downscale (isAnimating).
      // No-op when this viewport has no WebGPU window.
      beginWebGPUViewportAnimation(viewport.id);

      if (this.cleanUp) {
        this._detachInteractionEndListeners(this.cleanUp);
      }

      this.cleanUp = () => {
        if (this.cleanUp) {
          this._detachInteractionEndListeners(this.cleanUp);
        }
        mapper.setSampleDistance(originalSampleDistance);
        endWebGPUViewportAnimation(viewport.id);
        viewport.render();
        this._hasResolutionChanged = false;
        this.cleanUp = null;
      };

      this._attachInteractionEndListeners(this.cleanUp);
    }
    return true;
  };

  /** Touch start must arm interactive LOD / Target FPS like mouse down. */
  preTouchStartCallback = (evt: EventTypes.InteractionEventType): boolean => {
    return this.preMouseDownCallback(evt);
  };

  _getViewportsInfo = () => {
    const viewports = getToolGroup(this.toolGroupId).viewportsInfo;
    return viewports;
  };

  onSetToolActive = () => {
    const subscribeToElementResize = () => {
      const viewportsInfo = this._getViewportsInfo();
      viewportsInfo.forEach(({ viewportId, renderingEngineId }) => {
        if (!this._resizeObservers.has(viewportId)) {
          const { viewport } = getEnabledElementByIds(
            viewportId,
            renderingEngineId
          ) || { viewport: null };

          if (!viewport) {
            return;
          }

          const { element } = viewport;

          let lastWidth = element.clientWidth;
          let lastHeight = element.clientHeight;

          const resizeObserver = new ResizeObserver(() => {
            const enabled = getEnabledElementByIds(
              viewportId,
              renderingEngineId
            );
            if (!enabled) {
              return;
            }
            const { viewport: vp } = enabled;
            const width = vp.element.clientWidth;
            const height = vp.element.clientHeight;

            // ResizeObserver fires once on observe() — that must not reset the
            // camera (mview jump when switching to TrackballRotate).
            if (width === lastWidth && height === lastHeight) {
              return;
            }
            lastWidth = width;
            lastHeight = height;

            const viewPresentation = getViewportPresentation(vp);

            resetViewportCamera(vp);

            applyViewportPresentation(vp, viewPresentation);
            // resetViewState / setViewState already present on Volume3D NEXT.
          });

          resizeObserver.observe(element);
          this._resizeObservers.set(viewportId, resizeObserver);
        }
      });
    };

    subscribeToElementResize();

    this._viewportAddedListener = (evt) => {
      if (evt.detail.toolGroupId === this.toolGroupId) {
        subscribeToElementResize();
      }
    };

    eventTarget.addEventListener(
      Events.TOOLGROUP_VIEWPORT_ADDED,
      this._viewportAddedListener
    );
  };

  onSetToolDisabled = () => {
    // Disconnect all resize observers
    this._resizeObservers.forEach((resizeObserver, viewportId) => {
      resizeObserver.disconnect();
      this._resizeObservers.delete(viewportId);
    });

    if (this._viewportAddedListener) {
      eventTarget.removeEventListener(
        Events.TOOLGROUP_VIEWPORT_ADDED,
        this._viewportAddedListener
      );
      this._viewportAddedListener = null; // Clear the reference to the listener
    }
  };

  /**
   * For mview, rotate about the volume center (same pivot as the present).
   * canvasToWorld(center) is unreliable with a detached present canvas and a
   * panned VTK focal point.
   */
  _recenterSpecializedOrbit = (viewport) => {
    const entry =
      getMviewVolume3D(viewport.id) ||
      getSlicerLiveVolume3D(viewport.id) ||
      getVtkWasmVolume3D(viewport.id);
    const center = entry?.volumeCenter as Types.Point3 | undefined;
    if (!center || !viewport.getVtkActiveCamera) {
      return;
    }

    const vtkCamera = viewport.getVtkActiveCamera();
    const focalPoint = vtkCamera.getFocalPoint() as Types.Point3;
    const position = vtkCamera.getPosition() as Types.Point3;
    const dx = focalPoint[0] - center[0];
    const dy = focalPoint[1] - center[1];
    const dz = focalPoint[2] - center[2];
    if (dx * dx + dy * dy + dz * dz < 1e-6) {
      return;
    }

    const distance = Math.hypot(
      position[0] - focalPoint[0],
      position[1] - focalPoint[1],
      position[2] - focalPoint[2]
    );
    const viewPlaneNormal = vtkCamera.getViewPlaneNormal() as Types.Point3;
    const len =
      Math.hypot(viewPlaneNormal[0], viewPlaneNormal[1], viewPlaneNormal[2]) ||
      1;

    setViewportCamera(viewport, {
      focalPoint: center,
      position: [
        center[0] + (viewPlaneNormal[0] / len) * distance,
        center[1] + (viewPlaneNormal[1] / len) * distance,
        center[2] + (viewPlaneNormal[2] / len) * distance,
      ],
    });
  };

  rotateCamera = (viewport, centerWorld, axis, angle) => {
    const vtkCamera = viewport.getVtkActiveCamera();
    const viewUp = vtkCamera.getViewUp();
    const focalPoint = vtkCamera.getFocalPoint();
    const position = vtkCamera.getPosition();

    const newPosition: Types.Point3 = [0, 0, 0];
    const newFocalPoint: Types.Point3 = [0, 0, 0];
    const newViewUp: Types.Point3 = [0, 0, 0];

    const transform = mat4.identity(new Float32Array(16));
    mat4.translate(transform, transform, centerWorld);
    mat4.rotate(transform, transform, angle, axis);
    mat4.translate(transform, transform, [
      -centerWorld[0],
      -centerWorld[1],
      -centerWorld[2],
    ]);
    vec3.transformMat4(newPosition, position, transform);
    vec3.transformMat4(newFocalPoint, focalPoint, transform);

    mat4.identity(transform);
    mat4.rotate(transform, transform, angle, axis);
    vec3.transformMat4(newViewUp, viewUp, transform);

    setViewportCamera(viewport, {
      position: newPosition,
      viewUp: newViewUp,
      focalPoint: newFocalPoint,
    });
  };

  /**
   * Apply yaw then pitch in one camera write so Volume3D NEXT presents once
   * (setViewState → modified → render), not twice.
   */
  rotateCameraAxes = (viewport, centerWorld, axisX, angleX, axisY, angleY) => {
    const vtkCamera = viewport.getVtkActiveCamera();
    let viewUp = vtkCamera.getViewUp() as Types.Point3;
    let focalPoint = vtkCamera.getFocalPoint() as Types.Point3;
    let position = vtkCamera.getPosition() as Types.Point3;

    const apply = (axis: Types.Point3, angle: number) => {
      if (!Number.isFinite(angle) || Math.abs(angle) < 1e-12) {
        return;
      }
      const newPosition: Types.Point3 = [0, 0, 0];
      const newFocalPoint: Types.Point3 = [0, 0, 0];
      const newViewUp: Types.Point3 = [0, 0, 0];
      const transform = mat4.identity(new Float32Array(16));
      mat4.translate(transform, transform, centerWorld);
      mat4.rotate(transform, transform, angle, axis);
      mat4.translate(transform, transform, [
        -centerWorld[0],
        -centerWorld[1],
        -centerWorld[2],
      ]);
      vec3.transformMat4(newPosition, position, transform);
      vec3.transformMat4(newFocalPoint, focalPoint, transform);
      mat4.identity(transform);
      mat4.rotate(transform, transform, angle, axis);
      vec3.transformMat4(newViewUp, viewUp, transform);
      position = newPosition;
      focalPoint = newFocalPoint;
      viewUp = newViewUp;
    };

    apply(axisX, angleX);
    apply(axisY, angleY);

    setViewportCamera(viewport, {
      position,
      viewUp,
      focalPoint,
    });
  };

  _dragCallback(evt: EventTypes.InteractionEventType): void {
    const { element, currentPoints, lastPoints } = evt.detail;
    const currentPointsCanvas = currentPoints.canvas;
    const lastPointsCanvas = lastPoints.canvas;
    const { rotateIncrementDegrees } = this.configuration;
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;

    const camera = getViewportICamera(viewport);
    const width = element.clientWidth;
    const height = element.clientHeight;

    const normalizedPosition = [
      currentPointsCanvas[0] / width,
      currentPointsCanvas[1] / height,
    ];

    const normalizedPreviousPosition = [
      lastPointsCanvas[0] / width,
      lastPointsCanvas[1] / height,
    ];

    const center: Types.Point2 = [width * 0.5, height * 0.5];
    // mview: orbit the volume center (matches present). Otherwise the canvas
    // focal point (cornerstone3D default).
    const specialized =
      getMviewVolume3D(viewport.id) ||
      getSlicerLiveVolume3D(viewport.id) ||
      getVtkWasmVolume3D(viewport.id);
    const centerWorld = (specialized?.volumeCenter ??
      viewport.canvasToWorld(center)) as Types.Point3;
    const normalizedCenter = [0.5, 0.5];

    const radsq = (1.0 + Math.abs(normalizedCenter[0])) ** 2.0;
    const op = [normalizedPreviousPosition[0], 0, 0];
    const oe = [normalizedPosition[0], 0, 0];

    const opsq = op[0] ** 2;
    const oesq = oe[0] ** 2;

    const lop = opsq > radsq ? 0 : Math.sqrt(radsq - opsq);
    const loe = oesq > radsq ? 0 : Math.sqrt(radsq - oesq);

    const nop: Types.Point3 = [op[0], 0, lop];
    vtkMath.normalize(nop);
    const noe: Types.Point3 = [oe[0], 0, loe];
    vtkMath.normalize(noe);

    const dot = vtkMath.dot(nop, noe);
    if (Math.abs(dot) > 0.0001) {
      const angleX =
        -2 *
        Math.acos(vtkMath.clampValue(dot, -1.0, 1.0)) *
        Math.sign(normalizedPosition[0] - normalizedPreviousPosition[0]) *
        rotateIncrementDegrees;

      const upVec = camera.viewUp;
      const atV = camera.viewPlaneNormal;
      const rightV: Types.Point3 = [0, 0, 0];
      const forwardV: Types.Point3 = [0, 0, 0];

      vtkMath.cross(upVec, atV, rightV);
      vtkMath.normalize(rightV);

      vtkMath.cross(atV, rightV, forwardV);
      vtkMath.normalize(forwardV);
      vtkMath.normalize(upVec);

      const angleY =
        (normalizedPreviousPosition[1] - normalizedPosition[1]) *
        rotateIncrementDegrees;

      this.rotateCameraAxes(
        viewport,
        centerWorld,
        forwardV,
        angleX,
        rightV,
        angleY
      );
    }
  }
}

TrackballRotateTool.toolName = 'TrackballRotate';
export default TrackballRotateTool;
