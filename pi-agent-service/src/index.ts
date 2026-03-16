#!/usr/bin/env node
/**
 * pi-agent-service CLI entry point.
 *
 * Usage: pi-agent-service --project /path/to/project
 */

function main() {
  const args = process.argv.slice(2);
  let projectRoot: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      projectRoot = args[i + 1];
      i++;
    }
  }

  if (!projectRoot) {
    console.error("Usage: pi-agent-service --project <path>");
    process.exit(1);
  }

  console.log(`pi-agent-service: project=${projectRoot}`);
  console.log("Not yet implemented — see implementation issues in epic nptk1ujw");
  process.exit(0);
}

main();
