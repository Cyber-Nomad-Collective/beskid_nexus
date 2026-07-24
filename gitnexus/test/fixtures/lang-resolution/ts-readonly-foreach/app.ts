import type { Repo } from "./models/repo";
import type { User } from "./models/user";

function processUsers(users: readonly User[]) {
	for (const user of users) {
		user.save();
	}
}

function processRepos(repos: readonly Repo[]) {
	for (const repo of repos) {
		repo.save();
	}
}
