import { getRepos } from "./models/repo";
import { getUsers } from "./models/user";

function processUsers(): void {
	for (const user of getUsers()) {
		user.save();
	}
}

function processRepos(): void {
	for (const repo of getRepos()) {
		repo.save();
	}
}
