import type {
  WasmVtkBrickPartitionStrategy,
  WasmVtkVolumeBrickPlan,
} from '../helpers/volumeTextureBrickWasm';

export type VtkWasmBrickSummary = {
  partitions: [number, number, number];
  strategy: WasmVtkBrickPartitionStrategy;
  mode?: 'single' | 'denseBricks';
  brickCount: number;
};

export function summaryFromBrickPlan(
  brickPlan: WasmVtkVolumeBrickPlan,
  mode?: 'single' | 'denseBricks'
): VtkWasmBrickSummary {
  return {
    partitions: [
      brickPlan.vtkPartitions[0],
      brickPlan.vtkPartitions[1],
      brickPlan.vtkPartitions[2],
    ],
    strategy: brickPlan.strategy,
    mode,
    brickCount: brickPlan.bricks.length,
  };
}

/** Compact label for viewport overlay, e.g. `8×8×8`. */
export function formatVtkWasmBrickLabel(summary: VtkWasmBrickSummary): string {
  const [x, y, z] = summary.partitions;
  return `${x}×${y}×${z}`;
}

export function resolveVtkWasmBrickSummary(
  viewport: unknown
): VtkWasmBrickSummary | undefined {
  if (!viewport || typeof viewport !== 'object') {
    return undefined;
  }

  const getter = (
    viewport as {
      getVtkWasmBrickSummary?: () => VtkWasmBrickSummary | undefined;
    }
  ).getVtkWasmBrickSummary;

  if (typeof getter !== 'function') {
    return undefined;
  }

  return getter.call(viewport);
}
