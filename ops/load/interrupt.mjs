// Stops a load run cleanly when the process is asked to end (T-804 review): Ctrl+C, `kill` and a closed terminal.

/** The signals that end a run, each with the exit code a shell reports for it (128 plus the signal number). */
export const INTERRUPT_SIGNALS = Object.freeze({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });

/**
 * Runs `onInterrupt` when the process gets one of `INTERRUPT_SIGNALS`, then exits with that signal's code, even when
 * `onInterrupt` throws; a throw is printed through `report`, not dropped. Returns the function that takes the handlers
 * off again once the run has finished. `target`, `exit` and `report` are the process, its `exit` and a line on stderr
 * unless a test passes its own.
 */
export function exitOnSignals(
  onInterrupt,
  {
    target = process,
    exit = (code) => process.exit(code),
    report = (error) =>
      process.stderr.write(
        `load test: clean-up on interrupt failed: ${error instanceof Error ? error.message : String(error)}
`,
      ),
  } = {},
) {
  const handlers = Object.entries(INTERRUPT_SIGNALS).map(([signal, code]) => {
    const handler = () => {
      try {
        onInterrupt();
      } catch (error) {
        report(error);
      } finally {
        exit(code);
      }
    };
    target.once(signal, handler);
    return [signal, handler];
  });
  return () => {
    for (const [signal, handler] of handlers) target.removeListener(signal, handler);
  };
}
