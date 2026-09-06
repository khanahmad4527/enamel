const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  teal: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/**
 * Non-fatal failures were printed and then forgotten: the run still
 * exited 0 and still printed its success banner, so a half-provisioned
 * instance looked identical to a good one. Counting them is the whole
 * fix — `index.ts` reads this before deciding what to print.
 */
let failures = 0;

export const log = {
  step: (s: string) => console.log(`\n${c.teal("▸")} ${c.bold(s)}`),
  made: (s: string) => console.log(`  ${c.green("+")} ${s}`),
  skip: (s: string) => console.log(`  ${c.dim("·")} ${c.dim(`${s} (exists)`)}`),
  warn: (s: string) => console.log(`  ${c.yellow("!")} ${s}`),
  fail: (s: string) => {
    failures++;
    console.log(`  ${c.red("✗")} ${s}`);
  },
  failures: () => failures,
  info: (s: string) => console.log(`  ${c.dim(s)}`),
  done: (s: string) => console.log(`\n${c.green("✓")} ${c.bold(s)}\n`),
};
