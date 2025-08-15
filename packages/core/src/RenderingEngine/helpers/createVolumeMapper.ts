import { vtkSharedVolumeMapper } from '../vtkClasses';
import { getConfiguration } from '../../init';
import type vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import type vtkOpenGLTexture from '@kitware/vtk.js/Rendering/OpenGL/Texture';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';

/**
 * Given an imageData and a vtkOpenGLTexture, it creates a "shared" vtk volume mapper
 * from which various volume actors can be created.
 *
 * @param imageData - the vtkImageData object that contains the data to
 * render.
 * @param vtkOpenGLTexture - The vtkOpenGLTexture that will be used to render
 * the volume.
 * @returns The volume mapper.
 */
export default function createVolumeMapper(
  imageData: vtkImageData,
  vtkOpenGLTexture: vtkOpenGLTexture
): vtkVolumeMapper {
  const volumeMapper = vtkSharedVolumeMapper.newInstance();
  const config = getConfiguration();

  if (config.rendering.preferSizeOverAccuracy) {
    volumeMapper.setPreferSizeOverAccuracy(true);
  }

  volumeMapper.setInputData(imageData);

  const spacing = imageData.getSpacing();

  const volumeRenderingConfig = config.rendering?.volumeRendering || {};

  // Calculate default sample distance using the standard formula
  const defaultSampleDistance = (spacing[0] + spacing[1] + spacing[2]) / 6;

  // Allow configuration override for sample distance
  let sampleDistance = defaultSampleDistance;
  console.debug(`Default sample distance: ${defaultSampleDistance}`);
  console.debug(
    `Using sample   distance multiplier: ${volumeRenderingConfig.sampleDistanceMultiplier}`
  );
  if (volumeRenderingConfig.sampleDistanceMultiplier !== undefined) {
    sampleDistance =
      defaultSampleDistance * volumeRenderingConfig.sampleDistanceMultiplier;
  }

  volumeMapper.setSampleDistance(sampleDistance);
  console.debug(`Updated SampleDistance: ${sampleDistance}`);
  //  volumeMapper.setScalarTexture(vtkOpenGLTexture);
  //  console.debug(`Updated ScalarTexture: ${vtkOpenGLTexture}`);
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
