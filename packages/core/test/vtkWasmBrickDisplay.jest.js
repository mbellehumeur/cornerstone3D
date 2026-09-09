import {
  formatVtkWasmBrickLabel,
  summaryFromBrickPlan,
} from '../src/RenderingEngine/GenericViewport/vtkWasmBrickDisplay';

describe('vtkWasmBrickDisplay', () => {
  it('formats partition label with multiplication sign', () => {
    const summary = summaryFromBrickPlan(
      {
        dimensions: [512, 512, 258],
        partitions: { x: 8, y: 8, z: 8 },
        bricked: true,
        max3D: 2048,
        strategy: 'fixed',
        bricks: [],
        vtkPartitions: [8, 8, 8],
      },
      'denseBricks'
    );
    expect(formatVtkWasmBrickLabel(summary)).toBe('8×8×8');
  });
});
