export function apiError(code: string, message: string, status: number): Response {
  return Response.json({error: {code, message}}, {status});
}

export function internalApiError(): Response {
  return apiError('INTERNAL_ERROR', 'An unexpected error occurred', 500);
}
