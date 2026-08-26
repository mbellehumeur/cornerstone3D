import { vtkSharedVolumeMapper } from '../vtkClasses';
import { getConfiguration } from '../../init';
import type vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import type vtkOpenGLTexture from '@kitware/vtk.js/Rendering/OpenGL/Texture';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import type { VolumeTextureBrickPlan } from './volumeTextureBricks';
import {
  computeFittedVolumeSampleDistance,
  DEFAULT_MAX_SAMPLES_PER_RAY,
} from './volumeSampleDistance';

/**
 * Given an imageData and a vtkOpenGLTexture (or brick textures), it creates a
 * "shared" vtk volume mapper from which various volume actors can be created.
 *
 * @param imageData - the vtkImageData object that contains the data to
 * render.
 * @param vtkOpenGLTexture - The primary vtkOpenGLTexture (brick 0).
 * @param options - optional brick textures + chunk plan for >max3D Z.
 * @returns The volume mapper.
 */
export default function createVolumeMapper(
  imageData: vtkImageData,
  vtkOpenGLTexture: vtkOpenGLTexture,
  options?: {
    scalarTextures?: vtkOpenGLTexture[];
    volumeTextureBrickPlan?: VolumeTextureBrickPlan;
  }
): vtkVolumeMapper {
  const volumeMapper = vtkSharedVolumeMapper.newInstance();

  volumeMapper.setInputData(imageData);

  // Set the sample distance to half the mean length of one side. This is where the divide by 6 comes from.
  // https://github.com/Kitware/VTK/blob/6b559c65bb90614fb02eb6d1b9e3f0fca3fe4b0b/Rendering/VolumeOpenGL2/vtkSmartVolumeMapper.cxx#L344
  // When the volume diagonal needs more than maxSamples steps, distance is
  // increased so rays still finish within the budget (avoids GPU hangs).
  const sampleDistanceMultiplier =
    getConfiguration().rendering?.volumeRendering?.sampleDistanceMultiplier ||
    1;
  const configuredMaxSamples =
    getConfiguration().rendering?.volumeRendering?.maximumSamplesPerRay;
  const { sampleDistance, maxSamplesPerRay, fitted, computedSteps } =
    computeFittedVolumeSampleDistance(imageData, {
      multiplier: sampleDistanceMultiplier,
      maxSamplesPerRay:
        typeof configuredMaxSamples === 'number' && configuredMaxSamples > 0
          ? configuredMaxSamples
          : DEFAULT_MAX_SAMPLES_PER_RAY,
    });

  if (fitted) {
    // eslint-disable-next-line no-console
    console.info(
      `[VolumeSampleDistance] fitted sampleDistance=${sampleDistance.toFixed(4)} ` +
        `(computedSteps=${computedSteps} > max=${maxSamplesPerRay})`
    );
  }

  volumeMapper.setMaximumSamplesPerRay(maxSamplesPerRay);
  volumeMapper.setSampleDistance(sampleDistance);

  const scalarTextures =
    options?.scalarTextures?.length > 0
      ? options.scalarTextures
      : [vtkOpenGLTexture];

  volumeMapper.setScalarTexture(scalarTextures[0]);
  volumeMapper.setScalarTextures?.(scalarTextures);
  if (options?.volumeTextureBrickPlan) {
    volumeMapper.setVolumeTextureBrickPlan?.(options.volumeTextureBrickPlan);
  }

  return volumeMapper;
}

/**
 * Converts a shared mapper to a non-shared mapper. Sometimes we need to detach
 * a shared mapper and apply some changes to it, since otherwise, the changes
 * will be applied to all the mappers that share the same data.
 *
 * @param sharedMapper - The shared mapper to convert.
 * @returns The converted volume mapper.
 */
export function convertMapperToNotSharedMapper(sharedMapper: vtkVolumeMapper) {
  const volumeMapper = vtkVolumeMapper.newInstance();
  volumeMapper.setBlendMode(sharedMapper.getBlendMode());

  const imageData = sharedMapper.getInputData();
  const { voxelManager } = imageData.get('voxelManager');
  const values = voxelManager.getCompleteScalarDataArray();

  const scalarArray = vtkDataArray.newInstance({
    name: `Pixels`,
    values,
  });

  imageData.getPointData().setScalars(scalarArray);

  volumeMapper.setInputData(imageData);
  volumeMapper.setMaximumSamplesPerRay(sharedMapper.getMaximumSamplesPerRay());
  volumeMapper.setSampleDistance(sharedMapper.getSampleDistance());
  return volumeMapper;
}
