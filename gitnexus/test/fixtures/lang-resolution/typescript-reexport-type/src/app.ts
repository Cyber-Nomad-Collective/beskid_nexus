export {};

function _main(): void {
	const user = new User();
	user.save();

	const repo = new Repo();
	repo.persist();
}
