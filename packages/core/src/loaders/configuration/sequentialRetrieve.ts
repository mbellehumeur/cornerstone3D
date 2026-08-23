import type { RetrieveStage } from '../../types';

/**
 * Sequential retrieve ordered as center-out quarter chunks:
 * ~1/4 of the volume toward one side from center, then ~1/4 the other way,
 * and so on (not slice-by-slice L/R interleave).
 */
const sequentialRetrieveStages: RetrieveStage[] = [
  {
    id: 'lossySequential',
    retrieveType: 'singleFast',
    positionOrder: 'centerQuarterAlternating',
  },
  {
    id: 'finalSequential',
    retrieveType: 'singleFinal',
    positionOrder: 'centerQuarterAlternating',
  },
];

export default sequentialRetrieveStages;
