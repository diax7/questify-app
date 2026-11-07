// Loaded before the spawned staff CLI in `staff-admin.int.test.ts`. No test may reach a mail provider, so every outside call
// fails; and `create` must never read standard input, so touching it ends the run with a code no other path gives.
globalThis.fetch = () => Promise.reject(new Error("no network in this test"));

Object.defineProperty(process, "stdin", {
  get() {
    process.stderr.write("standard input was touched\n");
    return process.exit(99);
  },
});
