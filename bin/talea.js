#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  // Anything that reaches here is a bug or an unhandled edge. Print the message
  // a human can act on; keep the stack behind a flag so the normal failure is
  // one readable line rather than a wall of frames.
  console.error(`\n  ${err.message}\n`);
  if (process.env.TALEA_DEBUG) console.error(err.stack);
  process.exit(1);
});
