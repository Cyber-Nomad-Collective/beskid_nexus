// TypeScript middleware — should NOT be resolved by Python imports
export function handleRequest(_req: Request): Response {
	return new Response("ok");
}
