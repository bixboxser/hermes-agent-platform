export interface NormalizedError {
  message: string;
  type: string;
  stack?: string;
}

export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      message: error.message || "Unknown error",
      type: error.name || "Error",
      stack: error.stack ? error.stack.slice(0, 500).trim() : undefined,
    };
  }

  if (typeof error === "object" && error !== null) {
    const maybe = error as { message?: unknown; name?: unknown; stack?: unknown };
    return {
      message: typeof maybe.message === "string" && maybe.message.length > 0 ? maybe.message : "Unknown error",
      type: typeof maybe.name === "string" && maybe.name.length > 0 ? maybe.name : "Error",
      stack: typeof maybe.stack === "string" ? maybe.stack.slice(0, 500).trim() : undefined,
    };
  }

  return {
    message: typeof error === "string" && error.length > 0 ? error : "Unknown error",
    type: "Error",
  };
}
