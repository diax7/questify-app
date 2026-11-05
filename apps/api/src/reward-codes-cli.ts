import { runRewardCodesCommand } from "#src/rewards/reward-codes-command";

/** `node reward-codes.cjs reseal|check` inside the API container (RUNBOOK "Rotating REWARD_CODE_SECRET"). */
runRewardCodesCommand(process.argv.slice(2), process.env).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
