import type { Repo } from "./models/repo";
import type { User } from "./models/user";

function _processUsers(users: readonly User[]) {
	for (const user of users) {
		user.save();
	}
}

function _processRepos(repos: readonly Repo[]) {
	for (const repo of repos) {
		repo.save();
	}
}
