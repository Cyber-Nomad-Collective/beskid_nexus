export {};

// Local definition shadows the imported one
function save(x: string): void {
	console.log("local save:", x);
}

function _run(): void {
	save("test");
}
