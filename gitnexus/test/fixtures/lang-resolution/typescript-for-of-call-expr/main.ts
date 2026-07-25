import { getRepos } from "./models/repo";
import { getUsers } from "./models/user";

function _processUsers(): void {
	for (const user of getUsers()) {
		user.save();
	}
}

function _processRepos(): void {
	for (const repo of getRepos()) {
		repo.save();
	}
}
