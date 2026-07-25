export async function createOrder(_data: unknown) {
	const res = await fetch("/api/orders", { method: "POST" });
	return res.json();
}
