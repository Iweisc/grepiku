const SUPPRESSED_STDERR_MESSAGE = "stderr output suppressed for security";

function hasSuppressedStderr(params = {}) {
  if (typeof params.hadStderr === "boolean") {
    return params.hadStderr;
  }
  if (typeof params.stderr !== "string") {
    return false;
  }
  return params.stderr.trim().length > 0;
}

export function buildVerifierToolResult(params = {}) {
  const hadStderr = hasSuppressedStderr(params);
  const topErrors =
    hadStderr && (params.timedOut || (params.exitCode ?? 1) !== 0)
      ? [SUPPRESSED_STDERR_MESSAGE]
      : [];

  if (params.timedOut) {
    return {
      status: "timeout",
      summary: "Timed out",
      topErrors,
      logPath: null
    };
  }

  const exitCode = Number.isInteger(params.exitCode) ? params.exitCode : 1;
  if (exitCode === 0) {
    return {
      status: "pass",
      summary: "Success",
      topErrors,
      logPath: null
    };
  }

  return {
    status: "fail",
    summary: `Exited with ${exitCode}`,
    topErrors,
    logPath: null
  };
}
