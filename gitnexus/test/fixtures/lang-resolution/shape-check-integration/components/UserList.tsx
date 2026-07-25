export function UserList() {
	const res = fetch("/api/users").then((r) => r.json());
	const _items = res.data;
	const _err = res.error;
	return null;
}
