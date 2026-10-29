import '../../../packages/shared/src/env.js';
import { runExperiment } from './agent1.js';
const result = await runExperiment(process.argv[2], process.env.EXPERIMENT_RUN_ID);
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'completed') process.exitCode = 1;
