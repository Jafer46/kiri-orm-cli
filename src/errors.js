/** An error whose message is meant for the user as-is (no stack trace), with the exit code to use. */
export class CliError extends Error {
  /** @param {string} message @param {number} [exitCode] */
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/** The command line itself was wrong (unknown command/flag, bad value). Exit code 2, like most Unix tools. */
export class UsageError extends CliError {
  constructor(message) {
    super(message, 2);
    this.name = "UsageError";
  }
}
