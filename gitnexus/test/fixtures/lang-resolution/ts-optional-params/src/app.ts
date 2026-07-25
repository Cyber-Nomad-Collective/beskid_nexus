function greet(name: string, greeting: string = "Hello"): string {
	return `${greeting}, ${name}`;
}

function search(_query: string, _limit?: number): string[] {
	return [];
}

function _process() {
	greet("Alice");
	greet("Bob", "Hi");
	search("test");
	search("test", 10);
}
