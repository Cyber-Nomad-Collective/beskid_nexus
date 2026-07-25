function lookup(id: number): string;
function lookup(name: string): string;
function lookup(key: number | string): string {
	return String(key);
}

function _process() {
	lookup(42);
	lookup("alice");
}
